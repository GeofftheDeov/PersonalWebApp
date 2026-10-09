/**
 * The live channel client (#98, spec #58): one WebSocket per person, shared by
 * every thread on the page. Headless and framework-free, with no imports, so
 * #69's shared package can lift it as is and a backend test can drive it with
 * the `ws` package. The wire protocol is in backend/live/PROTOCOL.md.
 *
 * - Authenticates with the JWT in the first frame (`{ type: "auth", v, token }`).
 * - Answers `ping` with `pong`, and treats a silent socket as dead.
 * - Reconnects with exponential backoff and full jitter, except after an auth
 *   or protocol-version refusal: retrying with the same token can't help.
 * - Dispatches `message.created` to the handlers subscribed to its thread.
 * - Sends `typing` (`sendTyping`) and dispatches others' `typing` to `onTyping` (#103).
 * - There is no server-side replay. After a reconnect every subscriber's
 *   `onReconnect` runs so the open thread can refetch its latest page.
 *
 * The connection opens with the first subscription and closes a little after
 * the last one goes (so moving between pages doesn't churn the socket).
 */

export const PROTOCOL_VERSION = 1;
export const CLOSE_UNAUTHORIZED = 4001;
export const CLOSE_UNSUPPORTED_VERSION = 4002;

export type LiveStatus = "idle" | "connecting" | "open" | "offline" | "unauthorized";
/** A thread's own status: `unavailable` when the socket is open but the server didn't subscribe it to that thread. */
export type ThreadStatus = LiveStatus | "unavailable";

export interface LiveMessage {
    id: string;
    sender: { id: string; name: string };
    body: string;
    createdAt: string;
    eventId?: string;
}

/** Someone else is typing in a thread (#103); the server never sends you your own. */
export interface LiveTyping {
    personId: string;
    name: string;
    expiresInMs: number;
}

export interface ThreadHandlers {
    onMessage?: (message: LiveMessage, thread: string) => void;
    /** The socket came back after a drop: refetch, since nothing is replayed. */
    onReconnect?: () => void;
    /** A `typing` frame for this thread (#103). typing.ts turns these into an indicator. */
    onTyping?: (typing: LiveTyping, thread: string) => void;
}

/** The slice of the browser WebSocket this client uses; `ws` fits it too. */
interface SocketLike {
    readyState: number;
    onopen: ((ev: any) => void) | null;
    onmessage: ((ev: { data: any }) => void) | null;
    onclose: ((ev: { code: number }) => void) | null;
    onerror: ((ev: any) => void) | null;
    send(data: string): void;
    close(code?: number, reason?: string): void;
}
type SocketCtor = new (url: string) => SocketLike;

export interface LiveClientOptions {
    url: string | (() => string);
    /** The current JWT, or null when signed out (then nothing connects). */
    getToken: () => string | null;
    WebSocket?: SocketCtor;
    backoff?: { baseMs?: number; maxMs?: number };
    /** No frame for this long means the socket is dead (the server pings every 25 s). */
    staleAfterMs?: number;
    /** How long to keep the socket after the last subscription goes. */
    idleCloseMs?: number;
    random?: () => number;
}

const OPEN = 1;

export class LiveClient {
    status: LiveStatus = "idle";

    private opts: Required<Omit<LiveClientOptions, "WebSocket" | "backoff">> & {
        WebSocket?: SocketCtor;
        baseMs: number;
        maxMs: number;
    };
    private socket: SocketLike | null = null;
    private threads = new Map<string, Set<ThreadHandlers>>();
    /** The thread keys the server's last `ready` subscribed this socket to. */
    private serverThreads = new Set<string>();
    /** Threads that already cost one reconnect while subscribed (see `subscribe`); not retried until re-subscribed. */
    private refreshedFor = new Set<string>();
    private statusListeners = new Set<(status: LiveStatus) => void>();
    private attempt = 0;
    private everReady = false;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private staleTimer: ReturnType<typeof setTimeout> | null = null;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private removeOnline: (() => void) | null = null;

    constructor(options: LiveClientOptions) {
        this.opts = {
            url: options.url,
            getToken: options.getToken,
            WebSocket: options.WebSocket,
            baseMs: options.backoff?.baseMs ?? 500,
            maxMs: options.backoff?.maxMs ?? 30_000,
            staleAfterMs: options.staleAfterMs ?? 60_000,
            idleCloseMs: options.idleCloseMs ?? 5_000,
            random: options.random ?? Math.random,
        };
    }

    /**
     * Listen to `message.created` for one thread. Connects if needed.
     *
     * The server works out a socket's threads once, at connect, so a thread
     * that became visible since (a friend just added, a campaign just joined)
     * is missing from the open socket. Subscribing to such a thread reconnects
     * once to pick it up; if it is still missing after that, it really is
     * unavailable, and stays so without further retries until it is
     * subscribed afresh. (#105 will have the server follow these changes live.)
     */
    subscribe(thread: string, handlers: ThreadHandlers): () => void {
        if (!this.threads.has(thread)) this.threads.set(thread, new Set());
        this.threads.get(thread)!.add(handlers);
        this.cancelIdleClose();
        if (this.status === "idle" || this.status === "unauthorized") this.connect();
        else if (this.status === "open" && !this.serverThreads.has(thread) && !this.refreshedFor.has(thread)) {
            this.refreshedFor.add(thread);
            this.reopen();
        }
        return () => {
            const set = this.threads.get(thread);
            set?.delete(handlers);
            if (set && set.size === 0) {
                this.threads.delete(thread);
                this.refreshedFor.delete(thread);
            }
            if (this.threads.size === 0) this.scheduleIdleClose();
        };
    }

    /** Replace the open socket with a new one straight away, so the server works out its threads again. */
    private reopen() {
        const socket = this.socket;
        if (!socket) return;
        this.socket = null;
        this.clearStale();
        socket.onclose = null;
        socket.onmessage = null; // frames still in flight on the old socket would duplicate the new one's
        try { socket.close(1000, "refreshing threads"); } catch { /* already gone */ }
        this.connect();
    }

    /**
     * Whether live events for this thread are flowing. The server works out a
     * socket's threads when it connects, so a thread it left out (one joined
     * since, or a campaign an admin views without being a member) reports
     * `unavailable` rather than `open`.
     */
    threadStatus(thread: string): ThreadStatus {
        if (this.status !== "open") return this.status;
        return this.serverThreads.has(thread) ? "open" : "unavailable";
    }

    /**
     * Tell the thread's other members you're typing (#103). Sends straight
     * away; throttling to one frame every 3 s is the caller's job (see
     * typing.ts). Returns false when there is no open socket to send on.
     */
    sendTyping(thread: string): boolean {
        const socket = this.socket;
        if (this.status !== "open" || !socket || socket.readyState !== OPEN) return false;
        socket.send(JSON.stringify({ type: "typing", thread }));
        return true;
    }

    onStatus(listener: (status: LiveStatus) => void): () => void {
        this.statusListeners.add(listener);
        return () => this.statusListeners.delete(listener);
    }

    /** Open the socket now (a no-op while one is open or connecting). */
    connect(): void {
        if (this.socket) return;
        this.clearReconnect();
        const token = this.opts.getToken();
        if (!token) return this.setStatus("idle");
        const Ctor = this.opts.WebSocket ?? (globalThis as any).WebSocket;
        if (!Ctor) return this.setStatus("idle");

        this.setStatus("connecting");
        const url = typeof this.opts.url === "function" ? this.opts.url() : this.opts.url;
        const socket: SocketLike = new Ctor(url);
        this.socket = socket;
        this.watchOnline();

        socket.onopen = () => {
            socket.send(JSON.stringify({ type: "auth", v: PROTOCOL_VERSION, token }));
            this.touch();
        };
        socket.onmessage = (ev) => {
            this.touch();
            let frame: any;
            try { frame = JSON.parse(String(ev.data)); } catch { return; }
            this.onFrame(socket, frame);
        };
        socket.onerror = () => { /* a close follows */ };
        socket.onclose = (ev) => {
            if (this.socket !== socket) return;
            this.socket = null;
            this.clearStale();
            if (ev.code === CLOSE_UNAUTHORIZED || ev.code === CLOSE_UNSUPPORTED_VERSION) {
                return this.setStatus("unauthorized");
            }
            this.setStatus("offline");
            this.scheduleReconnect();
        };
    }

    /** Close for good (until the next `connect` or subscription). */
    close(): void {
        this.clearReconnect();
        this.cancelIdleClose();
        this.clearStale();
        this.removeOnline?.();
        this.removeOnline = null;
        const socket = this.socket;
        this.socket = null;
        this.everReady = false;
        this.attempt = 0;
        if (socket) {
            socket.onclose = null;
            try { socket.close(1000, "client closed"); } catch { /* already gone */ }
        }
        this.setStatus("idle");
    }

    private onFrame(socket: SocketLike, frame: any) {
        switch (frame?.type) {
            case "ready": {
                const reconnected = this.everReady;
                this.serverThreads = new Set(Array.isArray(frame.threads) ? frame.threads.map(String) : []);
                this.everReady = true;
                this.attempt = 0;
                this.setStatus("open");
                if (reconnected) {
                    for (const set of [...this.threads.values()]) {
                        for (const h of [...set]) safely(() => h.onReconnect?.());
                    }
                }
                return;
            }
            case "ping":
                if (socket.readyState === OPEN) socket.send(JSON.stringify({ type: "pong" }));
                return;
            case "message.created": {
                const handlers = this.threads.get(frame.thread);
                if (!handlers) return;
                for (const h of [...handlers]) safely(() => h.onMessage?.(frame.message, frame.thread));
                return;
            }
            case "typing": { // #103
                const handlers = this.threads.get(frame.thread);
                if (!handlers) return;
                const typing: LiveTyping = {
                    personId: String(frame.personId),
                    name: String(frame.name ?? ""),
                    expiresInMs: Number(frame.expiresInMs),
                };
                for (const h of [...handlers]) safely(() => h.onTyping?.(typing, frame.thread));
                return;
            }
            default:
                return; // unknown frame types are ignored, so the server can add them
        }
    }

    private scheduleReconnect() {
        if (this.threads.size === 0) return this.setStatus("idle");
        const ceiling = Math.min(this.opts.maxMs, this.opts.baseMs * 2 ** this.attempt);
        this.attempt++;
        const delay = Math.round(this.opts.random() * ceiling);
        this.clearReconnect();
        this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
    }

    /** Any frame proves the socket is alive; silence past staleAfterMs means it isn't. */
    private touch() {
        this.clearStale();
        const socket = this.socket;
        this.staleTimer = setTimeout(() => {
            if (this.socket !== socket || !socket) return;
            // Browsers can take minutes to notice a dead TCP connection; don't wait.
            socket.onclose?.({ code: 1006 });
            try { socket.close(); } catch { /* already gone */ }
        }, this.opts.staleAfterMs);
    }

    /** Coming back online shouldn't wait out the backoff. */
    private watchOnline() {
        if (this.removeOnline || typeof window === "undefined" || !window.addEventListener) return;
        const retry = () => { if (!this.socket && this.status === "offline") this.connect(); };
        window.addEventListener("online", retry);
        this.removeOnline = () => window.removeEventListener("online", retry);
    }

    private scheduleIdleClose() {
        this.cancelIdleClose();
        this.idleTimer = setTimeout(() => { this.idleTimer = null; if (this.threads.size === 0) this.close(); },
            this.opts.idleCloseMs);
    }

    private cancelIdleClose() {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = null;
    }

    private clearReconnect() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
    }

    private clearStale() {
        if (this.staleTimer) clearTimeout(this.staleTimer);
        this.staleTimer = null;
    }

    private setStatus(status: LiveStatus) {
        if (this.status === status) return;
        this.status = status;
        for (const l of [...this.statusListeners]) safely(() => l(status));
    }
}

function safely(fn: () => void) {
    try { fn(); } catch (err) { console.error("[live] handler failed:", err); }
}
