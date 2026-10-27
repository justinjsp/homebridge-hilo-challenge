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
exports.ChallengeHub = exports.signalRConnector = exports.RESYNC_MS = exports.HUB_URL = void 0;
const signalR = __importStar(require("@microsoft/signalr"));
const hiloApi_1 = require("./hiloApi");
// Hilo's challenge hub (SignalR). The REST events endpoint it replaced is gone; the
// phase windows of each challenge now come only from here, as in the Home Assistant
// Hilo integration (python-hilo). Hilo redirects the connection to its Azure SignalR
// service, which the official client follows on its own.
exports.HUB_URL = 'https://api.hiloenergie.com/ChallengeHub';
// The event list is asked for again this often while connected, so a subscription the
// server silently dropped can't leave the schedule stale for long.
exports.RESYNC_MS = 15 * 60000;
// Waits between connection attempts: 30 s, doubling up to 10 minutes.
const RETRY_FIRST_MS = 30000;
const RETRY_MAX_MS = 10 * 60000;
const signalRConnector = (accessToken, log) => new signalR.HubConnectionBuilder()
    .withUrl(exports.HUB_URL, { accessTokenFactory: accessToken })
    // The client's own messages go to the debug log; this class reports what matters.
    .configureLogging({ log: (level, message) => { if (level >= signalR.LogLevel.Warning)
        log.debug(`ChallengeHub: ${message}`); } })
    .build();
exports.signalRConnector = signalRConnector;
// Messages that carry one challenge's full record, phases included
const DETAIL_TARGETS = [
    'EventCHDetailsInitialValuesReceived', 'EventCHDetailsUpdatedValuesReceived',
    'EventFlexDetailsInitialValuesReceived', 'EventFlexDetailsUpdatedValuesReceived',
];
/**
 * Keeps the location's challenge schedule up to date from Hilo's ChallengeHub: connects,
 * subscribes to the event list and to the details of each upcoming challenge, and merges
 * what Hilo pushes. Reconnection is driven by tick(), which the platform calls at every poll.
 */
class ChallengeHub {
    constructor(location, accessToken, log, now, connector = exports.signalRConnector) {
        this.location = location;
        this.accessToken = accessToken;
        this.log = log;
        this.now = now;
        this.connector = connector;
        this.connection = null;
        this.connecting = null;
        this.connected = false;
        this.running = false;
        this.everConnected = false;
        this.failures = 0;
        this.nextAttemptAt = 0;
        this.lastListAt = 0;
        this.listReceived = false;
        this.events = new Map();
        this.detailsRequested = new Set();
        /** Why the hub isn't delivering the schedule, or null when it is. */
        this.lastError = null;
        /** True when lastError is about the Hilo login rather than the connection. */
        this.lastErrorIsLogin = false;
    }
    get isRunning() {
        return this.running;
    }
    get isConnected() {
        return this.connected;
    }
    /** True once Hilo has sent the event list (on any connection so far). */
    get hasSchedule() {
        return this.listReceived;
    }
    /** The challenges that will run or are running, with their phase windows. */
    schedule() {
        const result = [];
        for (const raw of this.events.values()) {
            const event = (0, hiloApi_1.normalizeEvent)(raw);
            if (event)
                result.push(event);
        }
        return result;
    }
    /** Starts following the hub; resolves after the first connection attempt. */
    async start() {
        if (this.running)
            return;
        this.running = true;
        this.failures = 0;
        await this.connectOnce();
    }
    async stop() {
        this.running = false;
        const connection = this.connection;
        this.connection = null;
        this.connected = false;
        if (connection) {
            try {
                await connection.stop();
            }
            catch {
                // already closed
            }
        }
    }
    /** Reconnects when it's time to, and asks for the list again when it's due. */
    async tick() {
        if (!this.running)
            return;
        const now = this.now().getTime();
        if (!this.connection) {
            if (now >= this.nextAttemptAt)
                await this.connectOnce();
        }
        else if (this.connected && now - this.lastListAt >= exports.RESYNC_MS) {
            await this.subscribeToList(this.connection);
        }
    }
    connectOnce() {
        this.connecting = this.connecting ?? this.connect().finally(() => { this.connecting = null; });
        return this.connecting;
    }
    async connect() {
        try {
            // Checked first, so a missing login is reported as such and costs no connection
            await this.accessToken();
        }
        catch (err) {
            this.failed(err);
            return;
        }
        if (!this.running)
            return; // stopped meanwhile
        const connection = this.connector(this.accessToken, this.log);
        this.connection = connection;
        this.detailsRequested.clear();
        connection.on('EventListInitialValuesReceived', (list) => this.onList(list, true));
        connection.on('EventListUpdatedValuesReceived', (list) => this.onList(list, false));
        connection.on('EventAdded', (event) => this.onEvents([event]));
        for (const target of DETAIL_TARGETS) {
            connection.on(target, (event) => this.onEvents([event], false));
        }
        connection.onclose((error) => {
            if (this.connection !== connection)
                return; // stopped on purpose, or replaced
            this.connection = null;
            this.connected = false;
            if (this.running) {
                this.failed(new Error(`Connection to Hilo's ChallengeHub lost${error ? `: ${error.message}` : ''}`));
            }
        });
        try {
            await connection.start();
        }
        catch (err) {
            if (this.connection === connection) {
                this.connection = null;
                this.failed(new Error(`Could not connect to Hilo's ChallengeHub: ${(0, hiloApi_1.errorMessage)(err)}`));
            }
            return;
        }
        if (this.connection !== connection) {
            await connection.stop().catch(() => undefined); // stopped while connecting
            return;
        }
        this.connected = true;
        this.failures = 0;
        this.lastError = null;
        this.lastErrorIsLogin = false;
        this.log.info(this.everConnected ? 'Reconnected to Hilo\'s ChallengeHub' : 'Connected to Hilo\'s ChallengeHub');
        this.everConnected = true;
        await this.subscribeToList(connection);
    }
    failed(err) {
        this.lastError = (0, hiloApi_1.errorMessage)(err);
        this.lastErrorIsLogin = err instanceof hiloApi_1.NotLoggedInError;
        const wait = Math.min(RETRY_FIRST_MS * 2 ** this.failures, RETRY_MAX_MS);
        this.failures++;
        this.nextAttemptAt = this.now().getTime() + wait;
    }
    async subscribeToList(connection) {
        this.lastListAt = this.now().getTime();
        await this.send(connection, 'SubscribeToEventList', { locationHiloId: this.location.hiloId });
    }
    async send(connection, method, arg) {
        try {
            await connection.send(method, arg);
        }
        catch (err) {
            // The close handler takes care of a dropped connection
            this.log.debug(`ChallengeHub: ${method} failed: ${(0, hiloApi_1.errorMessage)(err)}`);
        }
    }
    onList(list, initial) {
        if (!Array.isArray(list)) {
            this.log.debug(`ChallengeHub: unexpected event list: ${JSON.stringify(list)}`);
            return;
        }
        if (initial) {
            // A full list: anything not in it is no longer scheduled
            const known = new Map(this.events);
            this.events.clear();
            for (const item of list) {
                const id = eventId(item);
                if (id !== null)
                    this.events.set(id, { ...known.get(id) });
            }
            this.listReceived = true;
        }
        this.onEvents(list);
    }
    /** Merges events into the schedule, and subscribes to the details of upcoming ones. */
    onEvents(items, requestDetails = true) {
        for (const item of items) {
            const id = eventId(item);
            if (id === null)
                continue;
            const merged = { ...this.events.get(id), ...item };
            this.events.set(id, merged);
            if (requestDetails && !(0, hiloApi_1.wontRun)(merged) && !this.detailsRequested.has(id) && this.connection && this.connected) {
                this.detailsRequested.add(id);
                void this.send(this.connection, this.detailsMethod(), {
                    locationHiloId: this.location.hiloId,
                    eventId: item.id,
                });
            }
        }
    }
    // Each rate has its own detail subscription; anything that isn't Flex D is Winter Credits
    detailsMethod() {
        return /flex/i.test(this.location.ratePlan) ? 'SubscribeToEventFlex' : 'SubscribeToEventCH';
    }
}
exports.ChallengeHub = ChallengeHub;
function eventId(item) {
    if (!item || typeof item !== 'object')
        return null;
    const id = item.id;
    return id === undefined || id === null ? null : String(id);
}
//# sourceMappingURL=challengeHub.js.map