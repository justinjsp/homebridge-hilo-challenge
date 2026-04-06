import { Service, PlatformAccessory, CharacteristicValue, Logger, HAP } from 'homebridge';
import { ChallengePhaseName } from './hiloApi';

// Which phase this sensor fires for
export type SensorPhase = 'preheat' | 'reduction';

export class HiloChallengeSensorAccessory {
  private readonly service: Service;
  private active = false;

  constructor(
    private readonly hap: HAP,
    private readonly log: Logger,
    private readonly accessory: PlatformAccessory,
    private readonly phase: SensorPhase,
  ) {
    const info = this.accessory.getService(this.hap.Service.AccessoryInformation)!;
    info
      .setCharacteristic(this.hap.Characteristic.Manufacturer, 'Hilo / Hydro-Québec')
      .setCharacteristic(this.hap.Characteristic.Model, 'Challenge Sensor')
      .setCharacteristic(this.hap.Characteristic.SerialNumber, `hilo-challenge-${phase}`);

    this.service =
      this.accessory.getService(this.hap.Service.ContactSensor) ||
      this.accessory.addService(this.hap.Service.ContactSensor);

    this.service.setCharacteristic(this.hap.Characteristic.Name, accessory.displayName);

    this.service
      .getCharacteristic(this.hap.Characteristic.ContactSensorState)
      .onGet(this.getContactState.bind(this));
  }

  private getContactState(): CharacteristicValue {
    // NO_CONTACT (1) = phase is active → triggers HomeKit automations
    // CONTACT_DETECTED (0) = phase is not active → normal/idle
    return this.active
      ? this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      : this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED;
  }

  updatePhase(currentPhase: ChallengePhaseName): void {
    const wasActive = this.active;

    if (this.phase === 'reduction') {
      this.active = currentPhase === 'reduction';
    } else {
      // preheat sensor is active during preheat only
      this.active = currentPhase === 'preheat';
    }

    if (this.active !== wasActive) {
      this.log.info(
        `[${this.accessory.displayName}] ${this.active ? 'ACTIVE (challenge phase started)' : 'INACTIVE (challenge phase ended)'}`,
      );
      this.service.updateCharacteristic(
        this.hap.Characteristic.ContactSensorState,
        this.getContactState(),
      );
    }
  }
}
