"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HiloChallengePlatform = exports.PLUGIN_NAME = exports.PLATFORM_NAME = void 0;
const hiloApi_1 = require("./hiloApi");
const challengeAccessory_1 = require("./challengeAccessory");
exports.PLATFORM_NAME = 'HiloChallenge';
exports.PLUGIN_NAME = 'homebridge-hilo-challenge';
const SENSORS = [
    { phase: 'preheat', name: 'Hilo Preheat' },
    { phase: 'reduction', name: 'Hilo Reduction' },
];
class HiloChallengePlatform {
    constructor(log, config, homebridgeApi) {
        this.log = log;
        this.config = config;
        this.homebridgeApi = homebridgeApi;
        this.cachedAccessories = [];
        this.sensorAccessories = new Map();
        this.locationId = null;
        this.pollInterval = config['pollInterval'] ?? 60;
        this.hiloApi = new hiloApi_1.HiloApi(config['refreshToken'], log);
        this.homebridgeApi.on('didFinishLaunching', () => {
            this.init();
        });
    }
    configureAccessory(accessory) {
        this.log.debug(`Restoring cached accessory: ${accessory.displayName}`);
        this.cachedAccessories.push(accessory);
    }
    async init() {
        // Discover location ID
        try {
            const configured = this.config['locationId'];
            this.locationId = configured ?? await this.hiloApi.getLocationId();
            this.log.info(`Using Hilo location ID: ${this.locationId}`);
        }
        catch (err) {
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
                this.sensorAccessories.set(phase, new challengeAccessory_1.HiloChallengeSensorAccessory(this.homebridgeApi.hap, this.log, existing, phase));
            }
            else {
                this.log.info(`Adding sensor: ${name}`);
                const accessory = new this.homebridgeApi.platformAccessory(name, uuid);
                this.sensorAccessories.set(phase, new challengeAccessory_1.HiloChallengeSensorAccessory(this.homebridgeApi.hap, this.log, accessory, phase));
                this.homebridgeApi.registerPlatformAccessories(exports.PLUGIN_NAME, exports.PLATFORM_NAME, [accessory]);
            }
        }
        // Initial poll then recurring
        await this.poll();
        setInterval(() => this.poll(), this.pollInterval * 1000);
    }
    async poll() {
        if (!this.locationId)
            return;
        try {
            const phase = await this.hiloApi.getChallengePhase(this.locationId);
            this.log.debug(`Current Hilo challenge phase: ${phase}`);
            for (const sensor of this.sensorAccessories.values()) {
                sensor.updatePhase(phase);
            }
        }
        catch (err) {
            this.log.error(`Failed to poll Hilo challenge: ${err}`);
        }
    }
}
exports.HiloChallengePlatform = HiloChallengePlatform;
//# sourceMappingURL=platform.js.map