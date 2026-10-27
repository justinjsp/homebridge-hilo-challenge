import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { API, Logger, PlatformConfig } from 'homebridge';
import { HiloChallengePlatform } from '../src/platform';
import { HttpsRequester } from '../src/hiloApi';
import { FakeHubServer } from './fakeHub';
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

// A fake Hilo: the token and locations endpoints over HTTPS, and a ChallengeHub
// that serves EVENT in its event list.
function fakeHilo() {
  const hub = new FakeHubServer();
  hub.list = [EVENT];
  const hilo = { tokenCalls: 0, locationCalls: 0, hub };
  const request: HttpsRequester = async (_m, hostname, reqPath, _h, body) => {
    if (hostname === 'connexion.hiloenergie.com') {
      hilo.tokenCalls++;
      const token = new URLSearchParams(body).get('refresh_token');
      return { status: 200, data: JSON.stringify({ access_token: 'AT', refresh_token: `${token}+`, expires_in: 86_400 }) };
    }
    if (reqPath === '/Automation/v1/api/Locations') {
      hilo.locationCalls++;
      return {
        status: 200,
        data: JSON.stringify([{ id: 4051, locationHiloId: 'urn:hilo:crm:aaa:0', ratePlan: { current: 'CH' } }]),
      };
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
  const platform = new HiloChallengePlatform(log, config, api,
    { request: hilo.request, now: () => clock.now, connector: hilo.hub.connector });

  // run init() (first poll included) the way Homebridge does, then stop its timer
  events.emit('didFinishLaunching');
  await new Promise((resolve) => setTimeout(resolve, 20));
  clearInterval((platform as unknown as { timer: NodeJS.Timeout }).timer);

  const poll = async (iso: string) => {
    clock.now = new Date(iso);
    await (platform as unknown as { poll(): Promise<void> }).poll();
    return readStateFile(stateFilePath(storage))!;
  };
  const shutdown = async () => {
    events.emit('shutdown');
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  return { hilo, log, poll, shutdown, state: () => readStateFile(stateFilePath(storage))! };
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

test('the schedule comes from the ChallengeHub, for the location\'s URN', async () => {
  const p = await startPlatform({ now: new Date('2026-12-20T08:00:00Z') });
  assert.equal(p.hilo.hub.connections.length, 1);
  assert.deepEqual(p.hilo.hub.last.sent[0], { method: 'SubscribeToEventList', arg: { locationHiloId: 'urn:hilo:crm:aaa:0' } });
  assert.deepEqual(p.hilo.hub.last.sent[1], { method: 'SubscribeToEventCH', arg: { locationHiloId: 'urn:hilo:crm:aaa:0', eventId: 107 } });
  assert.ok(p.log.lines.some((l) => l.includes('Hilo challenge schedule: event 107 from 2026-12-20T09:00:00.000Z')));
  // later polls neither look the location up again nor open another connection
  await p.poll('2026-12-20T08:01:00Z');
  await p.poll('2026-12-20T08:02:00Z');
  assert.equal(p.hilo.locationCalls, 1);
  assert.equal(p.hilo.hub.connections.length, 1);
  await p.shutdown();
  assert.equal(p.hilo.hub.last.stopped, true);
});

test('a challenge announced over the hub opens the sensors on time', async () => {
  const p = await startPlatform({ now: new Date('2026-12-21T08:00:00Z') });
  const added = { ...EVENT, id: 108, phases: { ...EVENT.phases,
    reductionStartDateUTC: '2026-12-21T11:00:00Z', reductionEndDateUTC: '2026-12-21T15:00:00Z' } };
  p.hilo.hub.list.push(added); // Hilo's list has it from now on, as the periodic resync will see
  p.hilo.hub.last.emit('EventAdded', added);
  assert.equal((await p.poll('2026-12-21T08:05:00Z')).phase, 'none');
  assert.equal((await p.poll('2026-12-21T12:00:00Z')).phase, 'reduction');
});

test('when the hub drops, the last schedule keeps the phases on time until it reconnects', async () => {
  const p = await startPlatform({ now: new Date('2026-12-20T08:00:00Z') });
  p.hilo.hub.refuse = true;
  p.hilo.hub.last.drop();
  const state = await p.poll('2026-12-20T11:30:00Z');
  assert.equal(state.phase, 'reduction');
  assert.match(state.error ?? '', /Could not connect to Hilo's ChallengeHub/);
  p.hilo.hub.refuse = false;
  const later = await p.poll('2026-12-20T11:40:00Z');
  assert.equal(later.error, null);
  assert.equal(later.phase, 'reduction');
  assert.ok(p.log.lines.includes('info Hilo challenge polling recovered'));
});

test('off-season: one hub check at startup, then disconnected', async () => {
  const p = await startPlatform({ now: new Date('2026-10-20T12:00:00Z') });
  assert.equal(p.hilo.hub.connections.length, 1);
  const state = await p.poll('2026-10-20T12:01:00Z');
  assert.equal(p.hilo.hub.last.stopped, true);
  assert.equal(state.season, false);
  assert.equal(state.phase, 'none');
  assert.equal(state.error, null);
  await p.poll('2026-10-20T13:00:00Z');
  assert.equal(p.hilo.hub.connections.length, 1);
});

test('the season starting connects the hub', async () => {
  const p = await startPlatform({ now: new Date('2026-11-30T12:00:00Z') });
  await p.poll('2026-11-30T12:01:00Z');
  assert.equal(p.hilo.hub.last.stopped, true);
  const state = await p.poll('2026-12-01T00:00:00');
  assert.equal(state.season, true);
  assert.equal(p.hilo.hub.connections.length, 2);
  assert.equal(p.hilo.hub.last.stopped, false);
});

test('not logged in: sensors stay closed, the state file says why, no token request', async () => {
  const p = await startPlatform({ now: new Date('2026-12-20T12:00:00Z'), loggedIn: false });
  assert.equal(p.state().phase, 'none');
  assert.match(p.state().error ?? '', /Not logged in to Hilo/);
  assert.equal(p.hilo.tokenCalls, 0);
  assert.equal(p.hilo.hub.connections.length, 0);
  assert.ok(p.log.lines.some((l) => l.startsWith('error ') && l.includes('Not logged in')));
});
