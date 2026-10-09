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
    /**
     * Publish an event. Resolves with the event id once durably accepted.
     * It reaches `subscribe` handlers once per service and `subscribeBroadcast`
     * handlers in every process.
     */
    publish<K extends EventName>(event: K, payload: EventMap[K]): Promise<string>;

    /**
     * Register a handler. Returns an unsubscribe function.
     * On Redis, all handlers in this process share one consumer group, so each
     * event is processed once per service, not once per handler registration.
     */
    subscribe<K extends EventName>(event: K, handler: EventHandler<K>): () => void;

    /**
     * Fan-out subscription: every process that subscribes receives every event
     * of this name, both published and ephemeral, from the moment the returned
     * promise resolves. There is no history replay and no retry: a handler that
     * throws is logged and the event is gone. Use it for live delivery to
     * clients this process holds (sockets), not for side effects that must
     * happen once — those belong on `subscribe`.
     *
     * Works with or without `start()`. Resolves with an unsubscribe function.
     * For a published event, `meta.id` matches the id `publish()` returned.
     */
    subscribeBroadcast<K extends EventName>(event: K, handler: EventHandler<K>): Promise<() => void>;

    /**
     * Publish an event that only broadcast subscribers (in every process)
     * receive. It is never written to a stream or kept in history, and
     * once-per-service `subscribe` handlers never see it. Delivery is
     * at-most-once. Resolves with the event id.
     */
    publishEphemeral<K extends EventName>(event: K, payload: EventMap[K]): Promise<string>;

    /**
     * Optional: calls `listener` each time the broadcast path comes back after
     * losing its connection, once every broadcast subscription is in place
     * again. Broadcast events published while it was down were lost (there is
     * no replay), so a listener that relays them to clients (the live channel)
     * should tell those clients to refetch. Returns an unsubscribe function.
     * A bus whose broadcast path can't drop (in memory) leaves it out.
     */
    onBroadcastResumed?(listener: () => void): () => void;

    /** Begin consuming (no-op for in-memory). Call after subscriptions are registered. */
    start(): Promise<void>;

    /** Graceful shutdown. */
    stop(): Promise<void>;
}
