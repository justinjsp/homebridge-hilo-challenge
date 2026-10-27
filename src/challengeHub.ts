import * as signalR from '@microsoft/signalr';
import { ChallengeEvent, HiloLog, NotLoggedInError, errorMessage, normalizeEvent, wontRun } from './hiloApi';

// Hilo's challenge hub (SignalR). The REST events endpoint it replaced is gone; the
// phase windows of each challenge now come only from here, as in the Home Assistant
// Hilo integration (python-hilo). Hilo redirects the connection to its Azure SignalR
// service, which the official client follows on its own.
export const HUB_URL = 'https://api.hiloenergie.com/ChallengeHub';

// The event list is asked for again this often while connected, so a subscription the
// server silently dropped can't leave the schedule stale for long.
export const RESYNC_MS = 15 * 60_000;

// Waits between connection attempts: 30 s, doubling up to 10 minutes.
const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;

/** The part of a SignalR HubConnection this plugin uses (a fake one in tests). */
export interface HubConnectionLike {
  on(target: string, handler: (...args: unknown[]) => void): void;
  onclose(callback: (error?: Error) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(method: string, ...args: unknown[]): Promise<void>;
}

export type HubConnector = (accessToken: () => Promise<string>, log: HiloLog) => HubConnectionLike;

export const signalRConnector: HubConnector = (accessToken, log) => new signalR.HubConnectionBuilder()
  .withUrl(HUB_URL, { accessTokenFactory: accessToken })
  // The client's own messages go to the debug log; this class reports what matters.
  .configureLogging({ log: (level, message) => { if (level >= signalR.LogLevel.Warning) log.debug(`ChallengeHub: ${message}`); } })
  .build();

export interface HubLocation {
  hiloId: string;    // urn:hilo:crm:…
  ratePlan: string;  // "Flex" (Flex D) or "CH" (Winter Credits)
}

// Messages that carry one challenge's full record, phases included
const DETAIL_TARGETS = [
  'EventCHDetailsInitialValuesReceived', 'EventCHDetailsUpdatedValuesReceived',
  'EventFlexDetailsInitialValuesReceived', 'EventFlexDetailsUpdatedValuesReceived',
];

type RawEvent = Record<string, unknown>;

/**
 * Keeps the location's challenge schedule up to date from Hilo's ChallengeHub: connects,
 * subscribes to the event list and to the details of each upcoming challenge, and merges
 * what Hilo pushes. Reconnection is driven by tick(), which the platform calls at every poll.
 */
export class ChallengeHub {
  private connection: HubConnectionLike | null = null;
  private connecting: Promise<void> | null = null;
  private connected = false;
  private running = false;
  private everConnected = false;
  private failures = 0;
  private nextAttemptAt = 0;
  private lastListAt = 0;
  private listReceived = false;
  private readonly events = new Map<string, RawEvent>();
  private readonly detailsRequested = new Set<string>();

  /** Why the hub isn't delivering the schedule, or null when it is. */
  lastError: string | null = null;
  /** True when lastError is about the Hilo login rather than the connection. */
  lastErrorIsLogin = false;

  constructor(
    private readonly location: HubLocation,
    private readonly accessToken: () => Promise<string>,
    private readonly log: HiloLog,
    private readonly now: () => Date,
    private readonly connector: HubConnector = signalRConnector,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** True once Hilo has sent the event list (on any connection so far). */
  get hasSchedule(): boolean {
    return this.listReceived;
  }

  /** The challenges that will run or are running, with their phase windows. */
  schedule(): ChallengeEvent[] {
    const result: ChallengeEvent[] = [];
    for (const raw of this.events.values()) {
      const event = normalizeEvent(raw);
      if (event) result.push(event);
    }
    return result;
  }

  /** Starts following the hub; resolves after the first connection attempt. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.failures = 0;
    await this.connectOnce();
  }

  async stop(): Promise<void> {
    this.running = false;
    const connection = this.connection;
    this.connection = null;
    this.connected = false;
    if (connection) {
      try {
        await connection.stop();
      } catch {
        // already closed
      }
    }
  }

  /** Reconnects when it's time to, and asks for the list again when it's due. */
  async tick(): Promise<void> {
    if (!this.running) return;
    const now = this.now().getTime();
    if (!this.connection) {
      if (now >= this.nextAttemptAt) await this.connectOnce();
    } else if (this.connected && now - this.lastListAt >= RESYNC_MS) {
      await this.subscribeToList(this.connection);
    }
  }

  private connectOnce(): Promise<void> {
    this.connecting = this.connecting ?? this.connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    try {
      // Checked first, so a missing login is reported as such and costs no connection
      await this.accessToken();
    } catch (err) {
      this.failed(err);
      return;
    }

    if (!this.running) return; // stopped meanwhile
    const connection = this.connector(this.accessToken, this.log);
    this.connection = connection;
    this.detailsRequested.clear();

    connection.on('EventListInitialValuesReceived', (list) => this.onList(list, true));
    connection.on('EventListUpdatedValuesReceived', (list) => this.onList(list, false));
    connection.on('EventAdded', (event) => this.onEvents([event]));
    for (const target of DETAIL_TARGETS) {
      connection.on(target, (event) => this.onEvents([event], false));
    }
    connection.onclose((error) => {
      if (this.connection !== connection) return; // stopped on purpose, or replaced
      this.connection = null;
      this.connected = false;
      if (this.running) {
        this.failed(new Error(`Connection to Hilo's ChallengeHub lost${error ? `: ${error.message}` : ''}`));
      }
    });

    try {
      await connection.start();
    } catch (err) {
      if (this.connection === connection) {
        this.connection = null;
        this.failed(new Error(`Could not connect to Hilo's ChallengeHub: ${errorMessage(err)}`));
      }
      return;
    }
    if (this.connection !== connection) {
      await connection.stop().catch(() => undefined); // stopped while connecting
      return;
    }

    this.connected = true;
    this.failures = 0;
    this.lastError = null;
    this.lastErrorIsLogin = false;
    this.log.info(this.everConnected ? 'Reconnected to Hilo\'s ChallengeHub' : 'Connected to Hilo\'s ChallengeHub');
    this.everConnected = true;
    await this.subscribeToList(connection);
  }

  private failed(err: unknown): void {
    this.lastError = errorMessage(err);
    this.lastErrorIsLogin = err instanceof NotLoggedInError;
    const wait = Math.min(RETRY_FIRST_MS * 2 ** this.failures, RETRY_MAX_MS);
    this.failures++;
    this.nextAttemptAt = this.now().getTime() + wait;
  }

  private async subscribeToList(connection: HubConnectionLike): Promise<void> {
    this.lastListAt = this.now().getTime();
    await this.send(connection, 'SubscribeToEventList', { locationHiloId: this.location.hiloId });
  }

  private async send(connection: HubConnectionLike, method: string, arg: unknown): Promise<void> {
    try {
      await connection.send(method, arg);
    } catch (err) {
      // The close handler takes care of a dropped connection
      this.log.debug(`ChallengeHub: ${method} failed: ${errorMessage(err)}`);
    }
  }

  private onList(list: unknown, initial: boolean): void {
    if (!Array.isArray(list)) {
      this.log.debug(`ChallengeHub: unexpected event list: ${JSON.stringify(list)}`);
      return;
    }
    if (initial) {
      // A full list: anything not in it is no longer scheduled
      const known = new Map(this.events);
      this.events.clear();
      for (const item of list) {
        const id = eventId(item);
        if (id !== null) this.events.set(id, { ...known.get(id) });
      }
      this.listReceived = true;
    }
    this.onEvents(list);
  }

  /** Merges events into the schedule, and subscribes to the details of upcoming ones. */
  private onEvents(items: unknown[], requestDetails = true): void {
    for (const item of items) {
      const id = eventId(item);
      if (id === null) continue;
      const merged = { ...this.events.get(id), ...(item as RawEvent) };
      this.events.set(id, merged);
      if (requestDetails && !wontRun(merged) && !this.detailsRequested.has(id) && this.connection && this.connected) {
        this.detailsRequested.add(id);
        void this.send(this.connection, this.detailsMethod(), {
          locationHiloId: this.location.hiloId,
          eventId: (item as RawEvent).id,
        });
      }
    }
  }

  // Each rate has its own detail subscription; anything that isn't Flex D is Winter Credits
  private detailsMethod(): string {
    return /flex/i.test(this.location.ratePlan) ? 'SubscribeToEventFlex' : 'SubscribeToEventCH';
  }
}

function eventId(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const id = (item as RawEvent).id;
  return id === undefined || id === null ? null : String(id);
}
