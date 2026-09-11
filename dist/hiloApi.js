"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.HiloApi = void 0;
exports.readHomebridgeHiloToken = readHomebridgeHiloToken;
exports.orderRefreshTokens = orderRefreshTokens;
const fs = __importStar(require("fs"));
const https = __importStar(require("https"));
// Azure B2C auth config — same values as homebridge-hilo
const B2C_HOST = 'connexion.hiloenergie.com';
const B2C_TENANT = 'HiloDirectoryB2C.onmicrosoft.com';
const B2C_POLICY = 'B2C_1A_SIGN_IN';
const CLIENT_ID = '1ca9f585-4a55-4085-8e30-9746a65fa561';
const SCOPE = [
    'openid',
    'https://HiloDirectoryB2C.onmicrosoft.com/hiloapis/user_impersonation',
    'offline_access',
].join(' ');
const GRAPHQL_HOST = 'platform.hiloenergie.com';
const GRAPHQL_PATH = '/api/digital-twin/v3/graphql';
const APIM_KEY = '20eeaedcb86945afa3fe792cea89b8bf';
// homebridge-hilo's platform identifier in config.json. Homebridge also accepts the
// fully-qualified "<plugin>.<platform>" form.
const HOMEBRIDGE_HILO_PLATFORMS = ['Hilo', 'homebridge-hilo.Hilo'];
// GraphQL query — inline fragments for every device type that exposes gDState.
// gDState values observed: 'ACTIVE' (reduction), 'PRE_HEAT' (preheat),
// 'RECOVERY' (recovery), 'OFF' / absent (no challenge).
const GD_STATE_QUERY = `
  query GetLocationGDState($locationHiloId: String!) {
    getLocation(id: $locationHiloId) {
      devices {
        __typename
        ... on BasicThermostat        { gDState }
        ... on HeatingFloorThermostat { gDState }
        ... on LowVoltageThermostat   { gDState }
        ... on WaterHeater            { gDState }
      }
    }
  }
`;
function httpsRequest(method, hostname, path, headers, body) {
    return new Promise((resolve, reject) => {
        const reqHeaders = { ...headers };
        if (body) {
            reqHeaders['Content-Length'] = Buffer.byteLength(body).toString();
        }
        const req = https.request({ hostname, path, method, headers: reqHeaders }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        if (body)
            req.write(body);
        req.end();
    });
}
/**
 * Reads the refresh token homebridge-hilo keeps in Homebridge's config.json. homebridge-hilo
 * rotates that token and writes the new one back, so it stays fresher than a copy pasted
 * into this plugin's config. Returns null when there is no usable token; never throws.
 */
function readHomebridgeHiloToken(configPath, log) {
    if (!configPath)
        return null;
    let raw;
    try {
        raw = fs.readFileSync(configPath, 'utf8');
    }
    catch (err) {
        log?.debug(`Could not read ${configPath} for the homebridge-hilo token: ${err instanceof Error ? err.message : err}`);
        return null;
    }
    let config;
    try {
        config = JSON.parse(raw);
    }
    catch {
        // Deliberately not logging the parse error — it quotes file content, which may include tokens.
        log?.debug(`Could not parse ${configPath} for the homebridge-hilo token (not valid JSON)`);
        return null;
    }
    const platforms = Array.isArray(config?.platforms) ? config.platforms : [];
    for (const entry of platforms) {
        if (!entry || typeof entry !== 'object')
            continue;
        const { platform, refreshToken } = entry;
        if (typeof platform === 'string' && HOMEBRIDGE_HILO_PLATFORMS.includes(platform) &&
            typeof refreshToken === 'string' && refreshToken.trim() !== '') {
            return refreshToken.trim();
        }
    }
    log?.debug(`No homebridge-hilo ("Hilo") platform with a refreshToken in ${configPath}`);
    return null;
}
/**
 * Orders the refresh tokens to try: homebridge-hilo's config token first (it is kept
 * fresh), then the last rotated token Hilo returned to us, then this plugin's configured
 * token (the oldest, as it never changes). Empty and duplicate tokens are dropped.
 */
function orderRefreshTokens(fromHomebridgeHilo, configured, rotated) {
    const candidates = [];
    const add = (token, source) => {
        const trimmed = token?.trim();
        if (trimmed && !candidates.some((c) => c.token === trimmed)) {
            candidates.push({ token: trimmed, source });
        }
    };
    add(fromHomebridgeHilo, 'homebridge-hilo config');
    add(rotated, 'rotated token');
    add(configured, 'plugin config');
    return candidates;
}
class HiloApi {
    constructor(configuredRefreshToken, log, 
    // Homebridge's config.json — re-read before every token refresh for homebridge-hilo's token
    configPath, request = httpsRequest) {
        this.configuredRefreshToken = configuredRefreshToken;
        this.log = log;
        this.configPath = configPath;
        this.request = request;
        this.accessToken = null;
        this.tokenExpiry = 0;
        this.rotatedRefreshToken = null;
        this.loginInFlight = null;
    }
    /**
     * The refresh tokens available right now, in the order they will be tried.
     * Re-reads config.json each time, so homebridge-hilo's latest rotation is picked up.
     */
    refreshTokenCandidates() {
        return orderRefreshTokens(readHomebridgeHiloToken(this.configPath, this.log), this.configuredRefreshToken, this.rotatedRefreshToken);
    }
    async ensureToken() {
        if (this.accessToken && Date.now() < this.tokenExpiry - 60000) {
            return;
        }
        if (this.loginInFlight)
            return this.loginInFlight;
        this.loginInFlight = this.refreshAccessToken().finally(() => { this.loginInFlight = null; });
        return this.loginInFlight;
    }
    async refreshAccessToken() {
        const candidates = this.refreshTokenCandidates();
        if (candidates.length === 0) {
            throw new Error('No Hilo refresh token available — configure homebridge-hilo or set "refreshToken"');
        }
        // Try each token in order; a rejected one (e.g. expired) falls through to the next.
        const path = `/${B2C_TENANT}/oauth2/v2.0/token?p=${B2C_POLICY}`;
        let lastError = null;
        for (const { token, source } of candidates) {
            this.log.debug(`Refreshing Hilo access token (using the ${source})`);
            const body = new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: token,
                client_id: CLIENT_ID,
                scope: SCOPE,
            }).toString();
            const res = await this.request('POST', B2C_HOST, path, {
                'Content-Type': 'application/x-www-form-urlencoded',
            }, body);
            if (res.status >= 400) {
                lastError = new Error(`Token refresh failed: HTTP ${res.status}: ${res.data}`);
                this.log.debug(`Token refresh with the ${source} was rejected (HTTP ${res.status})`);
                continue;
            }
            const json = JSON.parse(res.data);
            this.accessToken = json.access_token;
            if (json.refresh_token)
                this.rotatedRefreshToken = json.refresh_token;
            this.tokenExpiry = Date.now() + json.expires_in * 1000;
            this.log.debug('Hilo access token refreshed');
            return;
        }
        throw lastError ?? new Error('Token refresh failed');
    }
    apiHeaders() {
        return {
            Authorization: `Bearer ${this.accessToken}`,
            'Ocp-Apim-Subscription-Key': APIM_KEY,
            'Content-Type': 'application/json',
        };
    }
    async getLocationId() {
        await this.ensureToken();
        // Try known REST endpoint patterns. These may return 404 on newer API versions —
        // if so, set "locationId" manually in your config (see README).
        const candidates = [
            '/v2/api/Locations',
            '/GDService/v1/api/Locations',
            '/v1/api/Locations',
        ];
        for (const path of candidates) {
            this.log.debug(`Trying location endpoint: ${path}`);
            const res = await this.request('GET', 'api.hiloenergie.com', path, this.apiHeaders());
            if (res.status === 200) {
                this.log.debug(`Locations response from ${path}: ${res.data}`);
                const data = JSON.parse(res.data);
                const locations = Array.isArray(data)
                    ? data
                    : (data.items ?? data.locations ?? data.value ?? []);
                if (locations.length > 0)
                    return String(locations[0].id);
            }
            this.log.debug(`${path} returned ${res.status}`);
        }
        throw new Error('Could not auto-discover location ID. Add "locationId" to your config. ' +
            'You can find it in the homebridge-hilo logs — look for "Subscribed to updates for location".');
    }
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
    async getChallengePhase(locationId) {
        await this.ensureToken();
        const requestBody = JSON.stringify({
            query: GD_STATE_QUERY,
            variables: { locationHiloId: locationId },
        });
        this.log.debug(`Querying Hilo GraphQL for gDState (location: ${locationId})`);
        const res = await this.request('POST', GRAPHQL_HOST, GRAPHQL_PATH, this.apiHeaders(), requestBody);
        if (res.status >= 400) {
            throw new Error(`GraphQL request failed: HTTP ${res.status}: ${res.data}`);
        }
        const json = JSON.parse(res.data);
        if (json.errors?.length) {
            throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join(', ')}`);
        }
        const devices = json.data?.getLocation?.devices ?? [];
        this.log.debug(`GraphQL returned ${devices.length} device(s)`);
        for (const device of devices) {
            const state = device.gDState;
            if (!state || state === 'OFF')
                continue;
            this.log.debug(`Device ${device.__typename ?? 'unknown'} gDState: ${state}`);
            if (state === 'ACTIVE')
                return 'reduction';
            if (state === 'PRE_HEAT')
                return 'preheat';
            if (state === 'RECOVERY')
                return 'recovery';
        }
        return 'none';
    }
}
exports.HiloApi = HiloApi;
//# sourceMappingURL=hiloApi.js.map