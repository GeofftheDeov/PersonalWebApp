import type { IncomingMessage, Server as HttpServer } from "http";
import type { Server as HttpsServer } from "https";
import type { Duplex } from "stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { bus as defaultBus, type EventBus, type EventMap } from "../events/index.js";
import { verifyJwt } from "../utils/jwt.js";
import { resolveAccountId } from "../utils/accountRefs.js";
import { campaignThreadKey, dmThreadKey, visibleThreadKeys, type ThreadKey } from "../services/threads.js";
import { canAccessThread } from "../services/threads.js";
import { findPersonById, personDisplayName } from "../utils/personUtils.js";

/**
 * The live channel (#98, spec #58): one authenticated WebSocket per person,
 * carrying live events for the threads that person can see. The wire protocol
 * is written down in PROTOCOL.md beside this file; change the two together.
 *
 * What it does:
 *   - takes upgrades on LIVE_PATH (under /api, so it stays same-origin behind
 *     the frontend's rewrite);
 *   - authenticates with the JWT from the first frame (or, less preferred, the
 *     `token` query parameter), through utils/jwt.ts like every other route;
 *   - asks Threads which threads the person can see, once, at connect;
 *   - listens on broadcast bus subscriptions (campaign messages and friend
 *     DMs), so every backend task sees every message event, and forwards each
 *     one only to sockets subscribed to its thread;
 *   - pings every 25 seconds and drops a socket that has sent nothing since
 *     the previous ping.
 *
 * It knows nothing about message storage: events in, frames out.
 *
 * Adding a server → client frame type: subscribe to its bus event in
 * `attachLiveChannel` (subscribeBroadcast), map the payload to a frame and a
 * thread key, and call `deliver(threadKey, frame)`. Adding a client → server
 * frame type: handle it in `onFrame`, and check `canAccessThread` before
 * acting on any thread key a client names.
 */

export const LIVE_PATH = "/api/live";
export const PROTOCOL_VERSION = 1;

/** The token was missing, malformed, expired, signed with another secret, or names no account. */
export const CLOSE_UNAUTHORIZED = 4001;
/** The auth frame asked for a protocol version this server doesn't speak. */
export const CLOSE_UNSUPPORTED_VERSION = 4002;

export const DEFAULT_PING_INTERVAL_MS = 25_000;
/** How long a `typing` frame shows without a refresh (#103). Clients refresh every 3 s. */
export const TYPING_EXPIRES_IN_MS = 5_000;
/**
 * Typing frames for one thread on one socket closer together than this are
 * dropped: flood control only. Kept well under a second, because a client
 * resets its 3 s throttle when its person sends, and the first keystroke of
 * the next message can follow the last frame closely.
 */
export const TYPING_MIN_INTERVAL_MS = 250;
export const DEFAULT_AUTH_TIMEOUT_MS = 10_000;
/** Client frames are tiny (auth, pong, later typing); anything bigger is not ours. */
const MAX_FRAME_BYTES = 16 * 1024;
/** Recent event ids, so an event that reaches this process twice is sent once. */
const SEEN_EVENT_IDS = 1_000;

export interface LiveChannelOptions {
    path?: string;
    bus?: EventBus;
    pingIntervalMs?: number;
    authTimeoutMs?: number;
}

export interface LiveChannel {
    /** Closes every socket (1001, going away) and stops listening on the bus. */
    close(): Promise<void>;
}

/** The message as clients see it. No email address: other people don't need it. */
export interface LiveMessage {
    id: string;
    sender: { id: string; name: string };
    body: string;
    createdAt: string;
    eventId?: string;
}

export type ServerFrame =
    | { type: "ready"; v: number; threads: ThreadKey[] }
    | { type: "message.created"; thread: ThreadKey; message: LiveMessage }
    | { type: "ping" }
    | TypingFrame;

/** Someone else is typing in a thread you can see (#103). */
export interface TypingFrame {
    type: "typing";
    thread: ThreadKey;
    personId: string;
    name: string;
    expiresInMs: number;
}

interface Connection {
    ws: WebSocket;
    personId: string | null;
    threads: Set<ThreadKey>;
    alive: boolean;
}

type AnyServer = HttpServer | HttpsServer;

export async function attachLiveChannel(
    servers: AnyServer | AnyServer[],
    options: LiveChannelOptions = {},
): Promise<LiveChannel> {
    const path = options.path ?? LIVE_PATH;
    const bus = options.bus ?? defaultBus;
    const pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    const authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;

    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
    const connections = new Set<Connection>();
    /** thread key → the authenticated connections subscribed to it. */
    const byThread = new Map<ThreadKey, Set<Connection>>();
    const seen = new Set<string>();

    function deliver(thread: ThreadKey, frame: ServerFrame) {
        const subscribers = byThread.get(thread);
        if (!subscribers?.size) return;
        const data = JSON.stringify(frame);
        for (const conn of subscribers) {
            if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(data);
        }
    }

    /** True the first time an event id is seen; at-most-once per process. */
    function firstSighting(id: string | undefined): boolean {
        if (!id) return true;
        if (seen.has(id)) return false;
        seen.add(id);
        if (seen.size > SEEN_EVENT_IDS) seen.delete(seen.values().next().value as string);
        return true;
    }

    const unsubscribes = [
        await bus.subscribeBroadcast("gamenight.message", (payload, meta) => {
            if (!firstSighting(meta?.id)) return;
            deliver(campaignThreadKey(payload.campaignId), {
                type: "message.created",
                thread: campaignThreadKey(payload.campaignId),
                message: liveMessage(payload),
            });
        }),
        // A DM thread's subscribers are its pair (every device of each) and nobody else.
        await bus.subscribeBroadcast("social.dm", (payload, meta) => {
            if (!firstSighting(meta?.id)) return;
            const thread = dmThreadKey(String(payload.sender?.id), String(payload.recipientId));
            deliver(thread, { type: "message.created", thread, message: liveMessage(payload) });
        }),
    ];

    /* ---------------- typing (#103) ---------------- */
    // A client's `typing` frame is checked, then published on the bus's
    // ephemeral path, so it reaches the thread on every backend task and is
    // never stored. Each process delivers it to the thread's subscribers
    // except the typist's own sockets: nobody needs to see themselves typing.

    /** Per connection: the display name (looked up once) and when each thread last accepted a frame. */
    const typists = new WeakMap<Connection, { name?: Promise<string>; lastAt: Map<ThreadKey, number> }>();

    // No `firstSighting` here: a typing event is published once, a duplicate
    // would only refresh an indicator, and its ids would crowd message ids out
    // of the shared seen set.
    unsubscribes.push(await bus.subscribeBroadcast("letters.typing", (payload) => {
        const frame: TypingFrame = {
            type: "typing",
            thread: payload.threadKey,
            personId: payload.personId,
            name: payload.name,
            expiresInMs: payload.expiresInMs,
        };
        const data = JSON.stringify(frame);
        for (const conn of byThread.get(payload.threadKey) ?? []) {
            if (conn.personId === payload.personId) continue;
            if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(data);
        }
    }));

    async function onTyping(conn: Connection, thread: unknown) {
        const personId = conn.personId;
        // Only threads this socket is subscribed to: nobody else could see the
        // typing anyway, and it bounds what an arbitrary key can cost (the
        // guard map below, the access check).
        if (!personId || typeof thread !== "string" || !conn.threads.has(thread)) return;
        let state = typists.get(conn);
        if (!state) typists.set(conn, (state = { lastAt: new Map() }));
        // Clients send at most one frame every 3 s (sooner only after sending
        // a message); a flood is dropped here, before it costs an access check.
        const now = Date.now();
        if (now - (state.lastAt.get(thread) ?? -Infinity) < TYPING_MIN_INTERVAL_MS) return;
        state.lastAt.set(thread, now);
        // Subscriptions are fixed at connect; access may have ended since (a campaign left).
        if (!(await canAccessThread({ id: personId }, thread))) return;
        const lookup = state.name ??= findPersonById(personId, "name firstName lastName handle email")
            .then((person) => personDisplayName(person?.doc));
        let name: string;
        try {
            name = await lookup;
        } catch (err) {
            if (state.name === lookup) state.name = undefined; // try again on the next frame
            throw err;
        }
        await bus.publishEphemeral("letters.typing", {
            threadKey: thread,
            personId,
            name,
            expiresInMs: TYPING_EXPIRES_IN_MS,
        });
    }
    /* ---------------- end typing ---------------- */

    function subscribe(conn: Connection, threads: ThreadKey[]) {
        for (const key of threads) {
            conn.threads.add(key);
            if (!byThread.has(key)) byThread.set(key, new Set());
            byThread.get(key)!.add(conn);
        }
    }

    function forget(conn: Connection) {
        connections.delete(conn);
        for (const key of conn.threads) {
            const set = byThread.get(key);
            set?.delete(conn);
            if (set && set.size === 0) byThread.delete(key);
        }
        conn.threads.clear();
    }

    async function authenticate(conn: Connection, token: unknown) {
        let personId: string | null = null;
        try {
            if (typeof token !== "string" || !token) throw new Error("no token");
            const decoded = verifyJwt(token);
            personId = await resolveAccountId(String(decoded.id));
        } catch {
            personId = null;
        }
        if (conn.ws.readyState !== WebSocket.OPEN) return;
        if (!personId) return conn.ws.close(CLOSE_UNAUTHORIZED, "unauthorized");

        let threads: ThreadKey[];
        try {
            threads = await visibleThreadKeys({ id: personId });
        } catch (err: any) {
            console.error("[live] could not work out threads:", err.message);
            return conn.ws.close(1011, "server error");
        }
        if (conn.ws.readyState !== WebSocket.OPEN) return;
        conn.personId = personId;
        subscribe(conn, threads);
        send(conn.ws, { type: "ready", v: PROTOCOL_VERSION, threads });
    }

    wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
        const conn: Connection = { ws, personId: null, threads: new Set(), alive: true };
        connections.add(conn);
        let authStarted = false;

        // Covers the whole handshake: no auth frame in time is "unauthorized";
        // an auth that stalls (a slow database) is a server error, so the client retries.
        const authTimer = setTimeout(() => {
            if (conn.personId || ws.readyState !== WebSocket.OPEN) return;
            if (authStarted) ws.close(1011, "auth timed out");
            else ws.close(CLOSE_UNAUTHORIZED, "auth timeout");
        }, authTimeoutMs);

        const startAuth = (token: unknown) => {
            authStarted = true;
            authenticate(conn, token)
                .catch((err) => {
                    console.error("[live] auth failed unexpectedly:", err);
                    if (ws.readyState === WebSocket.OPEN) ws.close(1011, "server error");
                })
                .finally(() => clearTimeout(authTimer));
        };

        // The query parameter is accepted but not preferred: URLs end up in logs.
        const queryToken = new URL(req.url ?? "/", "http://live").searchParams.get("token");
        if (queryToken) startAuth(queryToken);

        ws.on("message", (data: RawData) => {
            conn.alive = true;
            let frame: any;
            try {
                frame = JSON.parse(String(data));
            } catch {
                frame = null;
            }
            if (!authStarted) {
                if (frame?.type === "auth" && frame.v !== undefined && frame.v !== PROTOCOL_VERSION) {
                    authStarted = true;
                    clearTimeout(authTimer);
                    return ws.close(CLOSE_UNSUPPORTED_VERSION, "unsupported protocol version");
                }
                // Anything but a well-formed auth frame counts as "no token".
                return startAuth(frame?.type === "auth" ? frame.token : undefined);
            }
            onFrame(conn, frame);
        });

        ws.on("close", () => {
            clearTimeout(authTimer);
            forget(conn);
        });
        ws.on("error", () => { /* followed by close */ });
    });

    /** Client → server frames after auth. `pong` needs nothing beyond marking the socket alive. */
    function onFrame(conn: Connection, frame: any) {
        /* pong: handled by `alive`; unknown types are ignored for forward compatibility */
        if (frame?.type === "typing") {
            onTyping(conn, frame.thread).catch((err) => console.error("[live] typing failed:", err?.message));
        }
    }

    const heartbeat = setInterval(() => {
        for (const conn of connections) {
            if (!conn.alive) {
                conn.ws.terminate();
                forget(conn);
                continue;
            }
            conn.alive = false;
            send(conn.ws, { type: "ping" });
        }
    }, pingIntervalMs);
    heartbeat.unref?.();

    function onUpgrade(this: AnyServer, req: IncomingMessage, socket: Duplex, head: Buffer) {
        let pathname: string | null = null;
        try {
            pathname = new URL(req.url ?? "/", "http://live").pathname;
        } catch {
            /* not ours */
        }
        if (pathname !== path) {
            // Someone else's upgrade, if anyone else listens; otherwise nobody
            // will ever answer it, so don't leave the socket hanging.
            if (this.listenerCount("upgrade") <= 1) socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    }
    const serverList = Array.isArray(servers) ? servers : [servers];
    for (const s of serverList) s.on("upgrade", onUpgrade);

    return {
        async close() {
            clearInterval(heartbeat);
            for (const s of serverList) s.off("upgrade", onUpgrade);
            for (const unsubscribe of unsubscribes) unsubscribe();
            for (const conn of connections) conn.ws.close(1001, "server shutting down");
            connections.clear();
            byThread.clear();
            await new Promise<void>((resolve) => wss.close(() => resolve()));
        },
    };
}

function send(ws: WebSocket, frame: ServerFrame) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

/** Campaign messages and DMs share one frame shape; only campaign messages can name an event. */
function liveMessage(payload: EventMap["gamenight.message"] | EventMap["social.dm"]): LiveMessage {
    return {
        id: payload.messageId,
        sender: { id: String(payload.sender?.id), name: String(payload.sender?.name ?? "") },
        body: payload.body,
        createdAt: payload.createdAt,
        ...("eventId" in payload && payload.eventId ? { eventId: payload.eventId } : {}),
    };
}
