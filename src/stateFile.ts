import * as fs from 'fs';
import * as path from 'path';
import { ChallengePhaseName } from './hiloApi';

// Shared state file read by other plugins (e.g. homebridge-ecoflow-delta3).
// Contract, version 1 — see "For other plugins" in the README before changing it.
export const STATE_FILE_VERSION = 1;

// Long HTTP error bodies (HTML error pages) are cut down before they go into the file.
const MAX_ERROR_LENGTH = 500;

const PHASES: readonly ChallengePhaseName[] = ['none', 'preheat', 'reduction', 'recovery'];

export interface HiloChallengeState {
  version: 1;
  updatedAt: string;
  season: boolean;
  phase: ChallengePhaseName;
  phaseSince: string | null;
  pollIntervalSeconds: number;
  error: string | null;
}

// The current phase and when it was first seen (ISO time; null while the phase is 'none').
export interface TrackedPhase {
  phase: ChallengePhaseName;
  since: string | null;
}

export const NO_PHASE: TrackedPhase = { phase: 'none', since: null };

export function stateFilePath(storagePath: string): string {
  return path.join(storagePath, 'hilo-challenge', 'state.json');
}

/**
 * Moves the tracked phase forward after a successful poll. A phase that is still
 * active keeps its original start time; a new phase starts now.
 */
export function advancePhase(previous: TrackedPhase, phase: ChallengePhaseName, now: Date): TrackedPhase {
  if (phase === 'none') return NO_PHASE;
  if (phase === previous.phase && previous.since) return previous;
  return { phase, since: now.toISOString() };
}

/**
 * Builds the state file object. Pure — everything it needs is passed in.
 * Off-season always reports phase 'none'.
 */
export function buildState(input: {
  now: Date;
  season: boolean;
  tracked: TrackedPhase;
  pollIntervalSeconds: number;
  error: string | null;
}): HiloChallengeState {
  const tracked = input.season ? input.tracked : NO_PHASE;
  return {
    version: STATE_FILE_VERSION,
    updatedAt: input.now.toISOString(),
    season: input.season,
    phase: tracked.phase,
    phaseSince: tracked.phase === 'none' ? null : tracked.since,
    pollIntervalSeconds: input.pollIntervalSeconds,
    error: input.error === null ? null : input.error.slice(0, MAX_ERROR_LENGTH),
  };
}

/**
 * Picks the phase to publish at startup. A phase from a state file written just before
 * a restart is carried over, so readers don't see a challenge briefly "end" while
 * Homebridge restarts; anything older, invalid or off-season starts from 'none'.
 */
export function restorePhase(
  previous: HiloChallengeState | null,
  now: Date,
  season: boolean,
  maxAgeMs: number,
): TrackedPhase {
  if (!previous || !season || previous.phase === 'none') return NO_PHASE;
  const age = now.getTime() - Date.parse(previous.updatedAt);
  if (!(age >= 0 && age <= maxAgeMs)) return NO_PHASE;
  return { phase: previous.phase, since: previous.phaseSince };
}

/**
 * Reads and validates an existing state file. Returns null when it is missing or
 * not a valid version 1 file; never throws.
 */
export function readStateFile(filePath: string): HiloChallengeState | null {
  try {
    const json = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<HiloChallengeState>;
    if (
      json?.version !== STATE_FILE_VERSION ||
      typeof json.updatedAt !== 'string' || Number.isNaN(Date.parse(json.updatedAt)) ||
      typeof json.season !== 'boolean' ||
      !PHASES.includes(json.phase as ChallengePhaseName) ||
      !(json.phaseSince === null || typeof json.phaseSince === 'string') ||
      typeof json.pollIntervalSeconds !== 'number' ||
      !(json.error === null || typeof json.error === 'string')
    ) {
      return null;
    }
    return json as HiloChallengeState;
  } catch {
    return null;
  }
}

/**
 * Writes the state file atomically: a temp file in the same directory, then a rename,
 * so readers never see a half-written file. Mode 0644. Never throws — returns the
 * failure message, or null on success.
 */
export function writeStateFile(filePath: string, state: HiloChallengeState): string | null {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o644 });
    fs.chmodSync(tmp, 0o644); // writeFileSync's mode is masked by the umask
    fs.renameSync(tmp, filePath);
    return null;
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean up */ }
    return err instanceof Error ? err.message : String(err);
  }
}
