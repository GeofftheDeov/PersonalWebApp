import { randomUUID } from "node:crypto";
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
    /**
     * Environment namespace (e.g. "prod", "dev") for buses that share one
     * Redis. Every stream key, the consumer group and every Pub/Sub channel
     * get a `<namespace>:` prefix, so two namespaces never see each other's
     * events. Unset or blank keeps the un-namespaced names.
     */
    namespace?: string;
}

/**
 * The names a bus in `namespace` uses on Redis. An unset or blank namespace
 * keeps the un-namespaced names: streams `events:<domain>`, channels
 * `events:live:<name>`, the group as given. Otherwise each gets `<namespace>:`
 * in front.
 */
export function busNames(namespace?: string) {
    const ns = namespace?.trim() ?? "";
    if (ns && !/^[A-Za-z0-9_-]+$/.test(ns)) {
        throw new Error(`Event bus namespace may only use letters, digits, '-' and '_' (got "${ns}")`);
    }
    const prefix = ns ? `${ns}:` : "";
    return {
        /** Domain = text before the first dot → stream `[<ns>:]events:<domain>`. */
        stream: (event: string) => `${prefix}events:${event.split(".")[0]}`,
        /**
         * Pub/Sub channel carrying an event name's broadcast fan-out. Channels
         * are not keys and ignore the logical database number, so this prefix
         * is the only thing keeping namespaces apart on Pub/Sub.
         */
        channel: (event: string) => `${prefix}events:live:${event}`,
        group: (group: string) => `${prefix}${group}`,
    };
}

/**
 * Production EventBus on Redis Streams.
 *
 * - namespace: with one set, every name below carries a `<namespace>:` prefix
 *   (see busNames); prod and dev share a Redis and must not share events
 * - publish: XADD to `events:<domain>` with MAXLEN ~ trimming
 * - subscribe: consumer-group reads (XREADGROUP), XACK on handler success
 * - recovery: failed/stuck entries are reclaimed with XAUTOCLAIM after 60s idle
 * - broadcast: publish also PUBLISHes the envelope on `events:live:<name>`;
 *   every process with a broadcast subscription SUBSCRIBEs to that channel.
 *   publishEphemeral only PUBLISHes, so it never reaches a stream.
 *
 * Delivery is at-least-once for `subscribe` (handlers must be idempotent) and
 * at-most-once for `subscribeBroadcast` (Pub/Sub keeps no history).
 */
export class RedisStreamBus implements EventBus {
    private pub: Redis;
    private url: string;
    private group: string;
    private source: string;
    private consumer: string;
    private streamFor: (event: string) => string;
    private channelFor: (event: string) => string;
    private handlers = new Map<EventName, Set<EventHandler<any>>>();
    private readers: Redis[] = [];
    private running = false;
    /** Pub/Sub connection, opened by the first broadcast subscription. */
    private sub: Redis | null = null;
    private broadcasts = new Map<EventName, Set<EventHandler<any>>>();
    /** Per channel, the SUBSCRIBE in flight or done; awaited by later subscribers. */
    private channels = new Map<string, Promise<unknown>>();

    constructor(opts: RedisStreamBusOptions) {
        const names = busNames(opts.namespace);
        this.url = opts.url;
        this.group = names.group(opts.group);
        this.streamFor = names.stream;
        this.channelFor = names.channel;
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
            this.streamFor(event),
            "MAXLEN", "~", MAXLEN,
            "*",
            "name", envelope.name,
            "ts", envelope.ts,
            "source", envelope.source,
            "payload", envelope.payload
        ) as string;
        // The event is durable once XADD returns. A failed fan-out only costs
        // live delivery, so it must not tell the caller to publish again.
        await this.pub
            .publish(this.channelFor(event), JSON.stringify({ id, ...envelope }))
            .catch((err) => console.error(`[events] broadcast of ${event} (${id}) failed:`, err.message));
        return id;
    }

    async publishEphemeral<K extends EventName>(event: K, payload: EventMap[K]): Promise<string> {
        const id = randomUUID();
        await this.pub.publish(this.channelFor(event), JSON.stringify({
            id,
            name: event,
            ts: new Date().toISOString(),
            source: this.source,
            payload: JSON.stringify(payload),
        }));
        return id;
    }

    async subscribeBroadcast<K extends EventName>(event: K, handler: EventHandler<K>): Promise<() => void> {
        if (!this.broadcasts.has(event)) this.broadcasts.set(event, new Set());
        const handlers = this.broadcasts.get(event)!;
        // A wrapper per registration, so the same function subscribed twice
        // needs two unsubscribes, not one.
        const entry: EventHandler<K> = (payload, meta) => handler(payload, meta);
        handlers.add(entry);

        const channel = this.channelFor(event);
        if (!this.channels.has(channel)) this.channels.set(channel, this.subscriber().subscribe(channel));
        try {
            await this.channels.get(channel);
        } catch (err) {
            handlers.delete(entry);
            this.channels.delete(channel);
            throw err;
        }

        return () => {
            handlers.delete(entry);
            if (handlers.size > 0 || this.broadcasts.get(event) !== handlers) return;
            this.broadcasts.delete(event);
            this.channels.delete(channel);
            // Commands run in order on one connection, so a SUBSCRIBE issued
            // after this (by a new subscription) still wins.
            this.sub?.unsubscribe(channel).catch(() => {/* closed */});
        };
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

        const streams = [...new Set([...this.handlers.keys()].map(this.streamFor))];
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
            ...(this.sub ? [this.sub.quit()] : []),
        ]);
        this.readers = [];
        this.sub = null;
        this.broadcasts.clear();
        this.channels.clear();
    }

    private subscriber(): Redis {
        if (this.sub) return this.sub;
        // A connection in subscriber mode can run no other commands, so
        // broadcast gets its own. ioredis re-subscribes after a reconnect.
        const sub = this.pub.duplicate();
        sub.on("error", (err) => console.error("[events] redis (sub) error:", err.message));
        sub.on("message", (_channel: string, message: string) => this.fanOut(message));
        this.sub = sub;
        return sub;
    }

    private fanOut(message: string): void {
        let envelope: EventEnvelope;
        try {
            const raw = JSON.parse(message);
            envelope = { id: raw.id, name: raw.name, ts: raw.ts, source: raw.source, payload: JSON.parse(raw.payload ?? "{}") };
        } catch (err: any) {
            console.error("[events] unreadable broadcast message:", err.message);
            return;
        }
        for (const handler of this.broadcasts.get(envelope.name) ?? []) {
            Promise.resolve()
                .then(() => handler(envelope.payload, envelope))
                .catch((err) => console.error(`[events] broadcast handler for '${envelope.name}' failed:`, err));
        }
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
