import { HubConnectionLike, HubConnector } from '../src/challengeHub';

// A fake Hilo ChallengeHub: answers SubscribeToEventList with the current list (as Hilo
// does), records what the plugin sends, and can refuse connections or drop them.
export class FakeConnection implements HubConnectionLike {
  readonly handlers = new Map<string, (...args: unknown[]) => void>();
  readonly sent: Array<{ method: string; arg: unknown }> = [];
  private closeCallback: ((error?: Error) => void) | null = null;
  started = false;
  stopped = false;

  constructor(private readonly server: FakeHubServer, private readonly accessToken: () => Promise<string>) {}

  on(target: string, handler: (...args: unknown[]) => void): void {
    this.handlers.set(target, handler);
  }

  onclose(callback: (error?: Error) => void): void {
    this.closeCallback = callback;
  }

  async start(): Promise<void> {
    this.server.tokensSeen.push(await this.accessToken());
    if (this.server.refuse) throw new Error('Failed to complete negotiation with the server: 503');
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.closeCallback?.();
  }

  async send(method: string, arg: unknown): Promise<void> {
    this.sent.push({ method, arg });
    if (method === 'SubscribeToEventList' && this.server.answerList) this.emit('EventListInitialValuesReceived', this.server.list);
  }

  /** Delivers a message from Hilo. */
  emit(target: string, arg: unknown): void {
    this.handlers.get(target)?.(arg);
  }

  /** The connection drops, as when Wi-Fi or Hilo goes away. */
  drop(error = new Error('WebSocket closed with status code: 1006')): void {
    this.closeCallback?.(error);
  }
}

export class FakeHubServer {
  list: unknown[] = [];
  refuse = false;
  answerList = true;
  readonly connections: FakeConnection[] = [];
  readonly tokensSeen: string[] = [];

  readonly connector: HubConnector = (accessToken) => {
    const connection = new FakeConnection(this, accessToken);
    this.connections.push(connection);
    return connection;
  };

  get last(): FakeConnection {
    return this.connections[this.connections.length - 1];
  }
}
