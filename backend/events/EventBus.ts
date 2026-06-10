import type { EventMap, EventName, EventEnvelope } from "./events.js";

export type EventHandler<K extends EventName> = (
    payload: EventMap[K],
    meta: EventEnvelope<K>
) => void | Promise<void>;

/**
 * Thin typed event bus facade. Feature code depends only on this interface;
 * the backing implementation (in-memory vs Redis Streams) is chosen at boot.
 *
 * Delivery is at-least-once on the Redis implementation — handlers MUST be
 * idempotent (key side effects on `meta.id`).
 */
export interface EventBus {
    /** Publish an event. Resolves with the event id once durably accepted. */
    publish<K extends EventName>(event: K, payload: EventMap[K]): Promise<string>;

    /**
     * Register a handler. Returns an unsubscribe function.
     * On Redis, all handlers in this process share one consumer group, so each
     * event is processed once per service, not once per handler registration.
     */
    subscribe<K extends EventName>(event: K, handler: EventHandler<K>): () => void;

    /** Begin consuming (no-op for in-memory). Call after subscriptions are registered. */
    start(): Promise<void>;

    /** Graceful shutdown. */
    stop(): Promise<void>;
}
