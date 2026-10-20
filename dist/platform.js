"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HiloChallengePlatform = exports.SCHEDULE_REFRESH_MS = exports.PLUGIN_NAME = exports.PLATFORM_NAME = void 0;
const hiloApi_1 = require("./hiloApi");
const hiloAuth_1 = require("./hiloAuth");
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
// How often the challenge schedule is fetched from Hilo. Between fetches the phase is
// worked out from the cached schedule at every poll, so transitions still land on time.
exports.SCHEDULE_REFRESH_MS = 5 * 60000;
class HiloChallengePlatform {
    constructor(log, config, homebridgeApi, 
    // For tests: a fake Hilo and a fixed clock. Homebridge passes neither.
    deps = {}) {
        this.log = log;
        this.config = config;
        this.homebridgeApi = homebridgeApi;
        this.deps = deps;
        this.cachedAccessories = [];
        this.sensorAccessories = new Map();
        this.locationId = null;
        this.timer = null;
        // The last challenge schedule fetched from Hilo, and when (epoch ms; 0 = never)
        this.schedule = null;
        this.scheduleFetchedAt = 0;
        // Off-season, the schedule is fetched once at startup only, to confirm the login works
        this.checkedOffSeason = false;
        // Published to the shared state file for other plugins
        this.tracked = stateFile_1.NO_PHASE;
        this.lastError = null;
        this.loggedError = null;
        this.stateWriteFailing = false;
        this.pollInterval = config['pollInterval'] ?? 60;
        const storagePath = homebridgeApi.user.storagePath();
        this.statePath = (0, stateFile_1.stateFilePath)(storagePath);
        this.hiloApi = new hiloApi_1.HiloApi((0, hiloAuth_1.authFilePath)(storagePath), log, deps.request);
        if (typeof config['refreshToken'] === 'string' && config['refreshToken'].trim() !== '') {
            this.log.warn('"refreshToken" in this plugin\'s config is no longer used and can be removed. The plugin now has its ' +
                'own Hilo login and never uses homebridge-hilo\'s token. Log in from this plugin\'s settings page.');
        }
        this.homebridgeApi.on('didFinishLaunching', () => {
            this.init().catch((err) => this.log.error(`Startup failed: ${err}`));
        });
        this.homebridgeApi.on('shutdown', () => {
            if (this.timer)
                clearInterval(this.timer);
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
        this.tracked = (0, stateFile_1.restorePhase)((0, stateFile_1.readStateFile)(this.statePath), this.now(), season, maxAgeMs);
        this.writeState(season);
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
        for (const sensor of this.sensorAccessories.values()) {
            sensor.updatePhase(this.tracked.phase);
        }
        // Initial poll then recurring. Polling runs even while not logged in, so a login
        // from the settings page takes effect without a restart.
        await this.poll();
        this.timer = setInterval(() => { this.poll().catch((err) => this.log.error(`Poll failed: ${err}`)); }, this.pollInterval * 1000);
    }
    /**
     * Returns true during Hilo challenge season: December 1 – March 31.
     */
    isChallengeSeason() {
        const month = this.now().getMonth() + 1; // 1 = Jan … 12 = Dec
        return month === 12 || month <= 3;
    }
    async poll() {
        const season = this.isChallengeSeason();
        const now = this.now();
        // Off-season (April–November) no challenges are possible: one schedule fetch at
        // startup to confirm the login and endpoints work, then no API calls at all.
        if (season || !this.checkedOffSeason) {
            this.checkedOffSeason = true;
            if (this.schedule === null || now.getTime() - this.scheduleFetchedAt >= exports.SCHEDULE_REFRESH_MS) {
                await this.refreshSchedule(season, now);
            }
        }
        // Work the phase out from the schedule. With no schedule yet (every fetch so far
        // failed), keep the last known phase.
        let phase = this.tracked.phase;
        if (!season) {
            phase = 'none';
        }
        else if (this.schedule !== null) {
            phase = (0, hiloApi_1.phaseAt)(this.schedule, now);
        }
        if (phase !== this.tracked.phase) {
            this.log.info(`Hilo challenge phase: ${phase}`);
        }
        for (const sensor of this.sensorAccessories.values()) {
            sensor.updatePhase(phase);
        }
        this.tracked = (0, stateFile_1.advancePhase)(this.tracked, phase, now);
        this.writeState(season);
    }
    async refreshSchedule(season, now) {
        try {
            if (!this.locationId) {
                const location = await this.hiloApi.getLocation(this.config['locationId']);
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
        }
        catch (err) {
            // Keep the cached schedule; readers see the error and a fresh updatedAt.
            this.setError((0, hiloApi_1.errorMessage)(err), err instanceof hiloApi_1.NotLoggedInError && !season);
        }
    }
    /** Records the poll error for the state file, logging each new message once. */
    setError(message, quiet = false) {
        this.lastError = message;
        if (message === null) {
            if (this.loggedError !== null)
                this.log.info('Hilo challenge polling recovered');
        }
        else if (message !== this.loggedError) {
            if (quiet) {
                this.log.warn(message);
            }
            else {
                this.log.error(`Failed to poll Hilo challenges: ${message}`);
            }
        }
        else {
            this.log.debug(`Failed to poll Hilo challenges: ${message}`);
        }
        this.loggedError = message;
    }
    now() {
        return this.deps.now ? this.deps.now() : new Date();
    }
    /**
     * Writes the shared state file for other plugins. Never throws; a failure is logged
     * as a warning once, then at debug level until a write succeeds again.
     */
    writeState(season) {
        const state = (0, stateFile_1.buildState)({
            now: this.now(),
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
function describeSchedule(events) {
    if (events.length === 0)
        return 'no upcoming challenges';
    return events.map((e) => {
        const first = Math.min(...Object.values(e.phases).map((w) => w.start));
        return `event ${e.id} from ${new Date(first).toISOString()}`;
    }).join(', ');
}
//# sourceMappingURL=platform.js.map