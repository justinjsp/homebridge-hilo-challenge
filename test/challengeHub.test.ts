import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ChallengeHub, RESYNC_MS } from '../src/challengeHub';
import { HiloLog, NOT_LOGGED_IN, NotLoggedInError, phaseAt } from '../src/hiloApi';
import { FakeHubServer } from './fakeHub';

// As Hilo sends it in EventListInitialValuesReceived / EventAdded (see python-hilo's
// doc/signalr/challengehub)
const FLEX_EVENT = {
  id: 355,
  progress: 'scheduled',
  period: 'AM',
  phases: {
    settingsDeadlineUTC: '2026-12-20T05:00:00Z',
    preheatStartDateUTC: '2026-12-20T06:00:00Z',
    preheatEndDateUTC: '2026-12-20T11:00:00Z',
    reductionStartDateUTC: '2026-12-20T11:00:00Z',
    reductionEndDateUTC: '2026-12-20T15:00:00Z',
    recoveryStartDateUTC: '2026-12-20T15:00:00Z',
    recoveryEndDateUTC: '2026-12-20T16:00:00Z',
  },
};

const URN = 'urn:hilo:crm:aaa:0';

function recorder(): HiloLog & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => lines.push(`info ${m}`),
    debug: (m) => lines.push(`debug ${m}`),
    error: (m) => lines.push(`error ${m}`),
  };
}

function setup(opts: { ratePlan?: string; token?: () => Promise<string> } = {}) {
  const server = new FakeHubServer();
  const clock = { now: new Date('2026-12-20T08:00:00Z') };
  const log = recorder();
  const hub = new ChallengeHub(
    { hiloId: URN, ratePlan: opts.ratePlan ?? 'Flex' },
    opts.token ?? (async () => 'AT'), log, () => clock.now, server.connector,
  );
  const advance = (ms: number) => { clock.now = new Date(clock.now.getTime() + ms); };
  return { server, hub, log, clock, advance };
}

const at = (iso: string) => new Date(iso);

test('subscribes to the location\'s event list and builds the schedule from it', async () => {
  const { server, hub } = setup();
  server.list = [FLEX_EVENT];
  await hub.start();
  assert.equal(hub.isConnected, true);
  assert.deepEqual(server.last.sent[0], { method: 'SubscribeToEventList', arg: { locationHiloId: URN } });
  assert.equal(hub.hasSchedule, true);
  assert.equal(hub.lastError, null);
  assert.equal(phaseAt(hub.schedule(), at('2026-12-20T07:00:00Z')), 'preheat');
  assert.equal(phaseAt(hub.schedule(), at('2026-12-20T12:00:00Z')), 'reduction');
  assert.equal(phaseAt(hub.schedule(), at('2026-12-20T15:30:00Z')), 'recovery');
  assert.equal(phaseAt(hub.schedule(), at('2026-12-20T16:00:00Z')), 'none');
});

test('an empty list is a known, empty schedule', async () => {
  const { hub } = setup();
  await hub.start();
  assert.equal(hub.hasSchedule, true);
  assert.deepEqual(hub.schedule(), []);
});

test('subscribes to the details of upcoming challenges, by rate', async () => {
  const flex = setup({ ratePlan: 'Flex' });
  flex.server.list = [FLEX_EVENT, { ...FLEX_EVENT, id: 300, progress: 'completed' }];
  await flex.hub.start();
  assert.deepEqual(flex.server.last.sent.slice(1),
    [{ method: 'SubscribeToEventFlex', arg: { locationHiloId: URN, eventId: 355 } }]);

  const ch = setup({ ratePlan: 'CH' });
  ch.server.list = [FLEX_EVENT];
  await ch.hub.start();
  assert.deepEqual(ch.server.last.sent.slice(1),
    [{ method: 'SubscribeToEventCH', arg: { locationHiloId: URN, eventId: 355 } }]);
});

test('detail messages update a challenge: new times, or cancelled', async () => {
  const { server, hub } = setup();
  server.list = [{ id: 355, progress: 'scheduled' }]; // a list item without phases
  await hub.start();
  assert.deepEqual(hub.schedule(), []);

  server.last.emit('EventFlexDetailsInitialValuesReceived', { ...FLEX_EVENT, consumption: {} });
  assert.equal(phaseAt(hub.schedule(), at('2026-12-20T12:00:00Z')), 'reduction');

  server.last.emit('EventFlexDetailsUpdatedValuesReceived', {
    id: 355, phases: { ...FLEX_EVENT.phases, reductionEndDateUTC: '2026-12-20T13:00:00Z', recoveryStartDateUTC: '2026-12-20T13:00:00Z' },
  });
  assert.equal(phaseAt(hub.schedule(), at('2026-12-20T14:00:00Z')), 'recovery');

  server.last.emit('EventFlexDetailsUpdatedValuesReceived', { id: 355, progress: 'cancelled' });
  assert.deepEqual(hub.schedule(), []);
  // only one detail subscription per challenge
  assert.equal(server.last.sent.filter((s) => s.method === 'SubscribeToEventFlex').length, 1);
});

test('a challenge announced while connected is added and followed', async () => {
  const { server, hub } = setup();
  await hub.start();
  server.last.emit('EventAdded', FLEX_EVENT);
  assert.equal(phaseAt(hub.schedule(), at('2026-12-20T12:00:00Z')), 'reduction');
  assert.deepEqual(server.last.sent[server.last.sent.length - 1], { method: 'SubscribeToEventFlex', arg: { locationHiloId: URN, eventId: 355 } });
});

test('a new full list drops challenges no longer in it', async () => {
  const { server, hub } = setup();
  server.list = [FLEX_EVENT];
  await hub.start();
  server.last.emit('EventListInitialValuesReceived', []);
  assert.deepEqual(hub.schedule(), []);
});

test('opted-out challenges never open a sensor', async () => {
  const { server, hub } = setup();
  server.list = [{ ...FLEX_EVENT, isParticipating: false }];
  await hub.start();
  assert.deepEqual(hub.schedule(), []);
  assert.equal(server.last.sent.length, 1); // no detail subscription either
});

test('asks for the list again every 15 minutes while connected', async () => {
  const { server, hub, advance } = setup();
  await hub.start();
  advance(RESYNC_MS - 1);
  await hub.tick();
  assert.equal(server.last.sent.filter((s) => s.method === 'SubscribeToEventList').length, 1);
  advance(1);
  await hub.tick();
  assert.equal(server.last.sent.filter((s) => s.method === 'SubscribeToEventList').length, 2);
  assert.equal(server.connections.length, 1);
});

test('after a drop it keeps the schedule, reports why, and reconnects with backoff', async () => {
  const { server, hub, advance, log } = setup();
  server.list = [FLEX_EVENT];
  await hub.start();
  server.last.drop();
  assert.equal(hub.isConnected, false);
  assert.match(hub.lastError ?? '', /ChallengeHub lost: WebSocket closed/);
  assert.equal(phaseAt(hub.schedule(), at('2026-12-20T12:00:00Z')), 'reduction'); // still known

  server.refuse = true;
  advance(29_000);
  await hub.tick();
  assert.equal(server.connections.length, 1); // waits 30 s first
  advance(1_000);
  await hub.tick();
  assert.equal(server.connections.length, 2);
  assert.match(hub.lastError ?? '', /Could not connect.*negotiation/);

  advance(59_000);
  await hub.tick();
  assert.equal(server.connections.length, 2); // then 60 s
  server.refuse = false;
  advance(1_000);
  await hub.tick();
  assert.equal(server.connections.length, 3);
  assert.equal(hub.isConnected, true);
  assert.equal(hub.lastError, null);
  assert.deepEqual(server.last.sent[0], { method: 'SubscribeToEventList', arg: { locationHiloId: URN } });
  assert.ok(log.lines.includes('info Reconnected to Hilo\'s ChallengeHub'));
});

test('not logged in: no connection is made, and the error says why', async () => {
  const { server, hub, advance } = setup({ token: async () => { throw new NotLoggedInError(NOT_LOGGED_IN); } });
  await hub.start();
  assert.equal(server.connections.length, 0);
  assert.equal(hub.lastError, NOT_LOGGED_IN);
  assert.equal(hub.lastErrorIsLogin, true);
  assert.equal(hub.hasSchedule, false);
  advance(30_000);
  await hub.tick();
  assert.equal(server.connections.length, 0);
});

test('stop() closes quietly and tick() then does nothing', async () => {
  const { server, hub, advance } = setup();
  await hub.start();
  await hub.stop();
  assert.equal(server.last.stopped, true);
  assert.equal(hub.lastError, null);
  advance(RESYNC_MS);
  await hub.tick();
  assert.equal(server.connections.length, 1);
  assert.equal(hub.isRunning, false);
});
