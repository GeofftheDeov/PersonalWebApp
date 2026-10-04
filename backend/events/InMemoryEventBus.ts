import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { EventMap, EventName, EventEnvelope } from "./events.js";
import type { EventBus, EventHandler } from "./EventBus.js";

/**
 * Dev/test implementation. Same semantics as the Redis bus from the caller's
 * perspective (async dispatch, envelope metadata), but events do not survive
 * a process restart and are invisible to other services.
 *
 * In a single process, once-per-service and broadcast subscriptions differ
 * only in what reaches them: ephemeral events go to broadcast handlers alone.
 */
export class InMemoryEventBus implements EventBus {
    private emitter = new EventEmitter();
    private broadcasts = new Map<EventName, Set<EventHandler<any>>>();
    private source: string;

    constructor(source = "backend") {
        this.source = source;
        this.emitter.setMaxListeners(100);
    }

    async publish<K extends EventName>(event: K, payload: EventMap[K]): Promise<string> {
        const envelope = this.envelope(event, payload);
        const fanOut = this.snapshotBroadcast(event);
        // setImmediate keeps publish() non-blocking and ordering consistent
        // with the Redis implementation (handlers never run inside publish).
        setImmediate(() => {
            this.emitter.emit(event, envelope);
            fanOut(envelope);
        });
        return envelope.id;
    }

    async publishEphemeral<K extends EventName>(event: K, payload: EventMap[K]): Promise<string> {
        const envelope = this.envelope(event, payload);
        const fanOut = this.snapshotBroadcast(event);
        setImmediate(() => fanOut(envelope));
        return envelope.id;
    }

    subscribe<K extends EventName>(event: K, handler: EventHandler<K>): () => void {
        const listener = (envelope: EventEnvelope<K>) => runHandler(event, handler, envelope);
        this.emitter.on(event, listener);
        return () => this.emitter.off(event, listener);
    }

    async subscribeBroadcast<K extends EventName>(event: K, handler: EventHandler<K>): Promise<() => void> {
        if (!this.broadcasts.has(event)) this.broadcasts.set(event, new Set());
        // A wrapper per registration, so the same function subscribed twice
        // needs two unsubscribes, not one.
        const entry: EventHandler<K> = (payload, meta) => handler(payload, meta);
        this.broadcasts.get(event)!.add(entry);
        return () => this.broadcasts.get(event)?.delete(entry);
    }

    async start(): Promise<void> {
        /* no-op */
    }

    async stop(): Promise<void> {
        this.emitter.removeAllListeners();
        this.broadcasts.clear();
    }

    private envelope<K extends EventName>(event: K, payload: EventMap[K]): EventEnvelope<K> {
        return { id: randomUUID(), name: event, ts: new Date().toISOString(), source: this.source, payload };
    }

    /**
     * The broadcast handlers subscribed right now. Delivery is deferred, so
     * taking the set at publish time keeps a later subscription from seeing an
     * event published before it, as on Redis. A handler removed in between is
     * skipped.
     */
    private snapshotBroadcast<K extends EventName>(event: K): (envelope: EventEnvelope<K>) => void {
        const handlers = [...(this.broadcasts.get(event) ?? [])];
        return (envelope) => {
            const live = this.broadcasts.get(event);
            for (const handler of handlers) if (live?.has(handler)) runHandler(event, handler, envelope);
        };
    }
}

function runHandler<K extends EventName>(event: K, handler: EventHandler<K>, envelope: EventEnvelope<K>): void {
    Promise.resolve()
        .then(() => handler(envelope.payload, envelope))
        .catch((err) => console.error(`[events] handler for '${event}' failed:`, err));
}
