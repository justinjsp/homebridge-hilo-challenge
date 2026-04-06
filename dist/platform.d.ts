import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';
export declare const PLATFORM_NAME = "HiloChallenge";
export declare const PLUGIN_NAME = "homebridge-hilo-challenge";
export declare class HiloChallengePlatform implements DynamicPlatformPlugin {
    readonly log: Logger;
    readonly config: PlatformConfig;
    readonly homebridgeApi: API;
    private readonly hiloApi;
    private readonly cachedAccessories;
    private readonly sensorAccessories;
    private readonly pollInterval;
    private locationId;
    constructor(log: Logger, config: PlatformConfig, homebridgeApi: API);
    configureAccessory(accessory: PlatformAccessory): void;
    private init;
    private poll;
}
//# sourceMappingURL=platform.d.ts.map