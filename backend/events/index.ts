import type { EventBus } from "./EventBus.js";
import { InMemoryEventBus } from "./InMemoryEventBus.js";
import { RedisStreamBus } from "./RedisStreamBus.js";

export type { EventBus, EventHandler } from "./EventBus.js";
export type { EventMap, EventName, EventEnvelope } from "./events.js";

/**
 * Singleton bus for this service.
 *
 * REDIS_URL set   → Redis Streams (durable, cross-service), e.g.
 *                   redis://redis.internal:6379 via Cloud Map service discovery
 * REDIS_URL unset → in-memory (local dev / tests)
 */
const redisUrl = process.env.REDIS_URL;

export const bus: EventBus = redisUrl
    ? new RedisStreamBus({
          url: redisUrl,
          group: process.env.EVENT_BUS_GROUP || "backend",
          source: process.env.EVENT_BUS_SOURCE || "backend",
      })
    : new InMemoryEventBus("backend");

if (!redisUrl) {
    console.log("[events] REDIS_URL not set — using InMemoryEventBus (events do not persist)");
}

/** Call once at boot, after all module-level subscriptions are registered. */
export async function startEventBus(): Promise<void> {
    await bus.start();
}

export async function stopEventBus(): Promise<void> {
    await bus.stop();
}
