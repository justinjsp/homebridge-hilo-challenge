import { ChallengePhaseName } from './hiloApi';
export declare const STATE_FILE_VERSION = 1;
export interface HiloChallengeState {
    version: 1;
    updatedAt: string;
    season: boolean;
    phase: ChallengePhaseName;
    phaseSince: string | null;
    pollIntervalSeconds: number;
    error: string | null;
}
export interface TrackedPhase {
    phase: ChallengePhaseName;
    since: string | null;
}
export declare const NO_PHASE: TrackedPhase;
export declare function stateFilePath(storagePath: string): string;
/**
 * Moves the tracked phase forward after a successful poll. A phase that is still
 * active keeps its original start time; a new phase starts now.
 */
export declare function advancePhase(previous: TrackedPhase, phase: ChallengePhaseName, now: Date): TrackedPhase;
/**
 * Builds the state file object. Pure — everything it needs is passed in.
 * Off-season always reports phase 'none'.
 */
export declare function buildState(input: {
    now: Date;
    season: boolean;
    tracked: TrackedPhase;
    pollIntervalSeconds: number;
    error: string | null;
}): HiloChallengeState;
/**
 * Picks the phase to publish at startup. A phase from a state file written just before
 * a restart is carried over, so readers don't see a challenge briefly "end" while
 * Homebridge restarts; anything older, invalid or off-season starts from 'none'.
 */
export declare function restorePhase(previous: HiloChallengeState | null, now: Date, season: boolean, maxAgeMs: number): TrackedPhase;
/**
 * Reads and validates an existing state file. Returns null when it is missing or
 * not a valid version 1 file; never throws.
 */
export declare function readStateFile(filePath: string): HiloChallengeState | null;
/**
 * Writes the state file atomically: a temp file in the same directory, then a rename,
 * so readers never see a half-written file. Mode 0644. Never throws — returns the
 * failure message, or null on success.
 */
export declare function writeStateFile(filePath: string, state: HiloChallengeState): string | null;
//# sourceMappingURL=stateFile.d.ts.map