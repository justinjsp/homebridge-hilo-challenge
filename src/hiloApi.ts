import * as https from 'https';
import * as querystring from 'querystring';

// Azure B2C auth config — same values as homebridge-hilo
const B2C_HOST = 'connexion.hiloenergie.com';
const B2C_TENANT = 'HiloDirectoryB2C.onmicrosoft.com';
const B2C_POLICY = 'B2C_1A_SIGN_IN';
const CLIENT_ID = '1ca9f585-4a55-4085-8e30-9746a65fa561';
const SCOPE = [
  'openid',
  'https://HiloDirectoryB2C.onmicrosoft.com/hiloapis/user_impersonation',
  'offline_access',
].join(' ');

const GRAPHQL_HOST = 'platform.hiloenergie.com';
const GRAPHQL_PATH = '/api/digital-twin/v3/graphql';
const APIM_KEY = '20eeaedcb86945afa3fe792cea89b8bf';

export type ChallengePhaseName = 'none' | 'preheat' | 'reduction' | 'recovery';

// GraphQL query — inline fragments for every device type that exposes gDState.
// gDState values observed: 'ACTIVE' (reduction), 'PRE_HEAT' (preheat),
// 'RECOVERY' (recovery), 'OFF' / absent (no challenge).
const GD_STATE_QUERY = `
  query GetLocationGDState($locationHiloId: String!) {
    getLocation(id: $locationHiloId) {
      devices {
        __typename
        ... on BasicThermostat        { gDState }
        ... on HeatingFloorThermostat { gDState }
        ... on LowVoltageThermostat   { gDState }
        ... on WaterHeater            { gDState }
      }
    }
  }
`;

function httpsRequest(
  method: string,
  hostname: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const reqHeaders: Record<string, string> = { ...headers };
    if (body) {
      reqHeaders['Content-Length'] = Buffer.byteLength(body).toString();
    }
    const req = https.request({ hostname, path, method, headers: reqHeaders }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface GraphQLResponse {
  data?: {
    getLocation?: {
      devices?: Array<{ __typename?: string; gDState?: string }>;
    };
  };
  errors?: Array<{ message: string }>;
}

export class HiloApi {
  private accessToken: string | null = null;
  private tokenExpiry = 0;
  private currentRefreshToken: string;
  private loginInFlight: Promise<void> | null = null;

  constructor(
    private refreshToken: string,
    private readonly log: { info: (m: string) => void; debug: (m: string) => void; error: (m: string) => void },
  ) {
    this.currentRefreshToken = refreshToken;
  }

  private async ensureToken(): Promise<void> {
    if (this.accessToken && Date.now() < this.tokenExpiry - 60_000) {
      return;
    }
    if (this.loginInFlight) return this.loginInFlight;
    this.loginInFlight = this.refreshAccessToken().finally(() => { this.loginInFlight = null; });
    return this.loginInFlight;
  }

  private async refreshAccessToken(): Promise<void> {
    this.log.debug('Refreshing Hilo access token');
    const body = querystring.stringify({
      grant_type: 'refresh_token',
      refresh_token: this.currentRefreshToken,
      client_id: CLIENT_ID,
      scope: SCOPE,
    });
    const path = `/${B2C_TENANT}/oauth2/v2.0/token?p=${B2C_POLICY}`;
    const res = await httpsRequest('POST', B2C_HOST, path, {
      'Content-Type': 'application/x-www-form-urlencoded',
    }, body);

    if (res.status >= 400) {
      throw new Error(`Token refresh failed: HTTP ${res.status}: ${res.data}`);
    }
    const json = JSON.parse(res.data) as TokenResponse;
    this.accessToken = json.access_token;
    this.currentRefreshToken = json.refresh_token ?? this.currentRefreshToken;
    this.tokenExpiry = Date.now() + json.expires_in * 1000;
    this.log.debug('Hilo access token refreshed');
  }

  private apiHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      'Ocp-Apim-Subscription-Key': APIM_KEY,
      'Content-Type': 'application/json',
    };
  }

  async getLocationId(): Promise<string> {
    await this.ensureToken();
    // Try known REST endpoint patterns. These may return 404 on newer API versions —
    // if so, set "locationId" manually in your config (see README).
    const candidates = [
      '/v2/api/Locations',
      '/GDService/v1/api/Locations',
      '/v1/api/Locations',
    ];
    for (const path of candidates) {
      this.log.debug(`Trying location endpoint: ${path}`);
      const res = await httpsRequest('GET', 'api.hiloenergie.com', path, this.apiHeaders());
      if (res.status === 200) {
        this.log.debug(`Locations response from ${path}: ${res.data}`);
        const data = JSON.parse(res.data);
        const locations: Array<{ id: string | number }> = Array.isArray(data)
          ? data
          : (data.items ?? data.locations ?? data.value ?? []);
        if (locations.length > 0) return String(locations[0].id);
      }
      this.log.debug(`${path} returned ${res.status}`);
    }
    throw new Error(
      'Could not auto-discover location ID. Add "locationId" to your config. ' +
      'You can find it in the homebridge-hilo logs — look for "Subscribed to updates for location".',
    );
  }

  /**
   * Query the Hilo GraphQL API for the current challenge phase.
   * Inspects the gDState field on each device in the location:
   *   ACTIVE   → reduction phase
   *   PRE_HEAT → preheat phase
   *   RECOVERY → recovery phase
   *   anything else (OFF, absent) → none
   *
   * Returns the first non-none phase found, or 'none' if no challenge is active.
   */
  async getChallengePhase(locationId: string): Promise<ChallengePhaseName> {
    await this.ensureToken();

    const requestBody = JSON.stringify({
      query: GD_STATE_QUERY,
      variables: { locationHiloId: locationId },
    });

    this.log.debug(`Querying Hilo GraphQL for gDState (location: ${locationId})`);
    const res = await httpsRequest('POST', GRAPHQL_HOST, GRAPHQL_PATH, this.apiHeaders(), requestBody);

    if (res.status >= 400) {
      throw new Error(`GraphQL request failed: HTTP ${res.status}: ${res.data}`);
    }

    const json = JSON.parse(res.data) as GraphQLResponse;

    if (json.errors?.length) {
      throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join(', ')}`);
    }

    const devices = json.data?.getLocation?.devices ?? [];
    this.log.debug(`GraphQL returned ${devices.length} device(s)`);

    for (const device of devices) {
      const state = device.gDState;
      if (!state || state === 'OFF') continue;
      this.log.debug(`Device ${device.__typename ?? 'unknown'} gDState: ${state}`);
      if (state === 'ACTIVE')   return 'reduction';
      if (state === 'PRE_HEAT') return 'preheat';
      if (state === 'RECOVERY') return 'recovery';
    }

    return 'none';
  }
}
