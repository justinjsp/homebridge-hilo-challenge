import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import {
  ChallengeEvent, HiloApi, HiloLog, HttpsRequester, LOGIN_EXPIRED, NOT_LOGGED_IN, NotLoggedInError,
  normalizeEvent, phaseAt, pickLocation,
} from '../src/hiloApi';
import { authFilePath, newAuthFile, readAuthFile, writeAuthFile } from '../src/hiloAuth';

function recorder(): HiloLog & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => lines.push(`info ${m}`),
    debug: (m) => lines.push(`debug ${m}`),
    error: (m) => lines.push(`error ${m}`),
  };
}

// The shape documented in python-hilo's get_gd_events
const AM_EVENT = {
  id: 107,
  progress: 'scheduled',
  isParticipating: true,
  period: 'am',
  phases: {
    preheatStartDateUTC: '2026-12-20T09:00:00Z',
    preheatEndDateUTC: '2026-12-20T11:00:00Z',
    reductionStartDateUTC: '2026-12-20T11:00:00Z',
    reductionEndDateUTC: '2026-12-20T15:00:00Z',
    recoveryStartDateUTC: '2026-12-20T15:00:00Z',
    recoveryEndDateUTC: '2026-12-20T15:50:00Z',
  },
};

const at = (iso: string) => new Date(iso);

test('normalizeEvent reads the preheat, reduction and recovery windows', () => {
  const event = normalizeEvent(AM_EVENT)!;
  assert.equal(event.id, '107');
  assert.deepEqual(event.phases.preheat, { start: Date.parse('2026-12-20T09:00:00Z'), end: Date.parse('2026-12-20T11:00:00Z') });
  assert.deepEqual(event.phases.recovery, { start: Date.parse('2026-12-20T15:00:00Z'), end: Date.parse('2026-12-20T15:50:00Z') });
});

test('normalizeEvent accepts …Utc keys and times without a zone (UTC)', () => {
  const event = normalizeEvent({
    id: 1,
    phases: { reductionStartUtc: '2026-12-20T22:00:00', reductionEndUtc: '2026-12-21T02:00:00' },
  })!;
  assert.deepEqual(event.phases, {
    reduction: { start: Date.parse('2026-12-20T22:00:00Z'), end: Date.parse('2026-12-21T02:00:00Z') },
  });
});

test('normalizeEvent skips opted-out, finished and phase-less events', () => {
  assert.equal(normalizeEvent({ ...AM_EVENT, isParticipating: false }), null);
  assert.equal(normalizeEvent({ ...AM_EVENT, progress: 'completed' }), null);
  assert.equal(normalizeEvent({ ...AM_EVENT, progress: 'Cancelled' }), null);
  assert.equal(normalizeEvent({ id: 3, progress: 'scheduled' }), null);
  assert.equal(normalizeEvent({ id: 3, phases: { preheatStartDateUTC: 'nonsense' } }), null);
  assert.equal(normalizeEvent(null), null);
  // inProgress events and events without progress/participation flags still count
  assert.ok(normalizeEvent({ ...AM_EVENT, progress: 'inProgress' }));
  assert.ok(normalizeEvent({ id: 4, phases: AM_EVENT.phases }));
});

test('phaseAt follows the schedule, with half-open windows', () => {
  const events = [normalizeEvent(AM_EVENT)!];
  assert.equal(phaseAt(events, at('2026-12-20T08:59:59Z')), 'none');
  assert.equal(phaseAt(events, at('2026-12-20T09:00:00Z')), 'preheat');
  assert.equal(phaseAt(events, at('2026-12-20T10:59:59Z')), 'preheat');
  assert.equal(phaseAt(events, at('2026-12-20T11:00:00Z')), 'reduction');
  assert.equal(phaseAt(events, at('2026-12-20T15:00:00Z')), 'recovery');
  assert.equal(phaseAt(events, at('2026-12-20T15:49:59Z')), 'recovery');
  assert.equal(phaseAt(events, at('2026-12-20T15:50:00Z')), 'none');
  assert.equal(phaseAt([], at('2026-12-20T12:00:00Z')), 'none');
});

test('phaseAt prefers reduction when two events overlap', () => {
  const recovering: ChallengeEvent = { id: 'a', phases: { recovery: { start: 0, end: 100 } } };
  const reducing: ChallengeEvent = { id: 'b', phases: { reduction: { start: 50, end: 150 } } };
  assert.equal(phaseAt([recovering, reducing], new Date(60)), 'reduction');
});

test('pickLocation uses the first location, or the configured id or URN', () => {
  const list = [
    { id: 4051, locationHiloId: 'urn:hilo:crm:aaa:0', name: 'Home' },
    { id: 9999, locationHiloId: 'urn:hilo:crm:bbb:0', name: 'Cottage' },
  ];
  assert.deepEqual(pickLocation(list), { id: '4051', hiloId: 'urn:hilo:crm:aaa:0' });
  assert.deepEqual(pickLocation(list, '9999'), { id: '9999', hiloId: 'urn:hilo:crm:bbb:0' });
  assert.deepEqual(pickLocation(list, 'urn:hilo:crm:bbb:0'), { id: '9999', hiloId: 'urn:hilo:crm:bbb:0' });
  assert.throws(() => pickLocation(list, 'urn:hilo:crm:zzz:0'), /not on this Hilo account.*4051/);
  assert.throws(() => pickLocation([]), /no locations/);
});

// ---- HiloApi against a fake Hilo (no network) ------------------------------------------

interface FakeHilo {
  request: HttpsRequester;
  calls: string[];
  refreshTokensUsed: string[];
}

function fakeHilo(opts: {
  accepted: Set<string>;
  events?: unknown;
  details?: Record<string, unknown>;
  expiresIn?: number;
}): FakeHilo {
  const calls: string[] = [];
  const refreshTokensUsed: string[] = [];
  let issued = 0;
  const request: HttpsRequester = async (method, hostname, reqPath, headers, body) => {
    calls.push(`${method} ${hostname}${reqPath}`);
    if (hostname === 'connexion.hiloenergie.com') {
      const token = new URLSearchParams(body).get('refresh_token') ?? '';
      refreshTokensUsed.push(token);
      if (!opts.accepted.has(token)) return { status: 400, data: '{"error":"invalid_grant"}' };
      issued++;
      const rotated = `RT-rotated-${issued}`;
      opts.accepted.delete(token); // rotation: the used token is spent
      opts.accepted.add(rotated);
      return {
        status: 200,
        data: JSON.stringify({ access_token: `AT-${issued}`, refresh_token: rotated, expires_in: opts.expiresIn ?? 3600 }),
      };
    }
    assert.equal(hostname, 'api.hiloenergie.com');
    assert.match(headers.Authorization, /^Bearer AT-\d+$/);
    if (reqPath === '/Automation/v1/api/Locations') {
      return { status: 200, data: JSON.stringify([{ id: 4051, locationHiloId: 'urn:hilo:crm:aaa:0' }]) };
    }
    if (reqPath === '/GDService/v1/api/Locations/4051/Events?active=true') {
      return { status: 200, data: JSON.stringify(opts.events ?? []) };
    }
    const detail = reqPath.match(/^\/GDService\/v1\/api\/Locations\/4051\/Events\/(\w+)$/);
    if (detail && opts.details?.[detail[1]]) {
      return { status: 200, data: JSON.stringify(opts.details[detail[1]]) };
    }
    return { status: 404, data: 'Not Found' };
  };
  return { request, calls, refreshTokensUsed };
}

function loggedIn(token: string): string {
  const file = authFilePath(mkdtempSync(path.join(tmpdir(), 'hilo-api-')));
  writeAuthFile(file, newAuthFile(token));
  return file;
}

test('discovers the location from /Automation/v1/api/Locations', async () => {
  const hilo = fakeHilo({ accepted: new Set(['RT-login']) });
  const api = new HiloApi(loggedIn('RT-login'), recorder(), hilo.request);
  assert.deepEqual(await api.getLocation(), { id: '4051', hiloId: 'urn:hilo:crm:aaa:0' });
  assert.ok(hilo.calls.includes('GET api.hiloenergie.com/Automation/v1/api/Locations'));
});

test('reads phases inline from the events list', async () => {
  const hilo = fakeHilo({ accepted: new Set(['RT-login']), events: [AM_EVENT] });
  const api = new HiloApi(loggedIn('RT-login'), recorder(), hilo.request);
  const events = await api.getChallengeEvents('4051');
  assert.equal(phaseAt(events, at('2026-12-20T12:00:00Z')), 'reduction');
  assert.equal(hilo.calls.filter((c) => c.includes('/Events/')).length, 0);
});

test('fetches event details when the list has no phases', async () => {
  const hilo = fakeHilo({
    accepted: new Set(['RT-login']),
    events: [{ id: 107, progress: 'scheduled' }, { id: 108, progress: 'completed' }, { id: 109, isParticipating: false }],
    details: { 107: AM_EVENT },
  });
  const api = new HiloApi(loggedIn('RT-login'), recorder(), hilo.request);
  const events = await api.getChallengeEvents('4051');
  assert.equal(events.length, 1);
  assert.equal(phaseAt(events, at('2026-12-20T09:30:00Z')), 'preheat');
  // finished and opted-out events are not looked up
  assert.deepEqual(hilo.calls.filter((c) => c.includes('/Events/')),
    ['GET api.hiloenergie.com/GDService/v1/api/Locations/4051/Events/107']);
});

test('accepts a wrapped events list', async () => {
  const hilo = fakeHilo({ accepted: new Set(['RT-login']), events: { items: [AM_EVENT] } });
  const api = new HiloApi(loggedIn('RT-login'), recorder(), hilo.request);
  assert.equal((await api.getChallengeEvents('4051')).length, 1);
});

test('without a login it makes no token request at all', async () => {
  const hilo = fakeHilo({ accepted: new Set() });
  const file = authFilePath(mkdtempSync(path.join(tmpdir(), 'hilo-api-')));
  const api = new HiloApi(file, recorder(), hilo.request);
  assert.equal(api.isLoggedIn(), false);
  await assert.rejects(api.getLocation(), (err: unknown) => err instanceof NotLoggedInError && err.message === NOT_LOGGED_IN);
  assert.deepEqual(hilo.calls, []);
});

test('only ever redeems its own token, never homebridge-hilo\'s', async () => {
  // homebridge-hilo's token sits in config.json next door; this plugin must not touch it
  const storage = mkdtempSync(path.join(tmpdir(), 'hilo-api-'));
  const configPath = path.join(storage, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    platforms: [
      { platform: 'Hilo', refreshToken: 'RT-homebridge-hilo' },
      { platform: 'HiloChallenge', name: 'Hilo Challenge', refreshToken: 'RT-pasted-copy' },
    ],
  }));
  const before = readFileSync(configPath, 'utf8');
  const file = authFilePath(storage);
  writeAuthFile(file, newAuthFile('RT-login'));

  const hilo = fakeHilo({ accepted: new Set(['RT-login', 'RT-homebridge-hilo', 'RT-pasted-copy']), expiresIn: 0 });
  const api = new HiloApi(file, recorder(), hilo.request);
  await api.getLocation();
  await api.getLocation(); // expires_in 0: refreshes again with the rotated token

  assert.deepEqual(hilo.refreshTokensUsed, ['RT-login', 'RT-rotated-1']);
  assert.equal(readFileSync(configPath, 'utf8'), before);
});

test('persists each rotated token, so a restart keeps working', async () => {
  const file = loggedIn('RT-login');
  const accepted = new Set(['RT-login']);
  const first = new HiloApi(file, recorder(), fakeHilo({ accepted }).request);
  await first.getLocation();
  assert.equal(readAuthFile(file)?.refreshToken, 'RT-rotated-1');

  // "restart": a new instance reads the rotated token from disk; the spent one is gone
  const hilo = fakeHilo({ accepted });
  await new HiloApi(file, recorder(), hilo.request).getLocation();
  assert.deepEqual(hilo.refreshTokensUsed, ['RT-rotated-1']);
});

test('a rejected token is not retried until a new login replaces it', async () => {
  const file = loggedIn('RT-expired');
  const accepted = new Set<string>();
  const hilo = fakeHilo({ accepted });
  const api = new HiloApi(file, recorder(), hilo.request);

  await assert.rejects(api.getLocation(), (err: unknown) => err instanceof NotLoggedInError && err.message === LOGIN_EXPIRED);
  await assert.rejects(api.getLocation(), (err: unknown) => err instanceof NotLoggedInError);
  assert.deepEqual(hilo.refreshTokensUsed, ['RT-expired']);

  // user logs in again from the settings page; picked up without a restart
  accepted.add('RT-new-login');
  writeAuthFile(file, newAuthFile('RT-new-login'));
  assert.deepEqual(await api.getLocation(), { id: '4051', hiloId: 'urn:hilo:crm:aaa:0' });
});

test('API errors surface with the status code', async () => {
  const hilo = fakeHilo({ accepted: new Set(['RT-login']) });
  const api = new HiloApi(loggedIn('RT-login'), recorder(), hilo.request);
  await assert.rejects(api.getChallengeEvents('9999'), /HTTP 404/);
});
