import {
  HttpsRequester, TokenRequestError, httpsRequest, readAuthFile, redeemRefreshToken, saveRotatedToken,
} from './hiloAuth';

export type { HttpsRequester } from './hiloAuth';

const API_HOST = 'api.hiloenergie.com';
const APIM_KEY = '20eeaedcb86945afa3fe792cea89b8bf';
const LOCATIONS_PATH = '/Automation/v1/api/Locations';

export type ChallengePhaseName = 'none' | 'preheat' | 'reduction' | 'recovery';
type ActivePhase = Exclude<ChallengePhaseName, 'none'>;

export type HiloLog = { info: (m: string) => void; debug: (m: string) => void; error: (m: string) => void };

export const NOT_LOGGED_IN =
  'Not logged in to Hilo. Open this plugin\'s settings in the Homebridge UI and choose "Log in to Hilo".';
export const LOGIN_EXPIRED =
  'The Hilo login has expired or was revoked. Open this plugin\'s settings in the Homebridge UI and log in to Hilo again.';

export class NotLoggedInError extends Error {}

export interface HiloLocation {
  id: string;        // numeric location id, used by the REST APIs
  hiloId: string;    // urn:hilo:crm:… (as shown in homebridge-hilo's logs)
  ratePlan: string;  // current rate: "Flex" (Flex D) or "CH" (Winter Credits); '' if not given
}

export interface PhaseWindow {
  start: number;     // epoch ms, inclusive
  end: number;       // epoch ms, exclusive
}

export interface ChallengeEvent {
  id: string;
  phases: Partial<Record<ActivePhase, PhaseWindow>>;
}

// Event progress values that mean the event will not (or no longer) run.
const FINISHED_PROGRESS = ['completed', 'cancelled', 'canceled'];

// When several phases overlap (two events back to back), the most restrictive one wins.
const PHASE_PRIORITY: ActivePhase[] = ['reduction', 'preheat', 'recovery'];

function parseUtc(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  // Hilo's times are UTC; some come without a zone designator
  const withZone = /([zZ]|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`;
  const ms = Date.parse(withZone);
  return Number.isNaN(ms) ? null : ms;
}

/** Events the user opted out of, or that are over or cancelled, never open a sensor. */
export function wontRun(event: Record<string, unknown>): boolean {
  if (event.isParticipating === false) return true;
  return typeof event.progress === 'string' && FINISHED_PROGRESS.includes(event.progress.toLowerCase());
}

/**
 * Turns one challenge event from Hilo's ChallengeHub into its phase windows. Phase keys
 * look like "preheatStartDateUTC" / "reductionEndDateUTC" (some API versions use a
 * "…Utc" suffix). Returns null for events that won't run or have no usable phases.
 */
export function normalizeEvent(raw: unknown): ChallengeEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const event = raw as Record<string, unknown>;
  if (wontRun(event)) return null;

  const rawPhases = event.phases;
  if (!rawPhases || typeof rawPhases !== 'object') return null;

  const times: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawPhases as Record<string, unknown>)) {
    const ms = parseUtc(value);
    if (ms !== null) times[key.toLowerCase().replace(/(dateutc|utc)$/, '')] = ms;
  }

  const phases: ChallengeEvent['phases'] = {};
  for (const phase of PHASE_PRIORITY) {
    const start = times[`${phase}start`];
    const end = times[`${phase}end`];
    if (start !== undefined && end !== undefined && end > start) phases[phase] = { start, end };
  }
  if (Object.keys(phases).length === 0) return null;
  return { id: String(event.id ?? '?'), phases };
}

/** The challenge phase in effect at `now`, from the scheduled phase windows. */
export function phaseAt(events: ChallengeEvent[], now: Date): ChallengePhaseName {
  const t = now.getTime();
  for (const phase of PHASE_PRIORITY) {
    if (events.some((e) => {
      const w = e.phases[phase];
      return w !== undefined && w.start <= t && t < w.end;
    })) {
      return phase;
    }
  }
  return 'none';
}

/** Hilo list responses are usually bare arrays; accept the common wrappers too. */
function asList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const key of ['items', 'value', 'locations']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}

/**
 * Picks the location to follow. `configured` may be the numeric location id or the
 * urn:hilo:crm:… id; without one, the account's first location is used.
 */
export function pickLocation(list: unknown[], configured?: string): HiloLocation {
  const locations = list
    .filter((l): l is Record<string, unknown> => !!l && typeof l === 'object')
    .filter((l) => l.id !== undefined && l.id !== null)
    .map((l) => ({ id: String(l.id), hiloId: typeof l.locationHiloId === 'string' ? l.locationHiloId : '', ratePlan: currentRatePlan(l.ratePlan) }));
  if (locations.length === 0) throw new Error('Hilo returned no locations for this account');

  const wanted = configured?.trim();
  if (!wanted) return locations[0];
  const match = locations.find((l) => l.id === wanted || l.hiloId === wanted);
  if (!match) {
    const known = locations.map((l) => `${l.id} (${l.hiloId || 'no URN'})`).join(', ');
    throw new Error(`Location "${wanted}" is not on this Hilo account. Locations found: ${known}`);
  }
  return match;
}

/** Locations give their rate as { current: "Flex", history: [...] }. */
function currentRatePlan(ratePlan: unknown): string {
  if (typeof ratePlan === 'string') return ratePlan;
  if (ratePlan && typeof ratePlan === 'object') {
    const current = (ratePlan as Record<string, unknown>).current;
    if (typeof current === 'string') return current;
  }
  return '';
}

export class HiloApi {
  private accessToken: string | null = null;
  private tokenExpiry = 0;
  private loginInFlight: Promise<void> | null = null;
  // A refresh token Hilo has rejected; not retried until a new login replaces it.
  private rejectedToken: string | null = null;

  constructor(
    // This plugin's own auth file (see hiloAuth.ts) — re-read before every token refresh,
    // so a new login from the settings page is picked up without a restart.
    private readonly authPath: string,
    private readonly log: HiloLog,
    private readonly request: HttpsRequester = httpsRequest,
  ) {}

  isLoggedIn(): boolean {
    return readAuthFile(this.authPath) !== null;
  }

  private async ensureToken(): Promise<void> {
    if (this.accessToken && Date.now() < this.tokenExpiry - 60_000) return;
    if (this.loginInFlight) return this.loginInFlight;
    this.loginInFlight = this.refreshAccessToken().finally(() => { this.loginInFlight = null; });
    return this.loginInFlight;
  }

  private async refreshAccessToken(): Promise<void> {
    const auth = readAuthFile(this.authPath);
    if (!auth) throw new NotLoggedInError(NOT_LOGGED_IN);
    if (auth.refreshToken === this.rejectedToken) throw new NotLoggedInError(LOGIN_EXPIRED);

    this.log.debug('Refreshing the Hilo access token');
    let tokens;
    try {
      tokens = await redeemRefreshToken(auth.refreshToken, this.request);
    } catch (err) {
      if (err instanceof TokenRequestError && err.invalidGrant) {
        this.rejectedToken = auth.refreshToken;
        throw new NotLoggedInError(LOGIN_EXPIRED);
      }
      throw err;
    }

    // Save the rotated token first: the old one may stop working now that it's been used.
    try {
      if (!saveRotatedToken(this.authPath, auth.sessionId, tokens.refreshToken)) {
        this.log.debug('A new Hilo login was saved meanwhile; using it from the next refresh');
      }
    } catch (err) {
      this.log.error(`Could not save the rotated Hilo token to ${this.authPath}: ${errorMessage(err)}`);
    }
    this.accessToken = tokens.accessToken;
    this.tokenExpiry = Date.now() + tokens.expiresIn * 1000;
    this.log.debug('Hilo access token refreshed');
  }

  private async apiGet(path: string): Promise<unknown> {
    await this.ensureToken();
    const res = await this.request('GET', API_HOST, path, {
      Authorization: `Bearer ${this.accessToken}`,
      'Ocp-Apim-Subscription-Key': APIM_KEY,
      Accept: 'application/json',
    });
    if (res.status === 401) this.accessToken = null; // refresh on the next call
    if (res.status >= 400) throw new Error(`GET ${path} failed: HTTP ${res.status}: ${res.data}`);
    return res.data.trim() === '' ? null : JSON.parse(res.data);
  }

  async getLocation(configured?: string): Promise<HiloLocation> {
    const data = await this.apiGet(LOCATIONS_PATH);
    return pickLocation(asList(data), configured);
  }

  /** A current access token, refreshed as needed (for the ChallengeHub connection). */
  async getAccessToken(): Promise<string> {
    await this.ensureToken();
    if (!this.accessToken) throw new Error('No Hilo access token');
    return this.accessToken;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
