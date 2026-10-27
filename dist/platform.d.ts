import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';
import { HttpsRequester } from './hiloAuth';
import { HubConnector } from './challengeHub';
export declare const PLATFORM_NAME = "HiloChallenge";
export declare const PLUGIN_NAME = "homebridge-hilo-challenge";
export declare class HiloChallengePlatform implements DynamicPlatformPlugin {
    readonly log: Logger;
    readonly config: PlatformConfig;
    readonly homebridgeApi: API;
    private readonly deps;
    private readonly hiloApi;
    private readonly cachedAccessories;
    private readonly sensorAccessories;
    private readonly pollInterval;
    private readonly statePath;
    private location;
    private timer;
    private hub;
    private loggedSchedule;
    private checkedOffSeason;
    private offSeasonPolls;
    private tracked;
    private lastError;
    private loggedError;
    private stateWriteFailing;
    constructor(log: Logger, config: PlatformConfig, homebridgeApi: API, deps?: {
        request?: HttpsRequester;
        now?: () => Date;
        connector?: HubConnector;
    });
    configureAccessory(accessory: PlatformAccessory): void;
    private init;
    /**
     * Returns true during Hilo challenge season: December 1 – March 31.
     */
    private isChallengeSeason;
    private poll;
    /** Finds the location, then keeps the hub connected and reports its state. */
    private followHub;
    /** Records the poll error for the state file, logging each new message once. */
    private setError;
    private now;
    /**
     * Writes the shared state file for other plugins. Never throws; a failure is logged
     * as a warning once, then at debug level until a write succeeds again.
     */
    private writeState;
}
//# sourceMappingURL=platform.d.ts.map