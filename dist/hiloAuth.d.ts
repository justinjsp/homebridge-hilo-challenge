export declare const B2C_HOST = "connexion.hiloenergie.com";
export declare const CLIENT_ID = "1ca9f585-4a55-4085-8e30-9746a65fa561";
export declare const REDIRECT_URI = "https://my.home-assistant.io/redirect/oauth";
export declare const AUTH_FILE_VERSION = 1;
export type HttpsRequester = (method: string, hostname: string, path: string, headers: Record<string, string>, body?: string) => Promise<{
    status: number;
    data: string;
}>;
export declare const httpsRequest: HttpsRequester;
export interface AuthFile {
    version: 1;
    sessionId: string;
    refreshToken: string;
    updatedAt: string;
}
export declare function authFilePath(storagePath: string): string;
/** Reads and validates the auth file. Returns null when missing or invalid; never throws. */
export declare function readAuthFile(filePath: string): AuthFile | null;
/**
 * Writes the auth file atomically (temp file + rename) with mode 0600, as it holds a
 * credential. Throws on failure.
 */
export declare function writeAuthFile(filePath: string, auth: AuthFile): void;
export declare function newAuthFile(refreshToken: string, now?: Date): AuthFile;
/**
 * Saves a rotated refresh token — unless the file now belongs to a different session
 * (the user logged in again from the settings page meanwhile), in which case the new
 * login wins and this rotation is dropped. Returns whether it was saved.
 */
export declare function saveRotatedToken(filePath: string, sessionId: string, refreshToken: string, now?: Date): boolean;
export interface PendingLogin {
    url: string;
    state: string;
    verifier: string;
}
export declare function startLogin(): PendingLogin;
/**
 * Pulls the authorization code out of what the user pasted: the address of the page
 * they landed on after logging in (any host — my.home-assistant.io, or wherever it
 * forwarded them). Checks the state when the address carries one.
 */
export declare function parseRedirect(pasted: string, expectedState: string): string;
export interface TokenSet {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
}
export declare class TokenRequestError extends Error {
    readonly status: number;
    readonly body: string;
    constructor(message: string, status: number, body: string);
    /** True when Hilo rejected the refresh token itself, so retrying it is pointless. */
    get invalidGrant(): boolean;
}
export declare function exchangeCode(code: string, verifier: string, request?: HttpsRequester): Promise<TokenSet>;
export declare function redeemRefreshToken(refreshToken: string, request?: HttpsRequester): Promise<TokenSet>;
//# sourceMappingURL=hiloAuth.d.ts.map