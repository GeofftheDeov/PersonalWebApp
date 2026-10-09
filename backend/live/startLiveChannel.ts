import type { Server as HttpServer } from "http";
import type { Server as HttpsServer } from "https";
import { bus as defaultBus, type EventBus } from "../events/index.js";
import { attachLiveChannel, type LiveChannel, type LiveChannelOptions } from "./liveChannel.js";

/**
 * Boots the live channel and keeps trying until it is up (#106).
 *
 * `attachLiveChannel` needs its broadcast subscriptions (on Redis, a SUBSCRIBE
 * per event name) before it takes any socket. If Redis is unreachable when
 * the task boots, that fails; this retries with exponential backoff and full
 * jitter until it works, so `/api/live` comes up as soon as Redis does instead
 * of staying dead until the next restart. Until then no upgrade listener is
 * attached and clients' own backoff keeps them trying.
 *
 * Each failed attempt gives back every subscription it had made before
 * failing, so retries never pile up handlers on the bus.
 *
 * After attaching, a dropped Redis connection needs nothing from here: the
 * Redis bus's subscriber connection (ioredis) reconnects and re-subscribes
 * every channel on its own.
 */
export interface StartLiveChannelOptions extends LiveChannelOptions {
    /** Backoff base: attempt n waits a random time in [0, min(maxRetryMs, retryMs × 2^n)). Default 1 s. */
    retryMs?: number;
    /** Backoff cap. Default 30 s. */
    maxRetryMs?: number;
    /** Called after each failed attempt, with the wait before the next. Defaults to a console.error line. */
    onRetry?: (err: unknown, delayMs: number, attempt: number) => void;
}

export interface LiveChannelHandle extends LiveChannel {
    /** The attached channel, once it is; `null` if `close()` came first. Never rejects. */
    ready: Promise<LiveChannel | null>;
}

type AnyServer = HttpServer | HttpsServer;

export function startLiveChannel(
    servers: AnyServer | AnyServer[],
    options: StartLiveChannelOptions = {},
): LiveChannelHandle {
    const { retryMs = 1_000, maxRetryMs = 30_000, onRetry = logRetry, ...liveOptions } = options;
    const bus = liveOptions.bus ?? defaultBus;
    let closed = false;
    let channel: LiveChannel | null = null;
    let wake: (() => void) | null = null;

    const ready = (async () => {
        for (let attempt = 1; !closed; attempt++) {
            const tracked = trackBroadcasts(bus);
            try {
                const attached = await attachLiveChannel(servers, { ...liveOptions, bus: tracked.bus });
                if (closed) {
                    await attached.close();
                    return null;
                }
                channel = attached;
                return attached;
            } catch (err) {
                tracked.release();
                if (closed) return null;
                const delayMs = Math.random() * Math.min(maxRetryMs, retryMs * 2 ** (attempt - 1));
                onRetry(err, delayMs, attempt);
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(resolve, delayMs);
                    wake = () => { clearTimeout(timer); resolve(); };
                });
                wake = null;
            }
        }
        return null;
    })();

    return {
        ready,
        async close() {
            closed = true;
            (wake as (() => void) | null)?.();
            await ready;
            await channel?.close();
        },
    };
}

function logRetry(err: unknown, delayMs: number, attempt: number) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[live] channel failed to start (attempt ${attempt}): ${reason}; retrying in ${Math.round(delayMs)} ms`);
}

/**
 * The bus as one attempt sees it: every subscription it makes is recorded,
 * so a failed attempt can give them all back. A broadcast one that settles
 * after `release()` (a subscription made in parallel) is given back at once.
 */
function trackBroadcasts(bus: EventBus) {
    const held: Array<() => void> = [];
    let released = false;
    const tracked: EventBus = {
        publish: (event, payload) => bus.publish(event, payload),
        publishEphemeral: (event, payload) => bus.publishEphemeral(event, payload),
        subscribe(event, handler) {
            const unsubscribe = bus.subscribe(event, handler);
            held.push(unsubscribe);
            return unsubscribe;
        },
        async subscribeBroadcast(event, handler) {
            const unsubscribe = await bus.subscribeBroadcast(event, handler);
            if (released) unsubscribe();
            else held.push(unsubscribe);
            return unsubscribe;
        },
        start: () => bus.start(),
        stop: () => bus.stop(),
    };
    return {
        bus: tracked,
        release() {
            released = true;
            for (const unsubscribe of held.splice(0)) unsubscribe();
        },
    };
}
