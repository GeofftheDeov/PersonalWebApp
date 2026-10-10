/**
 * Typing indicators (#103, spec #58): "Theo is writing…".
 *
 * Headless and framework-free, with no imports, like liveClient.ts: #69's
 * shared package can lift it as is, and the backend test
 * (backend/scripts/test-live-typing.ts) drives it with a real LiveClient and
 * an injected clock. The React wrapper is `useTyping` in useTyping.ts.
 *
 * One TypingTracker per open thread view:
 *   - `typing()` on every keystroke. It sends a `typing` frame at most once
 *     every TYPING_THROTTLE_MS (3 s) while the person keeps typing.
 *   - `sent()` when the person sends their message, so the next keystroke
 *     announces straight away instead of waiting out the 3 s.
 *   - `typists` is who else is writing. Each one disappears on its own
 *     `expiresInMs` (5 s) after their last frame, or as soon as their message
 *     arrives on the thread.
 *
 * The server never sends you your own typing, so there's no self-filter here.
 */

/** A client sends at most one `typing` frame per thread this often while someone types. */
export const TYPING_THROTTLE_MS = 3_000;
/** An indicator with no refresh for this long goes away (the server's `expiresInMs`; used if a frame lacks it). */
export const TYPING_EXPIRY_MS = 5_000;
/** A frame can't keep an indicator up longer than this, whatever it says. */
const MAX_EXPIRY_MS = 15_000;

export interface Typist {
    personId: string;
    name: string;
}

/** Time and timers; injected by tests, the real ones otherwise. */
export interface TypingClock {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

/** The slice of LiveClient a tracker uses. */
export interface TypingChannel {
    subscribe(thread: string, handlers: {
        onTyping?: (typing: { personId: string; name: string; expiresInMs: number }, thread: string) => void;
        onMessage?: (message: { sender: { id: string } }, thread: string) => void;
    }): () => void;
    sendTyping(thread: string): boolean;
}

export interface TypingTrackerOptions {
    client: TypingChannel;
    thread: string;
    clock?: TypingClock;
}

const systemClock: TypingClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class TypingTracker {
    private readonly client: TypingChannel;
    private readonly thread: string;
    private readonly clock: TypingClock;
    /** person id → who is writing, and the timer that clears them. */
    private active = new Map<string, { name: string; timer: unknown }>();
    private lastSentAt: number | null = null;
    private listeners = new Set<(typists: Typist[]) => void>();
    private unsubscribe: (() => void) | null;

    constructor(options: TypingTrackerOptions) {
        this.client = options.client;
        this.thread = options.thread;
        this.clock = options.clock ?? systemClock;
        this.unsubscribe = this.client.subscribe(this.thread, {
            onTyping: (typing) => this.seen(typing),
            onMessage: (message) => this.clear(String(message?.sender?.id)),
        });
    }

    /** Who else is writing in this thread right now, in the order they started. */
    get typists(): Typist[] {
        return [...this.active].map(([personId, { name }]) => ({ personId, name }));
    }

    /** Called with the new `typists` whenever someone starts or stops. */
    onChange(listener: (typists: Typist[]) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    /** The person typed something. Sends a frame unless one went out in the last 3 s. */
    typing(): void {
        const now = this.clock.now();
        if (this.lastSentAt !== null && now - this.lastSentAt < TYPING_THROTTLE_MS) return;
        // Only a frame that actually went out starts the 3 s; offline, the next keystroke tries again.
        if (this.client.sendTyping(this.thread)) this.lastSentAt = now;
    }

    /** The person sent their message: the burst is over, so the next keystroke announces at once. */
    sent(): void {
        this.lastSentAt = null;
    }

    /** Stop listening and cancel every timer. */
    dispose(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        for (const { timer } of this.active.values()) this.clock.clearTimeout(timer);
        this.active.clear();
        this.listeners.clear();
    }

    private seen(typing: { personId: string; name: string; expiresInMs: number }) {
        if (!this.unsubscribe || !typing.personId) return;
        const ms = Number.isFinite(typing.expiresInMs) && typing.expiresInMs > 0
            ? Math.min(typing.expiresInMs, MAX_EXPIRY_MS)
            : TYPING_EXPIRY_MS;
        const existing = this.active.get(typing.personId);
        if (existing) this.clock.clearTimeout(existing.timer);
        const timer = this.clock.setTimeout(() => this.clear(typing.personId), ms);
        this.active.set(typing.personId, { name: typing.name, timer });
        // A refresh from someone already showing changes nothing on screen.
        if (!existing || existing.name !== typing.name) this.emit();
    }

    private clear(personId: string) {
        const entry = this.active.get(personId);
        if (!entry) return;
        this.clock.clearTimeout(entry.timer);
        this.active.delete(personId);
        this.emit();
    }

    private emit() {
        const typists = this.typists;
        for (const listener of [...this.listeners]) {
            try { listener(typists); } catch (err) { console.error("[typing] listener failed:", err); }
        }
    }
}

/** "Theo is writing…", "Theo and Mara are writing…", "Several people are writing…", or "" for nobody. */
export function typingLabel(typists: Typist[]): string {
    if (typists.length === 0) return "";
    if (typists.length === 1) return `${typists[0].name} is writing…`;
    if (typists.length === 2) return `${typists[0].name} and ${typists[1].name} are writing…`;
    return "Several people are writing…";
}
