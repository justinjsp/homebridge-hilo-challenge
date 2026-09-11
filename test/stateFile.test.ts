import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import {
  NO_PHASE, TrackedPhase, advancePhase, buildState, readStateFile, restorePhase, stateFilePath, writeStateFile,
} from '../src/stateFile';

const T0 = new Date('2026-01-15T21:00:00.000Z');
const T1 = new Date('2026-01-15T21:01:00.000Z');
const T2 = new Date('2026-01-15T21:02:00.000Z');

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'hilo-state-'));
}

test('the state file lives under <storagePath>/hilo-challenge/state.json', () => {
  assert.equal(stateFilePath('/var/lib/homebridge'), path.join('/var/lib/homebridge', 'hilo-challenge', 'state.json'));
});

test('state object for each phase, with phaseSince null only for "none"', () => {
  for (const phase of ['preheat', 'reduction', 'recovery'] as const) {
    const state = buildState({
      now: T1, season: true, tracked: advancePhase(NO_PHASE, phase, T0), pollIntervalSeconds: 60, error: null,
    });
    assert.deepEqual(state, {
      version: 1,
      updatedAt: '2026-01-15T21:01:00.000Z',
      season: true,
      phase,
      phaseSince: '2026-01-15T21:00:00.000Z',
      pollIntervalSeconds: 60,
      error: null,
    });
  }

  const none = buildState({ now: T1, season: true, tracked: NO_PHASE, pollIntervalSeconds: 90, error: null });
  assert.equal(none.phase, 'none');
  assert.equal(none.phaseSince, null);
  assert.equal(none.pollIntervalSeconds, 90);
  assert.deepEqual(Object.keys(none).sort(),
    ['error', 'phase', 'phaseSince', 'pollIntervalSeconds', 'season', 'updatedAt', 'version']);
});

test('phaseSince is kept while a phase lasts and reset when it changes', () => {
  let tracked: TrackedPhase = NO_PHASE;
  tracked = advancePhase(tracked, 'preheat', T0);
  assert.deepEqual(tracked, { phase: 'preheat', since: T0.toISOString() });
  tracked = advancePhase(tracked, 'preheat', T1);
  assert.equal(tracked.since, T0.toISOString(), 'same phase keeps its first-seen time');
  tracked = advancePhase(tracked, 'reduction', T1);
  assert.deepEqual(tracked, { phase: 'reduction', since: T1.toISOString() });
  tracked = advancePhase(tracked, 'recovery', T2);
  assert.deepEqual(tracked, { phase: 'recovery', since: T2.toISOString() });
  tracked = advancePhase(tracked, 'none', T2);
  assert.deepEqual(tracked, { phase: 'none', since: null });
  // a phase that returns after 'none' starts afresh
  assert.equal(advancePhase(tracked, 'reduction', T2).since, T2.toISOString());
});

test('a failed poll keeps the last phase, sets error and still advances updatedAt', () => {
  const tracked = advancePhase(NO_PHASE, 'reduction', T0);
  const ok = buildState({ now: T0, season: true, tracked, pollIntervalSeconds: 60, error: null });
  // the platform leaves `tracked` untouched on failure and passes the error message
  const failed = buildState({
    now: T2, season: true, tracked, pollIntervalSeconds: 60, error: 'GraphQL request failed: HTTP 503: busy',
  });
  assert.equal(failed.phase, 'reduction');
  assert.equal(failed.phaseSince, ok.phaseSince);
  assert.equal(failed.error, 'GraphQL request failed: HTTP 503: busy');
  assert.equal(failed.updatedAt, T2.toISOString());
  assert.notEqual(failed.updatedAt, ok.updatedAt);

  // the next successful poll clears the error
  const recovered = buildState({ now: T2, season: true, tracked, pollIntervalSeconds: 60, error: null });
  assert.equal(recovered.error, null);
});

test('very long error messages are shortened', () => {
  const state = buildState({ now: T0, season: true, tracked: NO_PHASE, pollIntervalSeconds: 60, error: 'x'.repeat(5000) });
  assert.equal(state.error?.length, 500);
});

test('off-season always reports phase "none" and season false', () => {
  const state = buildState({
    now: T0, season: false, tracked: advancePhase(NO_PHASE, 'reduction', T0), pollIntervalSeconds: 60, error: null,
  });
  assert.equal(state.season, false);
  assert.equal(state.phase, 'none');
  assert.equal(state.phaseSince, null);
});

test('atomic write produces valid JSON at the path, mode 0644, no temp files left', () => {
  const dir = tempDir();
  const file = stateFilePath(dir); // hilo-challenge/ does not exist yet
  const first = buildState({ now: T0, season: true, tracked: NO_PHASE, pollIntervalSeconds: 60, error: null });
  assert.equal(writeStateFile(file, first), null);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), first);

  const second = buildState({
    now: T1, season: true, tracked: advancePhase(NO_PHASE, 'preheat', T1), pollIntervalSeconds: 60, error: null,
  });
  assert.equal(writeStateFile(file, second), null);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), second);

  assert.deepEqual(readdirSync(path.dirname(file)), ['state.json']);
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o644);
  }
});

test('a write that cannot succeed returns the reason instead of throwing', () => {
  const dir = tempDir();
  const blocker = path.join(dir, 'not-a-dir');
  writeFileSync(blocker, '');
  const state = buildState({ now: T0, season: true, tracked: NO_PHASE, pollIntervalSeconds: 60, error: null });
  const failure = writeStateFile(path.join(blocker, 'hilo-challenge', 'state.json'), state);
  assert.equal(typeof failure, 'string');
});

test('readStateFile round-trips and rejects missing, garbled or wrong-version files', () => {
  const dir = tempDir();
  const file = stateFilePath(dir);
  assert.equal(readStateFile(file), null);

  const state = buildState({
    now: T0, season: true, tracked: advancePhase(NO_PHASE, 'recovery', T0), pollIntervalSeconds: 60, error: null,
  });
  writeStateFile(file, state);
  assert.deepEqual(readStateFile(file), state);

  writeFileSync(file, '{ not json');
  assert.equal(readStateFile(file), null);
  writeFileSync(file, JSON.stringify({ ...state, version: 2 }));
  assert.equal(readStateFile(file), null);
  writeFileSync(file, JSON.stringify({ ...state, phase: 'bogus' }));
  assert.equal(readStateFile(file), null);
  assert.ok(existsSync(file));
});

test('startup carries over a recent phase only', () => {
  const previous = buildState({
    now: T0, season: true, tracked: advancePhase(NO_PHASE, 'reduction', T0), pollIntervalSeconds: 60, error: null,
  });
  const tenMinutes = 10 * 60_000;
  const soon = new Date(T0.getTime() + 60_000);
  const late = new Date(T0.getTime() + tenMinutes + 1);

  assert.deepEqual(restorePhase(previous, soon, true, tenMinutes), { phase: 'reduction', since: T0.toISOString() });
  assert.deepEqual(restorePhase(previous, late, true, tenMinutes), NO_PHASE, 'too old');
  assert.deepEqual(restorePhase(previous, soon, false, tenMinutes), NO_PHASE, 'off-season');
  assert.deepEqual(restorePhase(null, soon, true, tenMinutes), NO_PHASE, 'no previous file');
  assert.deepEqual(restorePhase(previous, new Date(T0.getTime() - 60_000), true, tenMinutes), NO_PHASE, 'from the future');
});
