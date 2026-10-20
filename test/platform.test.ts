import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { API, Logger, PlatformConfig } from 'homebridge';
import { HiloChallengePlatform, SCHEDULE_REFRESH_MS } from '../src/platform';
import { HttpsRequester } from '../src/hiloApi';
import { authFilePath, newAuthFile, writeAuthFile } from '../src/hiloAuth';
import { readStateFile, stateFilePath } from '../src/stateFile';

const EVENT = {
  id: 107,
  progress: 'scheduled',
  phases: {
    preheatStartDateUTC: '2026-12-20T09:00:00Z',
    preheatEndDateUTC: '2026-12-20T11:00:00Z',
    reductionStartDateUTC: '2026-12-20T11:00:00Z',
    reductionEndDateUTC: '2026-12-20T15:00:00Z',
    recoveryStartDateUTC: '2026-12-20T15:00:00Z',
    recoveryEndDateUTC: '2026-12-20T15:50:00Z',
  },
};

// A fake Hilo whose events endpoint can be switched off, counting the calls it gets.
function fakeHilo() {
  const hilo = { eventsCalls: 0, tokenCalls: 0, failEvents: false };
  const request: HttpsRequester = async (_m, hostname, reqPath, _h, body) => {
    if (hostname === 'connexion.hiloenergie.com') {
      hilo.tokenCalls++;
      const token = new URLSearchParams(body).get('refresh_token');
      return { status: 200, data: JSON.stringify({ access_token: 'AT', refresh_token: `${token}+`, expires_in: 86_400 }) };
    }
    if (reqPath === '/Automation/v1/api/Locations') {
      return { status: 200, data: JSON.stringify([{ id: 4051, locationHiloId: 'urn:hilo:crm:aaa:0' }]) };
    }
    if (reqPath.startsWith('/GDService/v1/api/Locations/4051/Events')) {
      hilo.eventsCalls++;
      if (hilo.failEvents) return { status: 503, data: 'Service Unavailable' };
      return { status: 200, data: JSON.stringify([EVENT]) };
    }
    return { status: 404, data: '' };
  };
  return Object.assign(hilo, { request });
}

// Just enough of the Homebridge API and HAP to run the platform without a HAP server.
function fakeHomebridge(storage: string) {
  const events = new EventEmitter();
  const service = {
    setCharacteristic: () => service,
    getCharacteristic: () => ({ onGet: () => undefined }),
    updateCharacteristic: () => service,
  };
  class FakeAccessory {
    constructor(readonly displayName: string, readonly UUID: string) {}
    getService() { return service; }
    addService() { return service; }
  }
  const api = {
    on: (event: string, fn: () => void) => events.on(event, fn),
    user: { storagePath: () => storage, configPath: () => path.join(storage, 'config.json') },
    hap: {
      uuid: { generate: (s: string) => s },
      Service: { AccessoryInformation: 'info', ContactSensor: 'contact' },
      Characteristic: {
        Manufacturer: 'm', Model: 'mo', SerialNumber: 's', Name: 'n',
        ContactSensorState: { CONTACT_DETECTED: 0, CONTACT_NOT_DETECTED: 1 },
      },
    },
    platformAccessory: FakeAccessory,
    registerPlatformAccessories: () => undefined,
  } as unknown as API;
  return { api, events };
}

function quietLog(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const add = (level: string) => (m: string) => { lines.push(`${level} ${m}`); };
  return { lines, info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug') } as unknown as Logger & { lines: string[] };
}

async function startPlatform(opts: { now: Date; loggedIn?: boolean }) {
  const storage = mkdtempSync(path.join(tmpdir(), 'hilo-platform-'));
  if (opts.loggedIn !== false) writeAuthFile(authFilePath(storage), newAuthFile('RT-login'));
  const hilo = fakeHilo();
  const clock = { now: opts.now };
  const { api, events } = fakeHomebridge(storage);
  const log = quietLog();
  const config = { platform: 'HiloChallenge', name: 'Hilo Challenge', pollInterval: 300 } as PlatformConfig;
  const platform = new HiloChallengePlatform(log, config, api, { request: hilo.request, now: () => clock.now });

  // run init() (first poll included) the way Homebridge does, then stop its timer
  events.emit('didFinishLaunching');
  await new Promise((resolve) => setTimeout(resolve, 20));
  events.emit('shutdown');

  const poll = async (iso: string) => {
    clock.now = new Date(iso);
    await (platform as unknown as { poll(): Promise<void> }).poll();
    return readStateFile(stateFilePath(storage))!;
  };
  return { hilo, log, poll, state: () => readStateFile(stateFilePath(storage))! };
}

test('in season, the phase follows the schedule through every transition', async () => {
  const p = await startPlatform({ now: new Date('2026-12-20T08:00:00Z') });
  assert.equal(p.state().phase, 'none');
  assert.equal(p.state().error, null);
  assert.equal((await p.poll('2026-12-20T09:00:00Z')).phase, 'preheat');
  assert.equal((await p.poll('2026-12-20T11:00:00Z')).phase, 'reduction');
  const recovery = await p.poll('2026-12-20T15:10:00Z');
  assert.equal(recovery.phase, 'recovery');
  assert.equal(recovery.phaseSince, '2026-12-20T15:10:00.000Z'); // first seen
  assert.equal((await p.poll('2026-12-20T16:00:00Z')).phase, 'none');
});

test('the schedule is fetched at most every 5 minutes', async () => {
  const p = await startPlatform({ now: new Date('2026-12-20T08:00:00Z') });
  assert.equal(p.hilo.eventsCalls, 1);
  await p.poll('2026-12-20T08:01:00Z');
  await p.poll('2026-12-20T08:04:00Z');
  assert.equal(p.hilo.eventsCalls, 1);
  await p.poll(new Date(Date.parse('2026-12-20T08:00:00Z') + SCHEDULE_REFRESH_MS).toISOString());
  assert.equal(p.hilo.eventsCalls, 2);
});

test('when Hilo is unreachable, the cached schedule keeps the phases on time', async () => {
  const p = await startPlatform({ now: new Date('2026-12-20T08:00:00Z') });
  p.hilo.failEvents = true;
  const state = await p.poll('2026-12-20T11:30:00Z');
  assert.equal(state.phase, 'reduction');
  assert.match(state.error ?? '', /HTTP 503/);
  p.hilo.failEvents = false;
  assert.equal((await p.poll('2026-12-20T11:40:00Z')).error, null);
});

test('off-season: one check at startup, then no API calls', async () => {
  const p = await startPlatform({ now: new Date('2026-10-20T12:00:00Z') });
  assert.equal(p.hilo.eventsCalls, 1);
  const state = await p.poll('2026-10-20T13:00:00Z');
  assert.equal(p.hilo.eventsCalls, 1);
  assert.equal(state.season, false);
  assert.equal(state.phase, 'none');
});

test('not logged in: sensors stay closed, the state file says why, no token request', async () => {
  const p = await startPlatform({ now: new Date('2026-12-20T12:00:00Z'), loggedIn: false });
  assert.equal(p.state().phase, 'none');
  assert.match(p.state().error ?? '', /Not logged in to Hilo/);
  assert.equal(p.hilo.tokenCalls, 0);
  assert.ok(p.log.lines.some((l) => l.startsWith('error ') && l.includes('Not logged in')));
});
