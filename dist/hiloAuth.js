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
exports.TokenRequestError = exports.httpsRequest = exports.AUTH_FILE_VERSION = exports.REDIRECT_URI = exports.CLIENT_ID = exports.B2C_HOST = void 0;
exports.authFilePath = authFilePath;
exports.readAuthFile = readAuthFile;
exports.writeAuthFile = writeAuthFile;
exports.newAuthFile = newAuthFile;
exports.saveRotatedToken = saveRotatedToken;
exports.startLogin = startLogin;
exports.parseRedirect = parseRedirect;
exports.exchangeCode = exchangeCode;
exports.redeemRefreshToken = redeemRefreshToken;
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const https = __importStar(require("https"));
const path = __importStar(require("path"));
// Azure B2C auth config — the Hilo app's public client, as used by homebridge-hilo and
// the Home Assistant integration. my.home-assistant.io is the redirect URI registered for it.
exports.B2C_HOST = 'connexion.hiloenergie.com';
const B2C_TENANT = 'HiloDirectoryB2C.onmicrosoft.com';
const B2C_POLICY = 'B2C_1A_SIGN_IN';
exports.CLIENT_ID = '1ca9f585-4a55-4085-8e30-9746a65fa561';
exports.REDIRECT_URI = 'https://my.home-assistant.io/redirect/oauth';
const SCOPE = [
    'openid',
    'https://HiloDirectoryB2C.onmicrosoft.com/hiloapis/user_impersonation',
    'offline_access',
].join(' ');
const TOKEN_PATH = `/${B2C_TENANT}/oauth2/v2.0/token?p=${B2C_POLICY}`;
const AUTHORIZE_URL = `https://${exports.B2C_HOST}/${B2C_TENANT}/${B2C_POLICY}/oauth2/v2.0/authorize`;
exports.AUTH_FILE_VERSION = 1;
const httpsRequest = (method, hostname, reqPath, headers, body) => {
    return new Promise((resolve, reject) => {
        const reqHeaders = { ...headers };
        if (body) {
            reqHeaders['Content-Length'] = Buffer.byteLength(body).toString();
        }
        const req = https.request({ hostname, path: reqPath, method, headers: reqHeaders, timeout: 30000 }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('timeout', () => req.destroy(new Error(`Request to ${hostname} timed out`)));
        req.on('error', reject);
        if (body)
            req.write(body);
        req.end();
    });
};
exports.httpsRequest = httpsRequest;
function authFilePath(storagePath) {
    return path.join(storagePath, 'hilo-challenge', 'auth.json');
}
/** Reads and validates the auth file. Returns null when missing or invalid; never throws. */
function readAuthFile(filePath) {
    try {
        const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (json?.version !== exports.AUTH_FILE_VERSION ||
            typeof json.sessionId !== 'string' || json.sessionId === '' ||
            typeof json.refreshToken !== 'string' || json.refreshToken === '' ||
            typeof json.updatedAt !== 'string') {
            return null;
        }
        return json;
    }
    catch {
        return null;
    }
}
/**
 * Writes the auth file atomically (temp file + rename) with mode 0600, as it holds a
 * credential. Throws on failure.
 */
function writeAuthFile(filePath, auth) {
    const dir = path.dirname(filePath);
    const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(tmp, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, filePath);
    }
    catch (err) {
        try {
            fs.rmSync(tmp, { force: true });
        }
        catch { /* nothing to clean up */ }
        throw err;
    }
}
function newAuthFile(refreshToken, now = new Date()) {
    return {
        version: exports.AUTH_FILE_VERSION,
        sessionId: crypto.randomBytes(8).toString('hex'),
        refreshToken,
        updatedAt: now.toISOString(),
    };
}
/**
 * Saves a rotated refresh token — unless the file now belongs to a different session
 * (the user logged in again from the settings page meanwhile), in which case the new
 * login wins and this rotation is dropped. Returns whether it was saved.
 */
function saveRotatedToken(filePath, sessionId, refreshToken, now = new Date()) {
    const current = readAuthFile(filePath);
    if (current && current.sessionId !== sessionId)
        return false;
    writeAuthFile(filePath, { version: exports.AUTH_FILE_VERSION, sessionId, refreshToken, updatedAt: now.toISOString() });
    return true;
}
function base64Url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function startLogin() {
    const verifier = base64Url(crypto.randomBytes(32));
    const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
    const state = base64Url(crypto.randomBytes(12));
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: exports.CLIENT_ID,
        redirect_uri: exports.REDIRECT_URI,
        scope: SCOPE,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
    });
    return { url: `${AUTHORIZE_URL}?${params.toString()}`, state, verifier };
}
/**
 * Pulls the authorization code out of what the user pasted: the address of the page
 * they landed on after logging in (any host — my.home-assistant.io, or wherever it
 * forwarded them). Checks the state when the address carries one.
 */
function parseRedirect(pasted, expectedState) {
    const input = pasted.trim();
    let url;
    try {
        url = new URL(input);
    }
    catch {
        throw new Error('That is not a web address. Copy the whole address from the browser\'s address bar.');
    }
    // B2C reports errors in the query (or fragment) as error / error_description
    const params = url.searchParams.has('code') || url.searchParams.has('error')
        ? url.searchParams
        : new URLSearchParams(url.hash.replace(/^#/, ''));
    const error = params.get('error');
    if (error) {
        throw new Error(`Hilo refused the login: ${params.get('error_description') ?? error}`);
    }
    const code = params.get('code');
    if (!code) {
        throw new Error('That address has no login code in it. Copy the address after the Hilo login finishes.');
    }
    const state = params.get('state');
    if (state !== null && state !== expectedState) {
        throw new Error('That address belongs to a different login attempt. Start the login again.');
    }
    return code;
}
function parseTokenResponse(res, what) {
    if (res.status >= 400) {
        throw new TokenRequestError(`${what} failed: HTTP ${res.status}: ${res.data}`, res.status, res.data);
    }
    const json = JSON.parse(res.data);
    if (!json.access_token || !json.refresh_token) {
        throw new Error(`${what} failed: no token in Hilo's response`);
    }
    return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresIn: Number(json.expires_in) || 0 };
}
class TokenRequestError extends Error {
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
    }
    /** True when Hilo rejected the refresh token itself, so retrying it is pointless. */
    get invalidGrant() {
        return this.status === 400 && /invalid_grant/i.test(this.body);
    }
}
exports.TokenRequestError = TokenRequestError;
async function exchangeCode(code, verifier, request = exports.httpsRequest) {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: exports.CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: exports.REDIRECT_URI,
    }).toString();
    const res = await request('POST', exports.B2C_HOST, TOKEN_PATH, { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
    return parseTokenResponse(res, 'Hilo login');
}
async function redeemRefreshToken(refreshToken, request = exports.httpsRequest) {
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: exports.CLIENT_ID,
        scope: SCOPE,
    }).toString();
    const res = await request('POST', exports.B2C_HOST, TOKEN_PATH, { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
    return parseTokenResponse(res, 'Token refresh');
}
//# sourceMappingURL=hiloAuth.js.map