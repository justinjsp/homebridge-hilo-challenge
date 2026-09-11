import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import {
  HiloApi, HiloLog, HttpsRequester, orderRefreshTokens, readHomebridgeHiloToken,
} from '../src/hiloApi';

const HB_TOKEN = 'TOKEN-from-homebridge-hilo';
const OWN_TOKEN = 'TOKEN-from-plugin-config';

function recorder(): HiloLog & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => lines.push(`info ${m}`),
    debug: (m) => lines.push(`debug ${m}`),
    error: (m) => lines.push(`error ${m}`),
  };
}

function tempConfig(content: unknown): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'hilo-config-')), 'config.json');
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return file;
}

function homebridgeConfig(hiloToken?: string): object {
  return {
    bridge: { name: 'Homebridge' },
    platforms: [
      { platform: 'config', name: 'Config' },
      { platform: 'Hilo', name: 'Hilo', ...(hiloToken === undefined ? {} : { refreshToken: hiloToken }) },
      { platform: 'HiloChallenge', name: 'Hilo Challenge', refreshToken: OWN_TOKEN },
    ],
  };
}

// Stand-in for the Hilo token endpoint and GraphQL API — no network. Accepts the refresh
// tokens in `accepted`, hands out a new rotated token each time, and reports `gDState`.
function fakeHilo(accepted: Set<string>, gDState = 'RECOVERY') {
  const used: string[] = [];
  let issued = 0;
  const request: HttpsRequester = async (_method, hostname, _path, _headers, body) => {
    if (hostname === 'connexion.hiloenergie.com') {
      const token = new URLSearchParams(body).get('refresh_token') ?? '';
      used.push(token);
      if (!accepted.has(token)) return { status: 400, data: '{"error":"invalid_grant"}' };
      issued++;
      const rotated = `TOKEN-rotated-${issued}`;
      accepted.add(rotated);
      // expires_in 0 so every call refreshes again
      return { status: 200, data: JSON.stringify({ access_token: `access-${issued}`, refresh_token: rotated, expires_in: 0 }) };
    }
    return {
      status: 200,
      data: JSON.stringify({ data: { getLocation: { devices: [{ __typename: 'BasicThermostat', gDState }] } } }),
    };
  };
  return { request, used };
}

test('reads the homebridge-hilo token from config.json', () => {
  assert.equal(readHomebridgeHiloToken(tempConfig(homebridgeConfig(HB_TOKEN))), HB_TOKEN);
  assert.equal(readHomebridgeHiloToken(tempConfig({
    platforms: [{ platform: 'homebridge-hilo.Hilo', refreshToken: ` ${HB_TOKEN} ` }],
  })), HB_TOKEN, 'fully-qualified platform name, trimmed');
});

test('no usable homebridge-hilo entry gives null', () => {
  assert.equal(readHomebridgeHiloToken(tempConfig(homebridgeConfig())), null, 'no refreshToken');
  assert.equal(readHomebridgeHiloToken(tempConfig(homebridgeConfig('   '))), null, 'blank refreshToken');
  assert.equal(readHomebridgeHiloToken(tempConfig({ platforms: [{ platform: 'Hilo', refreshToken: 42 }] })), null);
  assert.equal(readHomebridgeHiloToken(tempConfig({ platforms: { platform: 'Hilo' } })), null, 'platforms not an array');
  assert.equal(readHomebridgeHiloToken(tempConfig({ platforms: [null, 'x'] })), null);
  assert.equal(readHomebridgeHiloToken(tempConfig('null')), null);
  assert.equal(readHomebridgeHiloToken(undefined), null);
});

test('a missing or garbled config.json falls back without throwing or logging the token', () => {
  const log = recorder();
  const missing = path.join(mkdtempSync(path.join(tmpdir(), 'hilo-config-')), 'config.json');
  assert.equal(readHomebridgeHiloToken(missing, log), null);

  const garbled = tempConfig(`{"platforms":[{"platform":"Hilo","refreshToken":"${HB_TOKEN}"`);
  assert.equal(readHomebridgeHiloToken(garbled, log), null);

  assert.equal(log.lines.length, 2);
  assert.ok(log.lines.every((l) => l.startsWith('debug ')));
  assert.ok(log.lines.every((l) => !l.includes(HB_TOKEN)));

  // and the API falls back to its own token
  assert.deepEqual(new HiloApi(OWN_TOKEN, recorder(), garbled).refreshTokenCandidates().map((c) => c.token), [OWN_TOKEN]);
  assert.deepEqual(new HiloApi(OWN_TOKEN, recorder(), missing).refreshTokenCandidates().map((c) => c.token), [OWN_TOKEN]);
});

test('token order: homebridge-hilo config > rotated > own config', () => {
  assert.deepEqual(orderRefreshTokens('hb', 'own', 'rotated'), [
    { token: 'hb', source: 'homebridge-hilo config' },
    { token: 'rotated', source: 'rotated token' },
    { token: 'own', source: 'plugin config' },
  ]);
  assert.deepEqual(orderRefreshTokens(null, 'own', 'rotated').map((c) => c.token), ['rotated', 'own']);
  assert.deepEqual(orderRefreshTokens(null, '', 'rotated').map((c) => c.token), ['rotated']);
  assert.deepEqual(orderRefreshTokens(undefined, undefined, null), []);
  assert.deepEqual(orderRefreshTokens('same', 'same', 'other').map((c) => c.source), ['homebridge-hilo config', 'rotated token']);
});

test('HiloApi prefers homebridge-hilo\'s token and re-reads config.json each time', () => {
  const configPath = tempConfig(homebridgeConfig(HB_TOKEN));
  const api = new HiloApi(OWN_TOKEN, recorder(), configPath);
  assert.deepEqual(api.refreshTokenCandidates().map((c) => c.token), [HB_TOKEN, OWN_TOKEN]);

  // homebridge-hilo rotates and writes its new token back
  writeFileSync(configPath, JSON.stringify(homebridgeConfig('TOKEN-hb-rotated')));
  assert.deepEqual(api.refreshTokenCandidates().map((c) => c.token), ['TOKEN-hb-rotated', OWN_TOKEN]);

  // homebridge-hilo removed: own token only
  writeFileSync(configPath, JSON.stringify({ platforms: [] }));
  assert.deepEqual(api.refreshTokenCandidates().map((c) => c.token), [OWN_TOKEN]);

  // nothing at all: the platform will refuse to start
  assert.deepEqual(new HiloApi(undefined, recorder(), configPath).refreshTokenCandidates(), []);
  assert.deepEqual(new HiloApi(undefined, recorder(), tempConfig(homebridgeConfig(HB_TOKEN)))
    .refreshTokenCandidates().map((c) => c.source), ['homebridge-hilo config']);
});

test('token refresh uses homebridge-hilo\'s token when present', async () => {
  const hilo = fakeHilo(new Set([HB_TOKEN, OWN_TOKEN]));
  const api = new HiloApi(OWN_TOKEN, recorder(), tempConfig(homebridgeConfig(HB_TOKEN)), hilo.request);
  assert.equal(await api.getChallengePhase('urn:hilo:crm:test:0'), 'recovery');
  assert.deepEqual(hilo.used, [HB_TOKEN]);
});

test('the rotated token is preferred over the configured one, and a rejected token falls through', async () => {
  const log = recorder();
  const accepted = new Set([OWN_TOKEN]);
  const hilo = fakeHilo(accepted, 'ACTIVE');
  const api = new HiloApi(OWN_TOKEN, log, tempConfig({ platforms: [] }), hilo.request);

  assert.equal(await api.getChallengePhase('loc'), 'reduction');
  assert.deepEqual(api.refreshTokenCandidates().map((c) => c.token), ['TOKEN-rotated-1', OWN_TOKEN]);

  // the rotated token is revoked: the refresh falls through to the configured one
  accepted.delete('TOKEN-rotated-1');
  assert.equal(await api.getChallengePhase('loc'), 'reduction');
  assert.deepEqual(hilo.used, [OWN_TOKEN, 'TOKEN-rotated-1', OWN_TOKEN]);
  assert.ok(log.lines.every((l) => !l.includes('TOKEN-')), 'tokens are never logged');
});

test('when every token is rejected the refresh error is reported', async () => {
  const hilo = fakeHilo(new Set());
  const api = new HiloApi(OWN_TOKEN, recorder(), tempConfig(homebridgeConfig(HB_TOKEN)), hilo.request);
  await assert.rejects(api.getChallengePhase('loc'), /Token refresh failed: HTTP 400/);
  assert.deepEqual(hilo.used, [HB_TOKEN, OWN_TOKEN]);
});

test('gDState maps to phases', async () => {
  const cases: Array<[string, string]> = [
    ['PRE_HEAT', 'preheat'], ['ACTIVE', 'reduction'], ['RECOVERY', 'recovery'], ['OFF', 'none'],
  ];
  for (const [gDState, phase] of cases) {
    const hilo = fakeHilo(new Set([OWN_TOKEN]), gDState);
    const api = new HiloApi(OWN_TOKEN, recorder(), undefined, hilo.request);
    assert.equal(await api.getChallengePhase('loc'), phase);
  }
});
