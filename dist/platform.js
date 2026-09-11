"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HiloChallengePlatform = exports.PLUGIN_NAME = exports.PLATFORM_NAME = void 0;
const hiloApi_1 = require("./hiloApi");
const challengeAccessory_1 = require("./challengeAccessory");
const stateFile_1 = require("./stateFile");
exports.PLATFORM_NAME = 'HiloChallenge';
exports.PLUGIN_NAME = 'homebridge-hilo-challenge';
const SENSORS = [
    { phase: 'preheat', name: 'Hilo Preheat' },
    { phase: 'reduction', name: 'Hilo Reduction' },
    { phase: 'recovery', name: 'Hilo Recovery' },
];
// A phase from a state file this recent is carried over at startup (see restorePhase).
const MIN_RESTORE_AGE_MS = 10 * 60000;
class HiloChallengePlatform {
    constructor(log, config, homebridgeApi) {
        this.log = log;
        this.config = config;
        this.homebridgeApi = homebridgeApi;
        this.cachedAccessories = [];
        this.sensorAccessories = new Map();
        this.locationId = null;
        // Published to the shared state file for other plugins
        this.tracked = stateFile_1.NO_PHASE;
        this.lastError = null;
        this.stateWriteFailing = false;
        this.pollInterval = config['pollInterval'] ?? 60;
        this.statePath = (0, stateFile_1.stateFilePath)(homebridgeApi.user.storagePath());
        this.hiloApi = new hiloApi_1.HiloApi(config['refreshToken'], log, homebridgeApi.user.configPath());
        // Either our own refreshToken or homebridge-hilo's (read from config.json) will do.
        const tokens = this.hiloApi.refreshTokenCandidates();
        if (tokens.length === 0) {
            this.log.error('Missing Hilo refresh token: "refreshToken" is not set and no homebridge-hilo ("Hilo") platform ' +
                'with a refreshToken was found in config.json. The Hilo Challenge platform will not start until ' +
                'one is available. Configure homebridge-hilo, or copy its refreshToken into this plugin\'s config.');
            return;
        }
        this.log.info(`Using the Hilo refresh token from the ${tokens[0].source}`);
        this.homebridgeApi.on('didFinishLaunching', () => {
            this.init().catch((err) => this.log.error(`Startup failed: ${err}`));
        });
    }
    configureAccessory(accessory) {
        this.log.debug(`Restoring cached accessory: ${accessory.displayName}`);
        this.cachedAccessories.push(accessory);
    }
    async init() {
        // Publish state straight away, carrying over a phase from just before a restart
        const season = this.isChallengeSeason();
        const maxAgeMs = Math.max(MIN_RESTORE_AGE_MS, 3 * this.pollInterval * 1000);
        this.tracked = (0, stateFile_1.restorePhase)((0, stateFile_1.readStateFile)(this.statePath), new Date(), season, maxAgeMs);
        this.writeState(season);
        // Discover location ID
        try {
            const configured = this.config['locationId'];
            this.locationId = configured ?? await this.hiloApi.getLocationId();
            this.log.info(`Using Hilo location ID: ${this.locationId}`);
        }
        catch (err) {
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
    /**
     * Returns true during Hilo challenge season: December 1 – March 31.
     */
    isChallengeSeason() {
        const month = new Date().getMonth() + 1; // 1 = Jan … 12 = Dec
        return month === 12 || month <= 3;
    }
    async poll() {
        if (!this.locationId)
            return;
        if (!this.isChallengeSeason()) {
            // Off-season (April–November): no challenges possible, skip API call.
            for (const sensor of this.sensorAccessories.values()) {
                sensor.updatePhase('none');
            }
            this.tracked = stateFile_1.NO_PHASE;
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
            this.tracked = (0, stateFile_1.advancePhase)(this.tracked, phase, new Date());
            this.lastError = null;
        }
        catch (err) {
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
    writeState(season) {
        const state = (0, stateFile_1.buildState)({
            now: new Date(),
            season,
            tracked: this.tracked,
            pollIntervalSeconds: this.pollInterval,
            error: this.lastError,
        });
        const failure = (0, stateFile_1.writeStateFile)(this.statePath, state);
        if (failure) {
            const message = `Could not write ${this.statePath}: ${failure}`;
            if (this.stateWriteFailing) {
                this.log.debug(message);
            }
            else {
                this.log.warn(message);
            }
        }
        this.stateWriteFailing = failure !== null;
    }
}
exports.HiloChallengePlatform = HiloChallengePlatform;
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
//# sourceMappingURL=platform.js.map