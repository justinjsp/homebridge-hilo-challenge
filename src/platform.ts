import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';
import { HiloApi } from './hiloApi';
import { HiloChallengeSensorAccessory, SensorPhase } from './challengeAccessory';

export const PLATFORM_NAME = 'HiloChallenge';
export const PLUGIN_NAME = 'homebridge-hilo-challenge';

const SENSORS: Array<{ phase: SensorPhase; name: string }> = [
  { phase: 'preheat', name: 'Hilo Preheat' },
  { phase: 'reduction', name: 'Hilo Reduction' },
];

export class HiloChallengePlatform implements DynamicPlatformPlugin {
  private readonly hiloApi: HiloApi;
  private readonly cachedAccessories: PlatformAccessory[] = [];
  private readonly sensorAccessories = new Map<SensorPhase, HiloChallengeSensorAccessory>();
  private readonly pollInterval: number;
  private locationId: string | null = null;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly homebridgeApi: API,
  ) {
    this.pollInterval = (config['pollInterval'] as number | undefined) ?? 60;
    this.hiloApi = new HiloApi(config['refreshToken'] as string, log);

    this.homebridgeApi.on('didFinishLaunching', () => {
      this.init();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug(`Restoring cached accessory: ${accessory.displayName}`);
    this.cachedAccessories.push(accessory);
  }

  private async init(): Promise<void> {
    // Discover location ID
    try {
      const configured = this.config['locationId'] as string | undefined;
      this.locationId = configured ?? await this.hiloApi.getLocationId();
      this.log.info(`Using Hilo location ID: ${this.locationId}`);
    } catch (err) {
      this.log.error(`Failed to get Hilo location ID: ${err}`);
      this.log.error('Set "locationId" manually in config if auto-discovery fails.');
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
      return;
    }

    try {
      const phase = await this.hiloApi.getChallengePhase(this.locationId);
      this.log.info(`Current Hilo challenge phase: ${phase}`);
      for (const sensor of this.sensorAccessories.values()) {
        sensor.updatePhase(phase);
      }
    } catch (err) {
      this.log.error(`Failed to poll Hilo challenge: ${err}`);
    }
  }
}
