"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HiloApi = exports.NotLoggedInError = exports.LOGIN_EXPIRED = exports.NOT_LOGGED_IN = void 0;
exports.wontRun = wontRun;
exports.normalizeEvent = normalizeEvent;
exports.phaseAt = phaseAt;
exports.pickLocation = pickLocation;
exports.errorMessage = errorMessage;
const hiloAuth_1 = require("./hiloAuth");
const API_HOST = 'api.hiloenergie.com';
const APIM_KEY = '20eeaedcb86945afa3fe792cea89b8bf';
const LOCATIONS_PATH = '/Automation/v1/api/Locations';
exports.NOT_LOGGED_IN = 'Not logged in to Hilo. Open this plugin\'s settings in the Homebridge UI and choose "Log in to Hilo".';
exports.LOGIN_EXPIRED = 'The Hilo login has expired or was revoked. Open this plugin\'s settings in the Homebridge UI and log in to Hilo again.';
class NotLoggedInError extends Error {
}
exports.NotLoggedInError = NotLoggedInError;
// Event progress values that mean the event will not (or no longer) run.
const FINISHED_PROGRESS = ['completed', 'cancelled', 'canceled'];
// When several phases overlap (two events back to back), the most restrictive one wins.
const PHASE_PRIORITY = ['reduction', 'preheat', 'recovery'];
function parseUtc(value) {
    if (typeof value !== 'string' || value === '')
        return null;
    // Hilo's times are UTC; some come without a zone designator
    const withZone = /([zZ]|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`;
    const ms = Date.parse(withZone);
    return Number.isNaN(ms) ? null : ms;
}
/** Events the user opted out of, or that are over or cancelled, never open a sensor. */
function wontRun(event) {
    if (event.isParticipating === false)
        return true;
    return typeof event.progress === 'string' && FINISHED_PROGRESS.includes(event.progress.toLowerCase());
}
/**
 * Turns one challenge event from Hilo's ChallengeHub into its phase windows. Phase keys
 * look like "preheatStartDateUTC" / "reductionEndDateUTC" (some API versions use a
 * "…Utc" suffix). Returns null for events that won't run or have no usable phases.
 */
function normalizeEvent(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const event = raw;
    if (wontRun(event))
        return null;
    const rawPhases = event.phases;
    if (!rawPhases || typeof rawPhases !== 'object')
        return null;
    const times = {};
    for (const [key, value] of Object.entries(rawPhases)) {
        const ms = parseUtc(value);
        if (ms !== null)
            times[key.toLowerCase().replace(/(dateutc|utc)$/, '')] = ms;
    }
    const phases = {};
    for (const phase of PHASE_PRIORITY) {
        const start = times[`${phase}start`];
        const end = times[`${phase}end`];
        if (start !== undefined && end !== undefined && end > start)
            phases[phase] = { start, end };
    }
    if (Object.keys(phases).length === 0)
        return null;
    return { id: String(event.id ?? '?'), phases };
}
/** The challenge phase in effect at `now`, from the scheduled phase windows. */
function phaseAt(events, now) {
    const t = now.getTime();
    for (const phase of PHASE_PRIORITY) {
        if (events.some((e) => {
            const w = e.phases[phase];
            return w !== undefined && w.start <= t && t < w.end;
        })) {
            return phase;
        }
    }
    return 'none';
}
/** Hilo list responses are usually bare arrays; accept the common wrappers too. */
function asList(data) {
    if (Array.isArray(data))
        return data;
    if (data && typeof data === 'object') {
        const obj = data;
        for (const key of ['items', 'value', 'locations']) {
            if (Array.isArray(obj[key]))
                return obj[key];
        }
    }
    return [];
}
/**
 * Picks the location to follow. `configured` may be the numeric location id or the
 * urn:hilo:crm:… id; without one, the account's first location is used.
 */
function pickLocation(list, configured) {
    const locations = list
        .filter((l) => !!l && typeof l === 'object')
        .filter((l) => l.id !== undefined && l.id !== null)
        .map((l) => ({ id: String(l.id), hiloId: typeof l.locationHiloId === 'string' ? l.locationHiloId : '', ratePlan: currentRatePlan(l.ratePlan) }));
    if (locations.length === 0)
        throw new Error('Hilo returned no locations for this account');
    const wanted = configured?.trim();
    if (!wanted)
        return locations[0];
    const match = locations.find((l) => l.id === wanted || l.hiloId === wanted);
    if (!match) {
        const known = locations.map((l) => `${l.id} (${l.hiloId || 'no URN'})`).join(', ');
        throw new Error(`Location "${wanted}" is not on this Hilo account. Locations found: ${known}`);
    }
    return match;
}
/** Locations give their rate as { current: "Flex", history: [...] }. */
function currentRatePlan(ratePlan) {
    if (typeof ratePlan === 'string')
        return ratePlan;
    if (ratePlan && typeof ratePlan === 'object') {
        const current = ratePlan.current;
        if (typeof current === 'string')
            return current;
    }
    return '';
}
class HiloApi {
    constructor(
    // This plugin's own auth file (see hiloAuth.ts) — re-read before every token refresh,
    // so a new login from the settings page is picked up without a restart.
    authPath, log, request = hiloAuth_1.httpsRequest) {
        this.authPath = authPath;
        this.log = log;
        this.request = request;
        this.accessToken = null;
        this.tokenExpiry = 0;
        this.loginInFlight = null;
        // A refresh token Hilo has rejected; not retried until a new login replaces it.
        this.rejectedToken = null;
    }
    isLoggedIn() {
        return (0, hiloAuth_1.readAuthFile)(this.authPath) !== null;
    }
    async ensureToken() {
        if (this.accessToken && Date.now() < this.tokenExpiry - 60000)
            return;
        if (this.loginInFlight)
            return this.loginInFlight;
        this.loginInFlight = this.refreshAccessToken().finally(() => { this.loginInFlight = null; });
        return this.loginInFlight;
    }
    async refreshAccessToken() {
        const auth = (0, hiloAuth_1.readAuthFile)(this.authPath);
        if (!auth)
            throw new NotLoggedInError(exports.NOT_LOGGED_IN);
        if (auth.refreshToken === this.rejectedToken)
            throw new NotLoggedInError(exports.LOGIN_EXPIRED);
        this.log.debug('Refreshing the Hilo access token');
        let tokens;
        try {
            tokens = await (0, hiloAuth_1.redeemRefreshToken)(auth.refreshToken, this.request);
        }
        catch (err) {
            if (err instanceof hiloAuth_1.TokenRequestError && err.invalidGrant) {
                this.rejectedToken = auth.refreshToken;
                throw new NotLoggedInError(exports.LOGIN_EXPIRED);
            }
            throw err;
        }
        // Save the rotated token first: the old one may stop working now that it's been used.
        try {
            if (!(0, hiloAuth_1.saveRotatedToken)(this.authPath, auth.sessionId, tokens.refreshToken)) {
                this.log.debug('A new Hilo login was saved meanwhile; using it from the next refresh');
            }
        }
        catch (err) {
            this.log.error(`Could not save the rotated Hilo token to ${this.authPath}: ${errorMessage(err)}`);
        }
        this.accessToken = tokens.accessToken;
        this.tokenExpiry = Date.now() + tokens.expiresIn * 1000;
        this.log.debug('Hilo access token refreshed');
    }
    async apiGet(path) {
        await this.ensureToken();
        const res = await this.request('GET', API_HOST, path, {
            Authorization: `Bearer ${this.accessToken}`,
            'Ocp-Apim-Subscription-Key': APIM_KEY,
            Accept: 'application/json',
        });
        if (res.status === 401)
            this.accessToken = null; // refresh on the next call
        if (res.status >= 400)
            throw new Error(`GET ${path} failed: HTTP ${res.status}: ${res.data}`);
        return res.data.trim() === '' ? null : JSON.parse(res.data);
    }
    async getLocation(configured) {
        const data = await this.apiGet(LOCATIONS_PATH);
        return pickLocation(asList(data), configured);
    }
    /** A current access token, refreshed as needed (for the ChallengeHub connection). */
    async getAccessToken() {
        await this.ensureToken();
        if (!this.accessToken)
            throw new Error('No Hilo access token');
        return this.accessToken;
    }
}
exports.HiloApi = HiloApi;
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
//# sourceMappingURL=hiloApi.js.map