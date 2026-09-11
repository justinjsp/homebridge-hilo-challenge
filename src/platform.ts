import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';
import { HiloApi } from './hiloApi';
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
  private locationId: string | null = null;

  // Published to the shared state file for other plugins
  private tracked: TrackedPhase = NO_PHASE;
  private lastError: string | null = null;
  private stateWriteFailing = false;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly homebridgeApi: API,
  ) {
    this.pollInterval = (config['pollInterval'] as number | undefined) ?? 60;
    this.statePath = stateFilePath(homebridgeApi.user.storagePath());
    this.hiloApi = new HiloApi(config['refreshToken'] as string | undefined, log, homebridgeApi.user.configPath());

    // Either our own refreshToken or homebridge-hilo's (read from config.json) will do.
    const tokens = this.hiloApi.refreshTokenCandidates();
    if (tokens.length === 0) {
      this.log.error(
        'Missing Hilo refresh token: "refreshToken" is not set and no homebridge-hilo ("Hilo") platform ' +
        'with a refreshToken was found in config.json. The Hilo Challenge platform will not start until ' +
        'one is available. Configure homebridge-hilo, or copy its refreshToken into this plugin\'s config.',
      );
      return;
    }
    this.log.info(`Using the Hilo refresh token from the ${tokens[0].source}`);

    this.homebridgeApi.on('didFinishLaunching', () => {
      this.init().catch((err) => this.log.error(`Startup failed: ${err}`));
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
    this.tracked = restorePhase(readStateFile(this.statePath), new Date(), season, maxAgeMs);
    this.writeState(season);

    // Discover location ID
    try {
      const configured = this.config['locationId'] as string | undefined;
      this.locationId = configured ?? await this.hiloApi.getLocationId();
      this.log.info(`Using Hilo location ID: ${this.locationId}`);
    } catch (err) {
      this.log.error(`Failed to get Hilo location ID: ${err}`);
      this.log.error('Set "locationId" manually in config if auto-discovery fails.');
      this.lastError = `Failed to get Hilo location ID: ${errorMessage(err)}`;
      this.writeState(season);
      return;
    }

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

    // Initial poll then recurring
    await this.poll();
    setInterval(() => this.poll(), this.pollInterval * 1000);
  }

  /**
   * Returns true during Hilo challenge season: December 1 – March 31.
   */
  private isChallengeSeason(): boolean {
    const month = new Date().getMonth() + 1; // 1 = Jan … 12 = Dec
    return month === 12 || month <= 3;
  }

  private async poll(): Promise<void> {
    if (!this.locationId) return;

    if (!this.isChallengeSeason()) {
      // Off-season (April–November): no challenges possible, skip API call.
      for (const sensor of this.sensorAccessories.values()) {
        sensor.updatePhase('none');
      }
      this.tracked = NO_PHASE;
      this.lastError = null;
      this.writeState(false);
      return;
    }

    try {
      const phase = await this.hiloApi.getChallengePhase(this.locationId);
      this.log.info(`Current Hilo challenge phase: ${phase}`);
      for (const sensor of this.sensorAccessories.values()) {
        sensor.updatePhase(phase);
      }
      this.tracked = advancePhase(this.tracked, phase, new Date());
      this.lastError = null;
    } catch (err) {
      // Keep the last known phase; readers see the error and a fresh updatedAt.
      this.log.error(`Failed to poll Hilo challenge: ${err}`);
      this.lastError = errorMessage(err);
    }
    this.writeState(true);
  }

  /**
   * Writes the shared state file for other plugins. Never throws; a failure is logged
   * as a warning once, then at debug level until a write succeeds again.
   */
  private writeState(season: boolean): void {
    const state = buildState({
      now: new Date(),
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
