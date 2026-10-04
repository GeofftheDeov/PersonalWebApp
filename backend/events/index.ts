import type { EventBus } from "./EventBus.js";
import { InMemoryEventBus } from "./InMemoryEventBus.js";
import { RedisStreamBus } from "./RedisStreamBus.js";

export type { EventBus, EventHandler } from "./EventBus.js";
export type { EventMap, EventName, EventEnvelope } from "./events.js";

/**
 * Builds the bus an environment describes.
 *
 * REDIS_URL set   → Redis Streams (durable, cross-service), e.g.
 *                   redis://redis.internal:6379 via Cloud Map service discovery
 * REDIS_URL unset → in-memory (local dev / tests)
 *
 * EVENT_BUS_NAMESPACE (e.g. "prod", "dev") prefixes every stream, consumer
 * group and Pub/Sub channel with `<namespace>:`, so environments that share
 * one Redis never see each other's events. Unset keeps the un-namespaced
 * names; the in-memory bus ignores it.
 */
export function createEventBus(env: Record<string, string | undefined> = process.env): EventBus {
    if (!env.REDIS_URL) return new InMemoryEventBus("backend");
    return new RedisStreamBus({
        url: env.REDIS_URL,
        group: env.EVENT_BUS_GROUP || "backend",
        source: env.EVENT_BUS_SOURCE || "backend",
        namespace: env.EVENT_BUS_NAMESPACE,
    });
}

/** Singleton bus for this service. */
export const bus: EventBus = createEventBus();

if (!process.env.REDIS_URL) {
    console.log("[events] REDIS_URL not set — using InMemoryEventBus (events do not persist)");
}

/** Call once at boot, after all module-level subscriptions are registered. */
export async function startEventBus(): Promise<void> {
    await bus.start();
}

export async function stopEventBus(): Promise<void> {
    await bus.stop();
}
