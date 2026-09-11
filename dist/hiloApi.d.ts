export type ChallengePhaseName = 'none' | 'preheat' | 'reduction' | 'recovery';
export type HiloLog = {
    info: (m: string) => void;
    debug: (m: string) => void;
    error: (m: string) => void;
};
export type HttpsRequester = (method: string, hostname: string, path: string, headers: Record<string, string>, body?: string) => Promise<{
    status: number;
    data: string;
}>;
export type RefreshTokenSource = 'homebridge-hilo config' | 'plugin config' | 'rotated token';
export interface RefreshTokenCandidate {
    token: string;
    source: RefreshTokenSource;
}
/**
 * Reads the refresh token homebridge-hilo keeps in Homebridge's config.json. homebridge-hilo
 * rotates that token and writes the new one back, so it stays fresher than a copy pasted
 * into this plugin's config. Returns null when there is no usable token; never throws.
 */
export declare function readHomebridgeHiloToken(configPath: string | undefined, log?: {
    debug: (m: string) => void;
}): string | null;
/**
 * Orders the refresh tokens to try: homebridge-hilo's config token first (it is kept
 * fresh), then the last rotated token Hilo returned to us, then this plugin's configured
 * token (the oldest, as it never changes). Empty and duplicate tokens are dropped.
 */
export declare function orderRefreshTokens(fromHomebridgeHilo: string | null | undefined, configured: string | null | undefined, rotated: string | null | undefined): RefreshTokenCandidate[];
export declare class HiloApi {
    private readonly configuredRefreshToken;
    private readonly log;
    private readonly configPath?;
    private readonly request;
    private accessToken;
    private tokenExpiry;
    private rotatedRefreshToken;
    private loginInFlight;
    constructor(configuredRefreshToken: string | undefined, log: HiloLog, configPath?: string | undefined, request?: HttpsRequester);
    /**
     * The refresh tokens available right now, in the order they will be tried.
     * Re-reads config.json each time, so homebridge-hilo's latest rotation is picked up.
     */
    refreshTokenCandidates(): RefreshTokenCandidate[];
    private ensureToken;
    private refreshAccessToken;
    private apiHeaders;
    getLocationId(): Promise<string>;
    /**
     * Query the Hilo GraphQL API for the current challenge phase.
     * Inspects the gDState field on each device in the location:
     *   ACTIVE   → reduction phase
     *   PRE_HEAT → preheat phase
     *   RECOVERY → recovery phase
     *   anything else (OFF, absent) → none
     *
     * Returns the first non-none phase found, or 'none' if no challenge is active.
     */
    getChallengePhase(locationId: string): Promise<ChallengePhaseName>;
}
//# sourceMappingURL=hiloApi.d.ts.map