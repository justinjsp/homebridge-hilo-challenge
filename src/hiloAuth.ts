import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';

// Azure B2C auth config — the Hilo app's public client, as used by homebridge-hilo and
// the Home Assistant integration. my.home-assistant.io is the redirect URI registered for it.
export const B2C_HOST = 'connexion.hiloenergie.com';
const B2C_TENANT = 'HiloDirectoryB2C.onmicrosoft.com';
const B2C_POLICY = 'B2C_1A_SIGN_IN';
export const CLIENT_ID = '1ca9f585-4a55-4085-8e30-9746a65fa561';
export const REDIRECT_URI = 'https://my.home-assistant.io/redirect/oauth';
const SCOPE = [
  'openid',
  'https://HiloDirectoryB2C.onmicrosoft.com/hiloapis/user_impersonation',
  'offline_access',
].join(' ');
const TOKEN_PATH = `/${B2C_TENANT}/oauth2/v2.0/token?p=${B2C_POLICY}`;
const AUTHORIZE_URL = `https://${B2C_HOST}/${B2C_TENANT}/${B2C_POLICY}/oauth2/v2.0/authorize`;

export const AUTH_FILE_VERSION = 1;

export type HttpsRequester = (
  method: string,
  hostname: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
) => Promise<{ status: number; data: string }>;

export const httpsRequest: HttpsRequester = (method, hostname, reqPath, headers, body) => {
  return new Promise((resolve, reject) => {
    const reqHeaders: Record<string, string> = { ...headers };
    if (body) {
      reqHeaders['Content-Length'] = Buffer.byteLength(body).toString();
    }
    const req = https.request({ hostname, path: reqPath, method, headers: reqHeaders, timeout: 30_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error(`Request to ${hostname} timed out`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
};

// ---- This plugin's own Hilo session -----------------------------------------------------
//
// The plugin never uses homebridge-hilo's refresh token. It has its own login (from its
// settings page), so its own refresh token, which it rotates and keeps in its own file.
// Two independent sessions on the same Hilo account cannot invalidate each other.

export interface AuthFile {
  version: 1;
  // Random per login. Lets the platform tell a fresh login apart from its own rotations.
  sessionId: string;
  refreshToken: string;
  updatedAt: string;
}

export function authFilePath(storagePath: string): string {
  return path.join(storagePath, 'hilo-challenge', 'auth.json');
}

/** Reads and validates the auth file. Returns null when missing or invalid; never throws. */
export function readAuthFile(filePath: string): AuthFile | null {
  try {
    const json = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<AuthFile>;
    if (
      json?.version !== AUTH_FILE_VERSION ||
      typeof json.sessionId !== 'string' || json.sessionId === '' ||
      typeof json.refreshToken !== 'string' || json.refreshToken === '' ||
      typeof json.updatedAt !== 'string'
    ) {
      return null;
    }
    return json as AuthFile;
  } catch {
    return null;
  }
}

/**
 * Writes the auth file atomically (temp file + rename) with mode 0600, as it holds a
 * credential. Throws on failure.
 */
export function writeAuthFile(filePath: string, auth: AuthFile): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean up */ }
    throw err;
  }
}

export function newAuthFile(refreshToken: string, now = new Date()): AuthFile {
  return {
    version: AUTH_FILE_VERSION,
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
export function saveRotatedToken(filePath: string, sessionId: string, refreshToken: string, now = new Date()): boolean {
  const current = readAuthFile(filePath);
  if (current && current.sessionId !== sessionId) return false;
  writeAuthFile(filePath, { version: AUTH_FILE_VERSION, sessionId, refreshToken, updatedAt: now.toISOString() });
  return true;
}

// ---- Login (authorization code + PKCE) --------------------------------------------------

export interface PendingLogin {
  url: string;
  state: string;
  verifier: string;
}

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function startLogin(): PendingLogin {
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64Url(crypto.randomBytes(12));
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
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
export function parseRedirect(pasted: string, expectedState: string): string {
  const input = pasted.trim();
  let url: URL;
  try {
    url = new URL(input);
  } catch {
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

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

function parseTokenResponse(res: { status: number; data: string }, what: string): TokenSet {
  if (res.status >= 400) {
    throw new TokenRequestError(`${what} failed: HTTP ${res.status}: ${res.data}`, res.status, res.data);
  }
  const json = JSON.parse(res.data) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!json.access_token || !json.refresh_token) {
    throw new Error(`${what} failed: no token in Hilo's response`);
  }
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresIn: Number(json.expires_in) || 0 };
}

export class TokenRequestError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message);
  }

  /** True when Hilo rejected the refresh token itself, so retrying it is pointless. */
  get invalidGrant(): boolean {
    return this.status === 400 && /invalid_grant/i.test(this.body);
  }
}

export async function exchangeCode(code: string, verifier: string, request: HttpsRequester = httpsRequest): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
  }).toString();
  const res = await request('POST', B2C_HOST, TOKEN_PATH, { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
  return parseTokenResponse(res, 'Hilo login');
}

export async function redeemRefreshToken(refreshToken: string, request: HttpsRequester = httpsRequest): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    scope: SCOPE,
  }).toString();
  const res = await request('POST', B2C_HOST, TOKEN_PATH, { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
  return parseTokenResponse(res, 'Token refresh');
}
