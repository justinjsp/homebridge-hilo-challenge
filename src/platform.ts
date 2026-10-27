import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';
import { ChallengeEvent, ChallengePhaseName, HiloApi, HiloLocation, NotLoggedInError, errorMessage, phaseAt } from './hiloApi';
import { HttpsRequester, authFilePath } from './hiloAuth';
import { ChallengeHub, HubConnector } from './challengeHub';
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

export class HiloChallengePlatform implements DynamicPlatformPlugin {
  private readonly hiloApi: HiloApi;
  private readonly cachedAccessories: PlatformAccessory[] = [];
  private readonly sensorAccessories = new Map<SensorPhase, HiloChallengeSensorAccessory>();
  private readonly pollInterval: number;
  private readonly statePath: string;
  private location: HiloLocation | null = null;
  private timer: NodeJS.Timeout | null = null;

  // Hilo pushes the challenge schedule over its ChallengeHub; between messages the phase
  // is worked out from the last schedule at every poll, so transitions land on time.
  private hub: ChallengeHub | null = null;
  private loggedSchedule: string | null = null;
  // Off-season, the hub is connected once at startup only, to confirm the login works
  private checkedOffSeason = false;
  private offSeasonPolls = 0;

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
    private readonly deps: { request?: HttpsRequester; now?: () => Date; connector?: HubConnector } = {},
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
      void this.hub?.stop();
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

    // Off-season (April–November) no challenges are possible: one hub connection at
    // startup to confirm the login and the hub work, then no connection at all.
    if (season || !this.checkedOffSeason) {
      await this.followHub();
      // Done once the list or an error has come back, or by the next poll regardless
      if (!season && (this.hub?.hasSchedule || this.lastError !== null || this.offSeasonPolls++ > 0)) {
        this.checkedOffSeason = true;
      }
    }
    if ((!season && this.checkedOffSeason) && this.hub?.isRunning) {
      await this.hub.stop();
      this.log.debug('Off-season: disconnected from Hilo\'s ChallengeHub');
    }

    // Work the phase out from the schedule. With no schedule yet (no event list has
    // arrived), keep the last known phase.
    let phase: ChallengePhaseName = this.tracked.phase;
    if (!season) {
      phase = 'none';
    } else if (this.hub?.hasSchedule) {
      phase = phaseAt(this.hub.schedule(), now);
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

  /** Finds the location, then keeps the hub connected and reports its state. */
  private async followHub(): Promise<void> {
    const season = this.isChallengeSeason();
    try {
      if (!this.location) {
        const location = await this.hiloApi.getLocation(this.config['locationId'] as string | undefined);
        this.location = location;
        this.log.info(`Using Hilo location ${location.id}${location.hiloId ? ` (${location.hiloId})` : ''}` +
          `${location.ratePlan ? `, rate ${location.ratePlan}` : ''}`);
      }
      if (!this.hub) {
        this.hub = new ChallengeHub(
          { hiloId: this.location.hiloId, ratePlan: this.location.ratePlan },
          () => this.hiloApi.getAccessToken(), this.log, () => this.now(), this.deps.connector,
        );
      }
      if (this.hub.isRunning) {
        await this.hub.tick();
      } else {
        await this.hub.start();
      }
    } catch (err) {
      this.setError(errorMessage(err), err instanceof NotLoggedInError && !season);
      return;
    }

    if (this.hub.hasSchedule) {
      const schedule = this.hub.schedule();
      const description = describeSchedule(schedule);
      if (description !== this.loggedSchedule) {
        this.log.info(`Hilo challenge schedule: ${description}`);
        this.loggedSchedule = description;
      }
    }
    this.setError(this.hub.lastError, this.hub.lastErrorIsLogin && !season);
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
