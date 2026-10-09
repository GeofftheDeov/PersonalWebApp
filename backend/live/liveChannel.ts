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
import { unreadCounts } from "../services/readState.js";

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
 *   - asks Threads which threads the person can see, at connect and again
 *     whenever a membership or friendship event names them (#105), and
 *     re-sends `ready` when a socket's set changes;
 *   - closes a socket with 4001 when its token expires (#105);
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
 * thread key, and call `deliver(threadKey, frame)` (or `deliverToPerson` for a
 * frame about one person, like `thread.read`). Adding a client → server
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
    | ThreadListFrame
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

/**
 * The thread list's frames (#102). `thread.updated` goes to every socket
 * subscribed to the thread, each with its own person's unread count;
 * `thread.read` goes to every socket of the one person who read.
 */
export type ThreadListFrame =
    | { type: "thread.updated"; thread: ThreadKey; lastActivityAt: string; unreadCount: number }
    | { type: "thread.read"; thread: ThreadKey; lastReadAt: string; lastReadMessageId: string | null; unreadCount: number };

interface Connection {
    ws: WebSocket;
    /** Set once the token checks out; the socket is only usable once `ready` is true too. */
    personId: string | null;
    /** True once this socket has been sent its first `ready`. */
    ready: boolean;
    threads: Set<ThreadKey>;
    alive: boolean;
    /** Closes the socket when its token expires (#105). */
    expiry?: ReturnType<typeof setTimeout>;
}

/** setTimeout's ceiling (about 24.8 days); longer waits re-arm. */
const MAX_TIMER_MS = 2 ** 31 - 1;

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
    /** person id → that person's authenticated connections (every device). */
    const byPerson = new Map<string, Set<Connection>>();
    const seen = new Set<string>();

    function deliver(thread: ThreadKey, frame: ServerFrame) {
        const subscribers = byThread.get(thread);
        if (!subscribers?.size) return;
        const data = JSON.stringify(frame);
        for (const conn of subscribers) {
            if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(data);
        }
    }

    /** Sends a frame to every ready socket of one person. */
    function deliverToPerson(personId: string, frame: ServerFrame) {
        const sockets = byPerson.get(personId);
        if (!sockets?.size) return;
        const data = JSON.stringify(frame);
        for (const conn of sockets) {
            if (conn.ready && conn.ws.readyState === WebSocket.OPEN) conn.ws.send(data);
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
        ...(await threadListSubscriptions()),
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
        // Subscriptions follow access events (#105), but an event can lag the
        // change (or be lost on Redis Pub/Sub), so check the access itself.
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

    /* ---------------------------------------------------------------- */
    /* The thread list (#102): thread.updated and thread.read            */
    /* ---------------------------------------------------------------- */

    /**
     * A new message changes its thread's last activity and every member's
     * unread count, so each socket subscribed to the thread gets
     * `thread.updated` with its own person's count (the sender's doesn't go
     * up: your own messages are never unread). A read reaches every socket of
     * the person who read, so their other devices clear the thread too.
     *
     * These listen to the same message events as `message.created`, under
     * their own dedupe key, so one frame kind never suppresses the other.
     */
    async function threadListSubscriptions(): Promise<Array<() => void>> {
        const updated = (thread: ThreadKey, lastActivityAt: string, eventId: string | undefined) => {
            if (!firstSighting(eventId && `thread.updated:${eventId}`)) return;
            deliverThreadUpdated(thread, lastActivityAt).catch((err) =>
                console.error("[live] thread.updated failed:", err.message));
        };
        return [
            await bus.subscribeBroadcast("gamenight.message", (payload, meta) =>
                updated(campaignThreadKey(payload.campaignId), payload.createdAt, meta?.id)),
            await bus.subscribeBroadcast("social.dm", (payload, meta) =>
                updated(dmThreadKey(String(payload.sender?.id), String(payload.recipientId)), payload.createdAt, meta?.id)),
            await bus.subscribeBroadcast("thread.read", (payload, meta) => {
                if (!firstSighting(meta?.id && `thread.read:${meta.id}`)) return;
                deliverToPerson(payload.personId, {
                    type: "thread.read",
                    thread: payload.threadKey,
                    lastReadAt: payload.lastReadAt,
                    lastReadMessageId: payload.lastReadMessageId,
                    unreadCount: payload.unreadCount,
                });
            }),
        ];
    }

    /** One unread-count query for everyone this process holds a socket for on the thread. */
    async function deliverThreadUpdated(thread: ThreadKey, lastActivityAt: string) {
        const people = new Map<string, Connection[]>();
        for (const conn of byThread.get(thread) ?? []) {
            if (!conn.personId) continue;
            if (!people.has(conn.personId)) people.set(conn.personId, []);
            people.get(conn.personId)!.push(conn);
        }
        if (!people.size) return;
        const counts = await unreadCounts(thread, [...people.keys()]);
        for (const [personId, sockets] of people) {
            const frame: ServerFrame = {
                type: "thread.updated",
                thread,
                lastActivityAt: new Date(lastActivityAt).toISOString(),
                unreadCount: counts.get(personId) ?? 0,
            };
            for (const conn of sockets) send(conn.ws, frame);
        }
    }

    function subscribe(conn: Connection, key: ThreadKey) {
        conn.threads.add(key);
        if (!byThread.has(key)) byThread.set(key, new Set());
        byThread.get(key)!.add(conn);
    }

    function unsubscribe(conn: Connection, key: ThreadKey) {
        conn.threads.delete(key);
        const set = byThread.get(key);
        set?.delete(conn);
        if (set && set.size === 0) byThread.delete(key);
    }

    function forget(conn: Connection) {
        connections.delete(conn);
        clearTimeout(conn.expiry);
        if (conn.personId) {
            const mine = byPerson.get(conn.personId);
            mine?.delete(conn);
            if (mine && mine.size === 0) byPerson.delete(conn.personId);
        }
        for (const key of [...conn.threads]) unsubscribe(conn, key);
    }

    /** Tells a socket the threads it is subscribed to now. */
    function announce(conn: Connection) {
        conn.ready = true;
        send(conn.ws, { type: "ready", v: PROTOCOL_VERSION, threads: [...conn.threads] });
    }

    /* ---------------------------------------------------------------- */
    /* Access follows membership and friendship (#105)                   */
    /* ---------------------------------------------------------------- */
    // A socket's threads are worked out from Threads (visibleThreadKeys) when
    // it connects, and again for the people an access event names: someone
    // joined or left a campaign, a campaign was deleted, two people became or
    // stopped being friends. Each socket whose set changed gets a fresh
    // `ready` listing it, on the same connection.
    //
    // Losing access is applied the moment the event arrives, from the event
    // alone, so nothing published after it (a message, typing) reaches the
    // person who left. Gaining access waits for the recompute, so a thread is
    // only ever added once the database says so.

    /**
     * People whose threads are being recomputed: `again` when another event
     * or connect came in meanwhile, `event` once an access event asked.
     */
    const refreshing = new Map<string, { again: boolean; event: boolean; done: Promise<void> }>();

    /**
     * Recomputes one person's threads and applies them to every socket of
     * theirs on this process. Runs one at a time per person: an event that
     * arrives during a recompute makes it run again, and a result read before
     * that event is thrown away rather than applied. Never rejects. If the
     * threads can't be worked out, sockets still waiting for their first
     * `ready` close with 1011 (the client retries); after an access event,
     * so do the person's other sockets, which would otherwise miss the
     * change until they reconnect. A connect alone leaves those alone.
     */
    function refreshPerson(personId: string, { event = false } = {}): Promise<void> {
        const running = refreshing.get(personId);
        if (running) {
            running.again = true;
            running.event ||= event;
            return running.done;
        }
        const state = { again: true, event, done: Promise.resolve() };
        refreshing.set(personId, state);
        state.done = (async () => {
            try {
                while (state.again) {
                    state.again = false;
                    let threads: ThreadKey[];
                    try {
                        threads = await visibleThreadKeys({ id: personId });
                    } catch (err: any) {
                        console.error("[live] could not work out threads:", err?.message);
                        for (const conn of byPerson.get(personId) ?? []) {
                            if (!conn.ready || state.event) conn.ws.close(1011, "server error");
                        }
                        return;
                    }
                    if (!state.again) applyThreads(personId, threads);
                }
            } finally {
                refreshing.delete(personId);
            }
        })();
        return state.done;
    }

    function applyThreads(personId: string, threads: ThreadKey[]) {
        const next = new Set(threads);
        for (const conn of byPerson.get(personId) ?? []) {
            if (conn.ws.readyState !== WebSocket.OPEN) continue;
            let changed = false;
            for (const key of [...conn.threads]) if (!next.has(key)) { unsubscribe(conn, key); changed = true; }
            for (const key of next) if (!conn.threads.has(key)) { subscribe(conn, key); changed = true; }
            if (changed || !conn.ready) announce(conn);
        }
    }

    /** Takes a thread off every socket of one person straight away. */
    function revoke(personId: string, thread: ThreadKey) {
        for (const conn of byPerson.get(personId) ?? []) {
            if (!conn.threads.has(thread)) continue;
            unsubscribe(conn, thread);
            if (conn.ready) announce(conn);
        }
    }

    function refreshAll(people: Iterable<string>) {
        for (const personId of new Set(people)) {
            if (byPerson.has(personId)) void refreshPerson(personId, { event: true });
        }
    }

    // No `firstSighting`: these are idempotent (a duplicate costs one more
    // recompute), and their ids would crowd message ids out of the seen set.
    unsubscribes.push(
        await bus.subscribeBroadcast("campaign.changed", ({ campaignId, action, personId }) => {
            const thread = campaignThreadKey(String(campaignId));
            if (action === "deleted" || (action === "member-removed" && !personId)) {
                const people = [...(byThread.get(thread) ?? [])].map((conn) => conn.personId!);
                for (const id of people) revoke(id, thread);
                refreshAll(people);
            } else if (action === "member-removed") {
                revoke(String(personId), thread);
                refreshAll([String(personId)]);
            } else if ((action === "member-added" || action === "created") && personId) {
                refreshAll([String(personId)]);
            }
            // "updated": a campaign's details, not who is in it.
        }),
        await bus.subscribeBroadcast("friendship.changed", ({ personIds, action }) => {
            const [a, b] = (personIds ?? []).map(String);
            if (!a || !b || a === b) return;
            if (action === "removed") {
                const thread = dmThreadKey(a, b);
                revoke(a, thread);
                revoke(b, thread);
            }
            refreshAll([a, b]);
        }),
    );

    /** Closes the socket with 4001 once its token's `exp` passes, so a socket can't outlive its token. */
    function closeAtExpiry(conn: Connection, exp: unknown) {
        if (typeof exp !== "number") return;
        const check = () => {
            const left = exp * 1000 - Date.now();
            if (left <= 0) return conn.ws.close(CLOSE_UNAUTHORIZED, "token expired");
            conn.expiry = setTimeout(check, Math.min(left, MAX_TIMER_MS));
            conn.expiry.unref?.();
        };
        check();
    }
    /* ---------------- end access ---------------- */

    async function authenticate(conn: Connection, token: unknown) {
        let personId: string | null = null;
        let exp: unknown;
        try {
            if (typeof token !== "string" || !token) throw new Error("no token");
            const decoded = verifyJwt(token);
            exp = decoded.exp;
            personId = await resolveAccountId(String(decoded.id));
        } catch {
            personId = null;
        }
        if (conn.ws.readyState !== WebSocket.OPEN) return;
        if (!personId) return conn.ws.close(CLOSE_UNAUTHORIZED, "unauthorized");

        // Registered before its threads are read, so an access event that
        // arrives meanwhile reaches this socket too (by making the read run
        // again). Nothing is sent to it before its first `ready`.
        conn.personId = personId;
        if (!byPerson.has(personId)) byPerson.set(personId, new Set());
        byPerson.get(personId)!.add(conn);
        closeAtExpiry(conn, exp);
        await refreshPerson(personId);
    }

    wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
        const conn: Connection = { ws, personId: null, ready: false, threads: new Set(), alive: true };
        connections.add(conn);
        let authStarted = false;

        // Covers the whole handshake: no auth frame in time is "unauthorized";
        // an auth that stalls (a slow database) is a server error, so the client retries.
        const authTimer = setTimeout(() => {
            if (conn.ready || ws.readyState !== WebSocket.OPEN) return;
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
            byPerson.clear();
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
