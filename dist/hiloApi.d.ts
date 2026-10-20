import { HttpsRequester } from './hiloAuth';
export type { HttpsRequester } from './hiloAuth';
export type ChallengePhaseName = 'none' | 'preheat' | 'reduction' | 'recovery';
type ActivePhase = Exclude<ChallengePhaseName, 'none'>;
export type HiloLog = {
    info: (m: string) => void;
    debug: (m: string) => void;
    error: (m: string) => void;
};
export declare const NOT_LOGGED_IN = "Not logged in to Hilo. Open this plugin's settings in the Homebridge UI and choose \"Log in to Hilo\".";
export declare const LOGIN_EXPIRED = "The Hilo login has expired or was revoked. Open this plugin's settings in the Homebridge UI and log in to Hilo again.";
export declare class NotLoggedInError extends Error {
}
export interface HiloLocation {
    id: string;
    hiloId: string;
}
export interface PhaseWindow {
    start: number;
    end: number;
}
export interface ChallengeEvent {
    id: string;
    phases: Partial<Record<ActivePhase, PhaseWindow>>;
}
/**
 * Turns one event from Hilo's challenge events API into its phase windows. Phase keys
 * look like "preheatStartDateUTC" / "reductionEndDateUTC" (some API versions use a
 * "…Utc" suffix). Returns null for events that won't run or have no usable phases.
 */
export declare function normalizeEvent(raw: unknown): ChallengeEvent | null;
/** The challenge phase in effect at `now`, from the scheduled phase windows. */
export declare function phaseAt(events: ChallengeEvent[], now: Date): ChallengePhaseName;
/**
 * Picks the location to follow. `configured` may be the numeric location id or the
 * urn:hilo:crm:… id; without one, the account's first location is used.
 */
export declare function pickLocation(list: unknown[], configured?: string): HiloLocation;
export declare class HiloApi {
    private readonly authPath;
    private readonly log;
    private readonly request;
    private accessToken;
    private tokenExpiry;
    private loginInFlight;
    private rejectedToken;
    constructor(authPath: string, log: HiloLog, request?: HttpsRequester);
    isLoggedIn(): boolean;
    private ensureToken;
    private refreshAccessToken;
    private apiGet;
    getLocation(configured?: string): Promise<HiloLocation>;
    /**
     * The location's upcoming and current challenges, with their phase windows.
     * The events list may carry the phases inline; when an event doesn't, its detail
     * record (…/Events/{id}) is fetched for them.
     */
    getChallengeEvents(locationId: string): Promise<ChallengeEvent[]>;
}
export declare function errorMessage(err: unknown): string;
//# sourceMappingURL=hiloApi.d.ts.map