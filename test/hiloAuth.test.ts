import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import {
  CLIENT_ID, HttpsRequester, REDIRECT_URI, TokenRequestError, authFilePath, exchangeCode, newAuthFile,
  parseRedirect, readAuthFile, redeemRefreshToken, saveRotatedToken, startLogin, writeAuthFile,
} from '../src/hiloAuth';

function tempAuthPath(): string {
  return authFilePath(mkdtempSync(path.join(tmpdir(), 'hilo-auth-')));
}

test('auth file lives in its own folder in the storage dir, not in config.json', () => {
  assert.equal(authFilePath('/var/lib/homebridge'), '/var/lib/homebridge/hilo-challenge/auth.json');
});

test('auth file round-trips and is private (0600)', () => {
  const file = tempAuthPath();
  const auth = newAuthFile('RT-1', new Date('2026-10-20T12:00:00Z'));
  writeAuthFile(file, auth);
  assert.deepEqual(readAuthFile(file), auth);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.match(auth.sessionId, /^[0-9a-f]{16}$/);
});

test('readAuthFile returns null for missing, corrupt or incomplete files', () => {
  const file = tempAuthPath();
  assert.equal(readAuthFile(file), null);
  writeAuthFile(file, newAuthFile('RT'));
  writeFileSync(file, '{not json');
  assert.equal(readAuthFile(file), null);
  writeFileSync(file, JSON.stringify({ version: 1, sessionId: 'abc', refreshToken: '', updatedAt: 'x' }));
  assert.equal(readAuthFile(file), null);
  writeFileSync(file, JSON.stringify({ version: 2, sessionId: 'abc', refreshToken: 'RT', updatedAt: 'x' }));
  assert.equal(readAuthFile(file), null);
});

test('saveRotatedToken updates its own session', () => {
  const file = tempAuthPath();
  const auth = newAuthFile('RT-1');
  writeAuthFile(file, auth);
  assert.equal(saveRotatedToken(file, auth.sessionId, 'RT-2'), true);
  assert.equal(readAuthFile(file)?.refreshToken, 'RT-2');
  assert.equal(readAuthFile(file)?.sessionId, auth.sessionId);
});

test('saveRotatedToken never overwrites a newer login', () => {
  const file = tempAuthPath();
  const old = newAuthFile('RT-old');
  writeAuthFile(file, old);
  const fresh = newAuthFile('RT-new-login');
  writeAuthFile(file, fresh); // user logged in again from the settings page
  assert.equal(saveRotatedToken(file, old.sessionId, 'RT-old-rotated'), false);
  assert.equal(readAuthFile(file)?.refreshToken, 'RT-new-login');
});

test('startLogin builds a PKCE authorize URL for the Hilo client', () => {
  const login = startLogin();
  const url = new URL(login.url);
  assert.equal(url.host, 'connexion.hiloenergie.com');
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), login.state);
  assert.match(url.searchParams.get('scope') ?? '', /offline_access/);
  assert.notEqual(url.searchParams.get('code_challenge'), login.verifier);
  assert.notEqual(startLogin().state, login.state);
});

test('parseRedirect takes the code from wherever the browser landed', () => {
  assert.equal(parseRedirect('https://my.home-assistant.io/redirect/oauth?code=ABC&state=S1', 'S1'), 'ABC');
  assert.equal(parseRedirect('  http://192.168.1.5:8880/auth/external/callback?state=S1&code=XYZ  ', 'S1'), 'XYZ');
  assert.equal(parseRedirect('https://example.com/cb#code=FRAG&state=S1', 'S1'), 'FRAG');
});

test('parseRedirect rejects bad input with a helpful message', () => {
  assert.throws(() => parseRedirect('ABC', 'S1'), /not a web address/);
  assert.throws(() => parseRedirect('https://my.home-assistant.io/redirect/oauth', 'S1'), /no login code/);
  assert.throws(() => parseRedirect('https://x.test/?code=ABC&state=OTHER', 'S1'), /different login attempt/);
  assert.throws(
    () => parseRedirect('https://x.test/?error=access_denied&error_description=User+cancelled', 'S1'),
    /User cancelled/,
  );
});

function tokenEndpoint(status: number, data: object | string) {
  const calls: Array<{ path: string; params: URLSearchParams }> = [];
  const request: HttpsRequester = async (_m, host, reqPath, _h, body) => {
    assert.equal(host, 'connexion.hiloenergie.com');
    calls.push({ path: reqPath, params: new URLSearchParams(body) });
    return { status, data: typeof data === 'string' ? data : JSON.stringify(data) };
  };
  return { calls, request };
}

test('exchangeCode sends the code and verifier and returns the tokens', async () => {
  const hilo = tokenEndpoint(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 });
  assert.deepEqual(await exchangeCode('CODE', 'VERIFIER', hilo.request),
    { accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600 });
  const p = hilo.calls[0].params;
  assert.equal(p.get('grant_type'), 'authorization_code');
  assert.equal(p.get('code'), 'CODE');
  assert.equal(p.get('code_verifier'), 'VERIFIER');
  assert.equal(p.get('redirect_uri'), REDIRECT_URI);
});

test('redeemRefreshToken flags invalid_grant', async () => {
  const hilo = tokenEndpoint(400, '{"error":"invalid_grant","error_description":"expired"}');
  await assert.rejects(redeemRefreshToken('RT', hilo.request), (err: unknown) =>
    err instanceof TokenRequestError && err.invalidGrant);
  const other = tokenEndpoint(503, 'Service Unavailable');
  await assert.rejects(redeemRefreshToken('RT', other.request), (err: unknown) =>
    err instanceof TokenRequestError && !err.invalidGrant);
});
