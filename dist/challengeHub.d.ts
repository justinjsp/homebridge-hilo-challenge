import { ChallengeEvent, HiloLog } from './hiloApi';
export declare const HUB_URL = "https://api.hiloenergie.com/ChallengeHub";
export declare const RESYNC_MS: number;
/** The part of a SignalR HubConnection this plugin uses (a fake one in tests). */
export interface HubConnectionLike {
    on(target: string, handler: (...args: unknown[]) => void): void;
    onclose(callback: (error?: Error) => void): void;
    start(): Promise<void>;
    stop(): Promise<void>;
    send(method: string, ...args: unknown[]): Promise<void>;
}
export type HubConnector = (accessToken: () => Promise<string>, log: HiloLog) => HubConnectionLike;
export declare const signalRConnector: HubConnector;
export interface HubLocation {
    hiloId: string;
    ratePlan: string;
}
/**
 * Keeps the location's challenge schedule up to date from Hilo's ChallengeHub: connects,
 * subscribes to the event list and to the details of each upcoming challenge, and merges
 * what Hilo pushes. Reconnection is driven by tick(), which the platform calls at every poll.
 */
export declare class ChallengeHub {
    private readonly location;
    private readonly accessToken;
    private readonly log;
    private readonly now;
    private readonly connector;
    private connection;
    private connecting;
    private connected;
    private running;
    private everConnected;
    private failures;
    private nextAttemptAt;
    private lastListAt;
    private listReceived;
    private readonly events;
    private readonly detailsRequested;
    /** Why the hub isn't delivering the schedule, or null when it is. */
    lastError: string | null;
    /** True when lastError is about the Hilo login rather than the connection. */
    lastErrorIsLogin: boolean;
    constructor(location: HubLocation, accessToken: () => Promise<string>, log: HiloLog, now: () => Date, connector?: HubConnector);
    get isRunning(): boolean;
    get isConnected(): boolean;
    /** True once Hilo has sent the event list (on any connection so far). */
    get hasSchedule(): boolean;
    /** The challenges that will run or are running, with their phase windows. */
    schedule(): ChallengeEvent[];
    /** Starts following the hub; resolves after the first connection attempt. */
    start(): Promise<void>;
    stop(): Promise<void>;
    /** Reconnects when it's time to, and asks for the list again when it's due. */
    tick(): Promise<void>;
    private connectOnce;
    private connect;
    private failed;
    private subscribeToList;
    private send;
    private onList;
    /** Merges events into the schedule, and subscribes to the details of upcoming ones. */
    private onEvents;
    private detailsMethod;
}
//# sourceMappingURL=challengeHub.d.ts.map