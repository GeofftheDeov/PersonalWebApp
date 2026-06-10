import { Redis } from "ioredis";
import type { EventMap, EventName, EventEnvelope } from "./events.js";
import type { EventBus, EventHandler } from "./EventBus.js";

const MAXLEN = 10_000; // per-stream trim target (approximate, `~`)
const BLOCK_MS = 5_000; // XREADGROUP block time
const BATCH = 32; // max entries per read
const CLAIM_MIN_IDLE_MS = 60_000; // reclaim entries pending longer than this

interface RedisStreamBusOptions {
    url: string;
    /** Consumer group — one per service (e.g. "backend", "cloudclaw"). */
    group: string;
    /** Source tag stamped on published envelopes. */
    source?: string;
    /** Unique consumer name within the group. Defaults to hostname+pid. */
    consumer?: string;
}

/** Domain = text before the first dot → stream `events:<domain>`. */
function streamFor(event: string): string {
    return `events:${event.split(".")[0]}`;
}

/**
 * Production EventBus on Redis Streams.
 *
 * - publish: XADD to `events:<domain>` with MAXLEN ~ trimming
 * - subscribe: consumer-group reads (XREADGROUP), XACK on handler success
 * - recovery: failed/stuck entries are reclaimed with XAUTOCLAIM after 60s idle
 *
 * Delivery is at-least-once: handlers must be idempotent.
 */
export class RedisStreamBus implements EventBus {
    private pub: Redis;
    private url: string;
    private group: string;
    private source: string;
    private consumer: string;
    private handlers = new Map<EventName, Set<EventHandler<any>>>();
    private readers: Redis[] = [];
    private running = false;

    constructor(opts: RedisStreamBusOptions) {
        this.url = opts.url;
        this.group = opts.group;
        this.source = opts.source ?? opts.group;
        this.consumer = opts.consumer ?? `${process.env.HOSTNAME ?? "host"}-${process.pid}`;
        this.pub = new Redis(this.url, { lazyConnect: true, maxRetriesPerRequest: 3 });
        this.pub.on("error", (err) => console.error("[events] redis (pub) error:", err.message));
    }

    async publish<K extends EventName>(event: K, payload: EventMap[K]): Promise<string> {
        const envelope = {
            name: event,
            ts: new Date().toISOString(),
            source: this.source,
            payload: JSON.stringify(payload),
        };
        const id = await this.pub.xadd(
            streamFor(event),
            "MAXLEN", "~", MAXLEN,
            "*",
            "name", envelope.name,
            "ts", envelope.ts,
            "source", envelope.source,
            "payload", envelope.payload
        );
        return id as string;
    }

    subscribe<K extends EventName>(event: K, handler: EventHandler<K>): () => void {
        if (!this.handlers.has(event)) this.handlers.set(event, new Set());
        this.handlers.get(event)!.add(handler);
        return () => this.handlers.get(event)?.delete(handler);
    }

    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        await this.pub.connect().catch(() => {/* ioredis auto-retries */});

        const streams = [...new Set([...this.handlers.keys()].map(streamFor))];
        for (const stream of streams) {
            try {
                await this.pub.xgroup("CREATE", stream, this.group, "$", "MKSTREAM");
            } catch (err: any) {
                if (!String(err?.message).includes("BUSYGROUP")) throw err;
            }
            const reader = this.pub.duplicate();
            reader.on("error", (err) => console.error(`[events] redis (${stream}) error:`, err.message));
            this.readers.push(reader);
            void this.readLoop(reader, stream);
        }
        console.log(`[events] RedisStreamBus started — group=${this.group} consumer=${this.consumer} streams=[${streams.join(", ")}]`);
    }

    async stop(): Promise<void> {
        this.running = false;
        await Promise.allSettled([
            this.pub.quit(),
            ...this.readers.map((r) => r.quit()),
        ]);
        this.readers = [];
    }

    private async readLoop(reader: Redis, stream: string): Promise<void> {
        let lastClaim = 0;
        while (this.running) {
            try {
                // Periodically reclaim entries another (dead) consumer left pending.
                if (Date.now() - lastClaim > CLAIM_MIN_IDLE_MS) {
                    lastClaim = Date.now();
                    const claimed: any = await reader.xautoclaim(
                        stream, this.group, this.consumer, CLAIM_MIN_IDLE_MS, "0-0", "COUNT", BATCH
                    );
                    if (claimed?.[1]?.length) await this.dispatch(reader, stream, claimed[1]);
                }

                const res: any = await reader.xreadgroup(
                    "GROUP", this.group, this.consumer,
                    "COUNT", BATCH, "BLOCK", BLOCK_MS,
                    "STREAMS", stream, ">"
                );
                if (res) for (const [, entries] of res) await this.dispatch(reader, stream, entries);
            } catch (err: any) {
                if (!this.running) break;
                console.error(`[events] read loop (${stream}) error:`, err.message);
                await new Promise((r) => setTimeout(r, 2_000));
            }
        }
    }

    private async dispatch(reader: Redis, stream: string, entries: [string, string[]][]): Promise<void> {
        for (const [id, fields] of entries) {
            const raw: Record<string, string> = {};
            for (let i = 0; i < fields.length; i += 2) raw[fields[i]] = fields[i + 1];

            const name = raw.name as EventName;
            const handlers = this.handlers.get(name);
            if (!handlers || handlers.size === 0) {
                await reader.xack(stream, this.group, id); // no local interest — ack and move on
                continue;
            }

            const envelope: EventEnvelope = {
                id,
                name,
                ts: raw.ts,
                source: raw.source,
                payload: JSON.parse(raw.payload ?? "{}"),
            };

            try {
                for (const handler of handlers) await handler(envelope.payload, envelope);
                await reader.xack(stream, this.group, id);
            } catch (err: any) {
                // Leave unacked — XAUTOCLAIM retries it after CLAIM_MIN_IDLE_MS.
                console.error(`[events] handler failed for ${name} (${id}); will retry:`, err.message);
            }
        }
    }
}
