import { PlatformAccessory, Logger, HAP } from 'homebridge';
import { ChallengePhaseName } from './hiloApi';
export type SensorPhase = 'preheat' | 'reduction';
export declare class HiloChallengeSensorAccessory {
    private readonly hap;
    private readonly log;
    private readonly accessory;
    private readonly phase;
    private readonly service;
    private active;
    constructor(hap: HAP, log: Logger, accessory: PlatformAccessory, phase: SensorPhase);
    private getContactState;
    updatePhase(currentPhase: ChallengePhaseName): void;
}
//# sourceMappingURL=challengeAccessory.d.ts.map