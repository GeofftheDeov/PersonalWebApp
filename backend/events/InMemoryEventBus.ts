import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { EventMap, EventName, EventEnvelope } from "./events.js";
import type { EventBus, EventHandler } from "./EventBus.js";

/**
 * Dev/test implementation. Same semantics as the Redis bus from the caller's
 * perspective (async dispatch, envelope metadata), but events do not survive
 * a process restart and are invisible to other services.
 */
export class InMemoryEventBus implements EventBus {
    private emitter = new EventEmitter();
    private source: string;

    constructor(source = "backend") {
        this.source = source;
        this.emitter.setMaxListeners(100);
    }

    async publish<K extends EventName>(event: K, payload: EventMap[K]): Promise<string> {
        const envelope: EventEnvelope<K> = {
            id: randomUUID(),
            name: event,
            ts: new Date().toISOString(),
            source: this.source,
            payload,
        };
        // setImmediate keeps publish() non-blocking and ordering consistent
        // with the Redis implementation (handlers never run inside publish).
        setImmediate(() => this.emitter.emit(event, envelope));
        return envelope.id;
    }

    subscribe<K extends EventName>(event: K, handler: EventHandler<K>): () => void {
        const listener = (envelope: EventEnvelope<K>) => {
            Promise.resolve(handler(envelope.payload, envelope)).catch((err) =>
                console.error(`[events] handler for '${event}' failed:`, err)
            );
        };
        this.emitter.on(event, listener);
        return () => this.emitter.off(event, listener);
    }

    async start(): Promise<void> {
        /* no-op */
    }

    async stop(): Promise<void> {
        this.emitter.removeAllListeners();
    }
}
