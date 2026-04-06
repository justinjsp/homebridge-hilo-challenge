"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HiloChallengeSensorAccessory = void 0;
class HiloChallengeSensorAccessory {
    constructor(hap, log, accessory, phase) {
        this.hap = hap;
        this.log = log;
        this.accessory = accessory;
        this.phase = phase;
        this.active = false;
        const info = this.accessory.getService(this.hap.Service.AccessoryInformation);
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
    getContactState() {
        // NO_CONTACT (1) = phase is active → triggers HomeKit automations
        // CONTACT_DETECTED (0) = phase is not active → normal/idle
        return this.active
            ? this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
            : this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED;
    }
    updatePhase(currentPhase) {
        const wasActive = this.active;
        if (this.phase === 'reduction') {
            this.active = currentPhase === 'reduction';
        }
        else {
            // preheat sensor is active during preheat only
            this.active = currentPhase === 'preheat';
        }
        if (this.active !== wasActive) {
            this.log.info(`[${this.accessory.displayName}] ${this.active ? 'ACTIVE (challenge phase started)' : 'INACTIVE (challenge phase ended)'}`);
            this.service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.getContactState());
        }
    }
}
exports.HiloChallengeSensorAccessory = HiloChallengeSensorAccessory;
//# sourceMappingURL=challengeAccessory.js.map