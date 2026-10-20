import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';
import { ChallengeEvent, ChallengePhaseName, HiloApi, NotLoggedInError, errorMessage, phaseAt } from './hiloApi';
import { HttpsRequester, authFilePath } from './hiloAuth';
import { HiloChallengeSensorAccessory, SensorPhase } from './challengeAccessory';
import {
  NO_PHASE, TrackedPhase, advancePhase, buildState, readStateFile, restorePhase, stateFilePath, writeStateFile,
} from './stateFile';

export const PLATFORM_NAME = 'HiloChallenge';
export const PLUGIN_NAME = 'homebridge-hilo-challenge';

const SENSORS: Array<{ phase: SensorPhase; name: string }> = [
  { phase: 'preheat', name: 'Hilo Preheat' },
  { phase: 'reduction', name: 'Hilo Reduction' },
  { phase: 'recovery', name: 'Hilo Recovery' },
];

// A phase from a state file this recent is carried over at startup (see restorePhase).
const MIN_RESTORE_AGE_MS = 10 * 60_000;

// How often the challenge schedule is fetched from Hilo. Between fetches the phase is
// worked out from the cached schedule at every poll, so transitions still land on time.
export const SCHEDULE_REFRESH_MS = 5 * 60_000;

export class HiloChallengePlatform implements DynamicPlatformPlugin {
  private readonly hiloApi: HiloApi;
  private readonly cachedAccessories: PlatformAccessory[] = [];
  private readonly sensorAccessories = new Map<SensorPhase, HiloChallengeSensorAccessory>();
  private readonly pollInterval: number;
  private readonly statePath: string;
  private locationId: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  // The last challenge schedule fetched from Hilo, and when (epoch ms; 0 = never)
  private schedule: ChallengeEvent[] | null = null;
  private scheduleFetchedAt = 0;
  // Off-season, the schedule is fetched once at startup only, to confirm the login works
  private checkedOffSeason = false;

  // Published to the shared state file for other plugins
  private tracked: TrackedPhase = NO_PHASE;
  private lastError: string | null = null;
  private loggedError: string | null = null;
  private stateWriteFailing = false;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly homebridgeApi: API,
    // For tests: a fake Hilo and a fixed clock. Homebridge passes neither.
    private readonly deps: { request?: HttpsRequester; now?: () => Date } = {},
  ) {
    this.pollInterval = (config['pollInterval'] as number | undefined) ?? 60;
    const storagePath = homebridgeApi.user.storagePath();
    this.statePath = stateFilePath(storagePath);
    this.hiloApi = new HiloApi(authFilePath(storagePath), log, deps.request);

    if (typeof config['refreshToken'] === 'string' && config['refreshToken'].trim() !== '') {
      this.log.warn(
        '"refreshToken" in this plugin\'s config is no longer used and can be removed. The plugin now has its ' +
        'own Hilo login and never uses homebridge-hilo\'s token. Log in from this plugin\'s settings page.',
      );
    }

    this.homebridgeApi.on('didFinishLaunching', () => {
      this.init().catch((err) => this.log.error(`Startup failed: ${err}`));
    });
    this.homebridgeApi.on('shutdown', () => {
      if (this.timer) clearInterval(this.timer);
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug(`Restoring cached accessory: ${accessory.displayName}`);
    this.cachedAccessories.push(accessory);
  }

  private async init(): Promise<void> {
    // Publish state straight away, carrying over a phase from just before a restart
    const season = this.isChallengeSeason();
    const maxAgeMs = Math.max(MIN_RESTORE_AGE_MS, 3 * this.pollInterval * 1000);
    this.tracked = restorePhase(readStateFile(this.statePath), this.now(), season, maxAgeMs);
    this.writeState(season);

    // Register or restore accessories
    for (const { phase, name } of SENSORS) {
      const uuid = this.homebridgeApi.hap.uuid.generate(`hilo-challenge-${phase}`);
      const existing = this.cachedAccessories.find((a) => a.UUID === uuid);

      if (existing) {
        this.log.info(`Restoring sensor: ${existing.displayName}`);
        this.sensorAccessories.set(phase, new HiloChallengeSensorAccessory(
          this.homebridgeApi.hap, this.log, existing, phase,
        ));
      } else {
        this.log.info(`Adding sensor: ${name}`);
        const accessory = new this.homebridgeApi.platformAccessory(name, uuid);
        this.sensorAccessories.set(phase, new HiloChallengeSensorAccessory(
          this.homebridgeApi.hap, this.log, accessory, phase,
        ));
        this.homebridgeApi.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
    for (const sensor of this.sensorAccessories.values()) {
      sensor.updatePhase(this.tracked.phase);
    }

    // Initial poll then recurring. Polling runs even while not logged in, so a login
    // from the settings page takes effect without a restart.
    await this.poll();
    this.timer = setInterval(() => { this.poll().catch((err) => this.log.error(`Poll failed: ${err}`)); },
      this.pollInterval * 1000);
  }

  /**
   * Returns true during Hilo challenge season: December 1 – March 31.
   */
  private isChallengeSeason(): boolean {
    const month = this.now().getMonth() + 1; // 1 = Jan … 12 = Dec
    return month === 12 || month <= 3;
  }

  private async poll(): Promise<void> {
    const season = this.isChallengeSeason();
    const now = this.now();

    // Off-season (April–November) no challenges are possible: one schedule fetch at
    // startup to confirm the login and endpoints work, then no API calls at all.
    if (season || !this.checkedOffSeason) {
      this.checkedOffSeason = true;
      if (this.schedule === null || now.getTime() - this.scheduleFetchedAt >= SCHEDULE_REFRESH_MS) {
        await this.refreshSchedule(season, now);
      }
    }

    // Work the phase out from the schedule. With no schedule yet (every fetch so far
    // failed), keep the last known phase.
    let phase: ChallengePhaseName = this.tracked.phase;
    if (!season) {
      phase = 'none';
    } else if (this.schedule !== null) {
      phase = phaseAt(this.schedule, now);
    }

    if (phase !== this.tracked.phase) {
      this.log.info(`Hilo challenge phase: ${phase}`);
    }
    for (const sensor of this.sensorAccessories.values()) {
      sensor.updatePhase(phase);
    }
    this.tracked = advancePhase(this.tracked, phase, now);
    this.writeState(season);
  }

  private async refreshSchedule(season: boolean, now: Date): Promise<void> {
    try {
      if (!this.locationId) {
        const location = await this.hiloApi.getLocation(this.config['locationId'] as string | undefined);
        this.locationId = location.id;
        this.log.info(`Using Hilo location ${location.id}${location.hiloId ? ` (${location.hiloId})` : ''}`);
      }
      const events = await this.hiloApi.getChallengeEvents(this.locationId);
      if (this.schedule === null || events.length !== this.schedule.length) {
        this.log.info(`Hilo challenge schedule: ${describeSchedule(events)}`);
      }
      this.schedule = events;
      this.scheduleFetchedAt = now.getTime();
      this.setError(null);
    } catch (err) {
      // Keep the cached schedule; readers see the error and a fresh updatedAt.
      this.setError(errorMessage(err), err instanceof NotLoggedInError && !season);
    }
  }

  /** Records the poll error for the state file, logging each new message once. */
  private setError(message: string | null, quiet = false): void {
    this.lastError = message;
    if (message === null) {
      if (this.loggedError !== null) this.log.info('Hilo challenge polling recovered');
    } else if (message !== this.loggedError) {
      if (quiet) {
        this.log.warn(message);
      } else {
        this.log.error(`Failed to poll Hilo challenges: ${message}`);
      }
    } else {
      this.log.debug(`Failed to poll Hilo challenges: ${message}`);
    }
    this.loggedError = message;
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /**
   * Writes the shared state file for other plugins. Never throws; a failure is logged
   * as a warning once, then at debug level until a write succeeds again.
   */
  private writeState(season: boolean): void {
    const state = buildState({
      now: this.now(),
      season,
      tracked: this.tracked,
      pollIntervalSeconds: this.pollInterval,
      error: this.lastError,
    });
    const failure = writeStateFile(this.statePath, state);
    if (failure) {
      const message = `Could not write ${this.statePath}: ${failure}`;
      if (this.stateWriteFailing) {
        this.log.debug(message);
      } else {
        this.log.warn(message);
      }
    }
    this.stateWriteFailing = failure !== null;
  }
}

function describeSchedule(events: ChallengeEvent[]): string {
  if (events.length === 0) return 'no upcoming challenges';
  return events.map((e) => {
    const first = Math.min(...Object.values(e.phases).map((w) => w!.start));
    return `event ${e.id} from ${new Date(first).toISOString()}`;
  }).join(', ');
}
