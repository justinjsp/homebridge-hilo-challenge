export type ChallengePhaseName = 'none' | 'preheat' | 'reduction' | 'recovery';
export declare class HiloApi {
    private refreshToken;
    private readonly log;
    private accessToken;
    private tokenExpiry;
    private currentRefreshToken;
    private loginInFlight;
    constructor(refreshToken: string, log: {
        info: (m: string) => void;
        debug: (m: string) => void;
        error: (m: string) => void;
    });
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