"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.NO_PHASE = exports.STATE_FILE_VERSION = void 0;
exports.stateFilePath = stateFilePath;
exports.advancePhase = advancePhase;
exports.buildState = buildState;
exports.restorePhase = restorePhase;
exports.readStateFile = readStateFile;
exports.writeStateFile = writeStateFile;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// Shared state file read by other plugins (e.g. homebridge-ecoflow-delta3).
// Contract, version 1 — see "For other plugins" in the README before changing it.
exports.STATE_FILE_VERSION = 1;
// Long HTTP error bodies (HTML error pages) are cut down before they go into the file.
const MAX_ERROR_LENGTH = 500;
const PHASES = ['none', 'preheat', 'reduction', 'recovery'];
exports.NO_PHASE = { phase: 'none', since: null };
function stateFilePath(storagePath) {
    return path.join(storagePath, 'hilo-challenge', 'state.json');
}
/**
 * Moves the tracked phase forward after a successful poll. A phase that is still
 * active keeps its original start time; a new phase starts now.
 */
function advancePhase(previous, phase, now) {
    if (phase === 'none')
        return exports.NO_PHASE;
    if (phase === previous.phase && previous.since)
        return previous;
    return { phase, since: now.toISOString() };
}
/**
 * Builds the state file object. Pure — everything it needs is passed in.
 * Off-season always reports phase 'none'.
 */
function buildState(input) {
    const tracked = input.season ? input.tracked : exports.NO_PHASE;
    return {
        version: exports.STATE_FILE_VERSION,
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
function restorePhase(previous, now, season, maxAgeMs) {
    if (!previous || !season || previous.phase === 'none')
        return exports.NO_PHASE;
    const age = now.getTime() - Date.parse(previous.updatedAt);
    if (!(age >= 0 && age <= maxAgeMs))
        return exports.NO_PHASE;
    return { phase: previous.phase, since: previous.phaseSince };
}
/**
 * Reads and validates an existing state file. Returns null when it is missing or
 * not a valid version 1 file; never throws.
 */
function readStateFile(filePath) {
    try {
        const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (json?.version !== exports.STATE_FILE_VERSION ||
            typeof json.updatedAt !== 'string' || Number.isNaN(Date.parse(json.updatedAt)) ||
            typeof json.season !== 'boolean' ||
            !PHASES.includes(json.phase) ||
            !(json.phaseSince === null || typeof json.phaseSince === 'string') ||
            typeof json.pollIntervalSeconds !== 'number' ||
            !(json.error === null || typeof json.error === 'string')) {
            return null;
        }
        return json;
    }
    catch {
        return null;
    }
}
/**
 * Writes the state file atomically: a temp file in the same directory, then a rename,
 * so readers never see a half-written file. Mode 0644. Never throws — returns the
 * failure message, or null on success.
 */
function writeStateFile(filePath, state) {
    const dir = path.dirname(filePath);
    const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o644 });
        fs.chmodSync(tmp, 0o644); // writeFileSync's mode is masked by the umask
        fs.renameSync(tmp, filePath);
        return null;
    }
    catch (err) {
        try {
            fs.rmSync(tmp, { force: true });
        }
        catch { /* nothing to clean up */ }
        return err instanceof Error ? err.message : String(err);
    }
}
//# sourceMappingURL=stateFile.js.map