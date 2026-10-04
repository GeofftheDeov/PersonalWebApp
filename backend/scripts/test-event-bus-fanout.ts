/**
 * Event bus fan-out and ephemeral events (#96, prefactor for the Letters live
 * channel #98 and typing indicators #103).
 *
 * The Redis-stream bus delivers each event once per service: every backend task
 * joins the same consumer group, so with two tasks an event reaches only one.
 * The live channel needs every task to see every message event, and typing
 * needs a path that is never persisted. This checks the two additions:
 *
 *  - subscribeBroadcast: every process that subscribes receives every event of
 *    that name from the moment it subscribes, with no history replay;
 *  - publishEphemeral: reaches broadcast subscribers in every process and is
 *    never written to a stream;
 *
 * and that ordinary once-per-service subscriptions behave as before.
 *
 * Each "process" is a separate bus instance with its own Redis connections and
 * consumer name, sharing one consumer group, which is how two backend tasks
 * look to Redis. Event names live under the `t96` domains, so everything this
 * writes stays in the `events:t96*` streams (deleted at the end) and no real
 * subscriber ever sees it.
 *
 * Needs the docker-compose Redis (`docker compose up -d redis`):
 *   REDIS_URL=redis://127.0.0.1:6379 npx tsx scripts/test-event-bus-fanout.ts
 */
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { RedisStreamBus } from "../events/RedisStreamBus.js";
import { InMemoryEventBus } from "../events/InMemoryEventBus.js";
import type { EventBus, EventEnvelope, EventName } from "../events/index.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
if (!/\/\/(127\.0\.0\.1|localhost)[:/]/.test(REDIS_URL)) {
  console.error("\n  Refusing to run: REDIS_URL must be a local Redis.\n");
  process.exit(2);
}

// Test-only event names. Their domains map to the `events:t96` and
// `events:t96eph` streams, which no real subscriber reads.
const MESSAGE = "t96.message" as EventName;
const TYPING = "t96eph.typing" as EventName;
const MESSAGE_STREAM = "events:t96";
const TYPING_STREAM = "events:t96eph";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? pass++ : fail++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until `cond` holds (or `ms` passes), then a little longer so duplicates would show up. */
async function settle(cond: () => boolean, ms = 8_000) {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) await sleep(25);
  await sleep(400);
}

/** Records every delivery a handler sees, keyed by the payload's marker. */
function recorder() {
  const seen: string[] = [];
  const ids: string[] = [];
  const handler = (payload: any, meta: EventEnvelope) => {
    seen.push(payload.marker);
    ids.push(meta.id);
  };
  return { seen, ids, handler, count: (m: string) => seen.filter((s) => s === m).length };
}

const payload = (marker: string) => ({ marker }) as any;

function redisBus(group: string, consumer: string): RedisStreamBus {
  return new RedisStreamBus({ url: REDIS_URL, group, source: "t96-check", consumer });
}

async function redisChecks() {
  console.log("\nRedis bus — two instances, one consumer group\n");
  const run = randomUUID().slice(0, 8);
  const group = `t96-group-${run}`;
  const admin = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
  const buses: EventBus[] = [];

  try {
    const a = redisBus(group, `t96-a-${run}`);
    const b = redisBus(group, `t96-b-${run}`);
    buses.push(a, b);

    // Once-per-service subscriptions must be registered before start().
    const normalA = recorder();
    const normalB = recorder();
    a.subscribe(MESSAGE, normalA.handler);
    b.subscribe(MESSAGE, normalB.handler);
    await a.start();
    await b.start();

    const castA = recorder();
    const castB = recorder();
    await a.subscribeBroadcast(MESSAGE, castA.handler);
    await b.subscribeBroadcast(MESSAGE, castB.handler);

    // 1. Broadcast: each instance sees a message event exactly once.
    const m1 = `msg-${run}`;
    const m1Id = await a.publish(MESSAGE, payload(m1));
    await settle(() => castA.count(m1) >= 1 && castB.count(m1) >= 1);
    check("a broadcast subscription in instance A receives the message event exactly once",
      castA.count(m1) === 1, `got ${castA.count(m1)}`);
    check("a broadcast subscription in instance B receives the same event exactly once",
      castB.count(m1) === 1, `got ${castB.count(m1)}`);
    check("broadcast deliveries carry the stream entry id publish() returned",
      castA.ids.includes(m1Id) && castB.ids.includes(m1Id), `published ${m1Id}, A saw ${castA.ids}, B saw ${castB.ids}`);

    // 2. Ephemeral: both instances' broadcast subscribers see it; no stream does.
    const typingA = recorder();
    const typingB = recorder();
    await a.subscribeBroadcast(TYPING, typingA.handler);
    await b.subscribeBroadcast(TYPING, typingB.handler);
    const normalTyping = recorder();
    a.subscribe(TYPING, normalTyping.handler);

    const lenBefore = await admin.xlen(MESSAGE_STREAM);
    const e1 = `typing-${run}`;
    await b.publishEphemeral(TYPING, payload(e1));
    const e2 = `typing-on-msg-${run}`;
    await a.publishEphemeral(MESSAGE, payload(e2));
    await settle(() => typingA.count(e1) >= 1 && typingB.count(e1) >= 1 && castA.count(e2) >= 1 && castB.count(e2) >= 1);
    check("an ephemeral event reaches the broadcast subscriber in instance A",
      typingA.count(e1) === 1, `got ${typingA.count(e1)}`);
    check("an ephemeral event reaches the broadcast subscriber in instance B",
      typingB.count(e1) === 1, `got ${typingB.count(e1)}`);
    check("an ephemeral event on a persisted event's name reaches both instances' broadcast subscribers",
      castA.count(e2) === 1 && castB.count(e2) === 1, `A ${castA.count(e2)}, B ${castB.count(e2)}`);
    check("the ephemeral event's stream was never created",
      (await admin.exists(TYPING_STREAM)) === 0);
    const entries = await admin.xrange(MESSAGE_STREAM, "-", "+");
    const leaked = entries.filter(([, f]) => f.join(" ").includes(e2) || f.join(" ").includes(e1));
    check("no Redis stream holds an entry for either ephemeral event",
      leaked.length === 0 && (await admin.xlen(MESSAGE_STREAM)) === lenBefore,
      `${leaked.length} leaked entries; XLEN ${lenBefore} -> ${await admin.xlen(MESSAGE_STREAM)}`);
    check("ephemeral events never reach once-per-service subscribers",
      normalTyping.seen.length === 0 && normalA.count(e2) === 0 && normalB.count(e2) === 0,
      `typing ${normalTyping.seen.length}, msg A ${normalA.count(e2)}, msg B ${normalB.count(e2)}`);

    // 3. Once-per-service: N events processed exactly once between A and B.
    const batch = Array.from({ length: 10 }, (_, i) => `batch-${run}-${i}`);
    for (const m of batch) await (Math.random() < 0.5 ? a : b).publish(MESSAGE, payload(m));
    const handled = () => batch.map((m) => normalA.count(m) + normalB.count(m));
    await settle(() => handled().every((n) => n >= 1));
    check("a once-per-service subscription processes each event exactly once between the two instances",
      handled().every((n) => n === 1), `per-event counts ${JSON.stringify(handled())}`);
    check("the earlier message event was also processed once between them",
      normalA.count(m1) + normalB.count(m1) === 1, `A ${normalA.count(m1)}, B ${normalB.count(m1)}`);
    check("broadcast subscribers saw every one of those events in both instances",
      batch.every((m) => castA.count(m) === 1 && castB.count(m) === 1));

    // 4. A process that starts later gets no replay.
    const before = `before-c-${run}`;
    await a.publish(MESSAGE, payload(before));
    await a.publishEphemeral(TYPING, payload(before));
    await settle(() => castA.count(before) >= 1);
    const c = redisBus(group, `t96-c-${run}`);
    buses.push(c);
    const castC = recorder();
    const typingC = recorder();
    await c.subscribeBroadcast(MESSAGE, castC.handler);
    await c.subscribeBroadcast(TYPING, typingC.handler);
    await c.start();
    const after = `after-c-${run}`;
    await b.publish(MESSAGE, payload(after));
    await settle(() => castC.count(after) >= 1);
    check("a process started after an event was published does not receive it on a broadcast subscription",
      castC.count(before) === 0 && typingC.count(before) === 0, `message ${castC.count(before)}, typing ${typingC.count(before)}`);
    check("that process does receive events published after it subscribed",
      castC.count(after) === 1, `got ${castC.count(after)}`);

    // 5. Unsubscribing a broadcast handler stops its deliveries.
    const castC2 = recorder();
    const off = await c.subscribeBroadcast(MESSAGE, castC2.handler);
    off();
    const gone = `after-unsub-${run}`;
    await a.publish(MESSAGE, payload(gone));
    await settle(() => castC.count(gone) >= 1);
    check("an unsubscribed broadcast handler gets nothing more; the remaining one still does",
      castC2.count(gone) === 0 && castC.count(gone) === 1, `unsubscribed ${castC2.count(gone)}, remaining ${castC.count(gone)}`);

    // 6. Dropping the last handler for a name and subscribing again works.
    const d = redisBus(group, `t96-d-${run}`);
    buses.push(d);
    const offD = await d.subscribeBroadcast(MESSAGE, recorder().handler);
    offD();
    const again = recorder();
    await d.subscribeBroadcast(MESSAGE, again.handler);
    const resub = `resub-${run}`;
    await a.publish(MESSAGE, payload(resub));
    await settle(() => again.count(resub) >= 1);
    check("re-subscribing after the last broadcast handler for a name was removed still delivers",
      again.count(resub) === 1, `got ${again.count(resub)}`);
  } finally {
    await Promise.allSettled(buses.map((bus) => bus.stop()));
    await admin.del(MESSAGE_STREAM, TYPING_STREAM);
    await admin.quit();
  }
}

async function inMemoryChecks() {
  console.log("\nIn-memory bus — one process\n");
  const bus = new InMemoryEventBus("t96-check");
  try {
    const normal = recorder();
    const cast1 = recorder();
    const cast2 = recorder();
    bus.subscribe(MESSAGE, normal.handler);
    await bus.subscribeBroadcast(MESSAGE, cast1.handler);
    await bus.subscribeBroadcast(MESSAGE, cast2.handler);
    const typing1 = recorder();
    const typing2 = recorder();
    const normalTyping = recorder();
    await bus.subscribeBroadcast(TYPING, typing1.handler);
    await bus.subscribeBroadcast(TYPING, typing2.handler);
    bus.subscribe(TYPING, normalTyping.handler);
    await bus.start();

    const id = await bus.publish(MESSAGE, payload("m"));
    await settle(() => cast1.count("m") >= 1 && cast2.count("m") >= 1, 2_000);
    check("each broadcast subscription receives the message event exactly once",
      cast1.count("m") === 1 && cast2.count("m") === 1, `${cast1.count("m")}, ${cast2.count("m")}`);
    check("broadcast and once-per-service deliveries share the id publish() returned",
      cast1.ids.includes(id) && normal.ids.includes(id));
    check("the once-per-service subscription still receives it once", normal.count("m") === 1, `got ${normal.count("m")}`);

    await bus.publishEphemeral(TYPING, payload("t"));
    await bus.publishEphemeral(MESSAGE, payload("t"));
    await settle(() => typing1.count("t") >= 1 && typing2.count("t") >= 1 && cast1.count("t") >= 1, 2_000);
    check("an ephemeral event reaches every broadcast subscriber",
      typing1.count("t") === 1 && typing2.count("t") === 1 && cast1.count("t") === 1 && cast2.count("t") === 1);
    check("ephemeral events never reach once-per-service subscribers",
      normalTyping.seen.length === 0 && normal.count("t") === 0);

    await bus.publish(MESSAGE, payload("early"));
    await bus.publishEphemeral(TYPING, payload("early"));
    const late = recorder();
    const lateTyping = recorder();
    await bus.subscribeBroadcast(MESSAGE, late.handler);
    await bus.subscribeBroadcast(TYPING, lateTyping.handler);
    await bus.publish(MESSAGE, payload("later"));
    await settle(() => late.count("later") >= 1, 2_000);
    check("a broadcast subscription made after an event was published does not receive it",
      late.count("early") === 0 && lateTyping.count("early") === 0);
    check("it receives events published after it subscribed", late.count("later") === 1);

    const gone = recorder();
    const off = await bus.subscribeBroadcast(MESSAGE, gone.handler);
    off();
    await bus.publish(MESSAGE, payload("after-off"));
    await settle(() => cast1.count("after-off") >= 1, 2_000);
    check("an unsubscribed broadcast handler gets nothing more", gone.seen.length === 0);
  } finally {
    await bus.stop();
  }
}

async function main() {
  console.log("\n#96 — event bus fan-out and ephemeral events");
  await inMemoryChecks();
  await redisChecks();
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
