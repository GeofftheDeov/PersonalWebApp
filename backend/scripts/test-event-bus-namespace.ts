/**
 * Event bus namespaces (#118): prod and dev share one Redis, so each
 * environment's bus must keep to its own streams, consumer groups and pub/sub
 * channels. A Redis logical database (`/1`) would not do it, because pub/sub
 * ignores the database number.
 *
 * Each "process" is a separate bus instance with its own Redis connections and
 * consumer name, which is how two backend tasks look to Redis. Every bus here
 * uses the same consumer-group name, as prod and dev do today (`backend`), so
 * only the namespace keeps them apart. Namespaces and event domains are
 * `t118`-prefixed and random per run; everything written is deleted at the end.
 *
 * Needs the docker-compose Redis (`docker compose up -d redis`):
 *   REDIS_URL=redis://127.0.0.1:6379 npx tsx scripts/test-event-bus-namespace.ts
 */
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { RedisStreamBus } from "../events/RedisStreamBus.js";
import { InMemoryEventBus } from "../events/InMemoryEventBus.js";
import { createEventBus } from "../events/index.js";
import type { EventBus, EventEnvelope, EventName } from "../events/index.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
if (!/\/\/(127\.0\.0\.1|localhost)[:/]/.test(REDIS_URL)) {
  console.error("\n  Refusing to run: REDIS_URL must be a local Redis.\n");
  process.exit(2);
}

const run = randomUUID().slice(0, 8);
// Test-only event names under a per-run domain no real subscriber reads.
const DOMAIN = `t118${run}`;
const MESSAGE = `${DOMAIN}.message` as EventName;
const TYPING = `${DOMAIN}.typing` as EventName;
const GROUP = "t118-group";
const NS_A = `t118a${run}`;
const NS_B = `t118b${run}`;

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? pass++ : fail++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until `cond` holds (or `ms` passes), then a little longer so strays would show up. */
async function settle(cond: () => boolean, ms = 8_000) {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) await sleep(25);
  await sleep(600);
}

/** Records every delivery a handler sees, keyed by the payload's marker. */
function recorder() {
  const seen: string[] = [];
  const handler = (payload: any, _meta: EventEnvelope) => { seen.push(payload.marker); };
  return { seen, handler, count: (m: string) => seen.filter((s) => s === m).length };
}

const payload = (marker: string) => ({ marker }) as any;

const admin = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
const buses: EventBus[] = [];

function redisBus(namespace: string | undefined, consumer: string): RedisStreamBus {
  const bus = new RedisStreamBus({ url: REDIS_URL, group: GROUP, source: "t118-check", consumer: `${consumer}-${run}`, namespace });
  buses.push(bus);
  return bus;
}

async function isolationChecks() {
  console.log("\nDifferent namespaces, same group name — nothing crosses\n");
  const a = redisBus(NS_A, "t118-a");
  const b = redisBus(NS_B, "t118-b");

  const normalA = recorder();
  const normalB = recorder();
  a.subscribe(MESSAGE, normalA.handler);
  b.subscribe(MESSAGE, normalB.handler);
  await a.start();
  await b.start();

  const fromA = `a-${run}`;
  const fromB = `b-${run}`;
  await a.publish(MESSAGE, payload(fromA));
  await b.publish(MESSAGE, payload(fromB));
  await settle(() => normalA.count(fromA) >= 1 && normalB.count(fromB) >= 1);
  check("a once-per-service subscription receives its own namespace's event",
    normalA.count(fromA) === 1 && normalB.count(fromB) === 1, `A ${normalA.count(fromA)}, B ${normalB.count(fromB)}`);
  check("a once-per-service subscription never receives another namespace's event",
    normalA.count(fromB) === 0 && normalB.count(fromA) === 0, `A got B's ${normalA.count(fromB)}, B got A's ${normalB.count(fromA)}`);

  const castA = recorder();
  const castB = recorder();
  const typingA = recorder();
  const typingB = recorder();
  await a.subscribeBroadcast(MESSAGE, castA.handler);
  await b.subscribeBroadcast(MESSAGE, castB.handler);
  await a.subscribeBroadcast(TYPING, typingA.handler);
  await b.subscribeBroadcast(TYPING, typingB.handler);

  const castFromA = `cast-a-${run}`;
  const castFromB = `cast-b-${run}`;
  await a.publish(MESSAGE, payload(castFromA));
  await b.publish(MESSAGE, payload(castFromB));
  await settle(() => castA.count(castFromA) >= 1 && castB.count(castFromB) >= 1);
  check("a broadcast subscription receives its own namespace's published event",
    castA.count(castFromA) === 1 && castB.count(castFromB) === 1, `A ${castA.count(castFromA)}, B ${castB.count(castFromB)}`);
  check("a broadcast subscription never receives another namespace's published event",
    castA.count(castFromB) === 0 && castB.count(castFromA) === 0, `A got B's ${castA.count(castFromB)}, B got A's ${castB.count(castFromA)}`);

  const ephFromA = `eph-a-${run}`;
  const ephFromB = `eph-b-${run}`;
  await a.publishEphemeral(TYPING, payload(ephFromA));
  await b.publishEphemeral(TYPING, payload(ephFromB));
  await settle(() => typingA.count(ephFromA) >= 1 && typingB.count(ephFromB) >= 1);
  check("an ephemeral event reaches its own namespace's broadcast subscriber",
    typingA.count(ephFromA) === 1 && typingB.count(ephFromB) === 1, `A ${typingA.count(ephFromA)}, B ${typingB.count(ephFromB)}`);
  check("an ephemeral event never reaches another namespace's broadcast subscriber",
    typingA.count(ephFromB) === 0 && typingB.count(ephFromA) === 0, `A got B's ${typingA.count(ephFromB)}, B got A's ${typingB.count(ephFromA)}`);
}

async function sameNamespaceChecks() {
  console.log("\nSame namespace, two instances — today's semantics\n");
  const ns = `t118s${run}`;
  const a = redisBus(ns, "t118-s1");
  const b = redisBus(ns, "t118-s2");
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

  const batch = Array.from({ length: 10 }, (_, i) => `same-${run}-${i}`);
  for (const [i, m] of batch.entries()) await (i % 2 ? a : b).publish(MESSAGE, payload(m));
  const handled = () => batch.map((m) => normalA.count(m) + normalB.count(m));
  await settle(() => handled().every((n) => n >= 1) && batch.every((m) => castA.count(m) >= 1 && castB.count(m) >= 1));
  check("a once-per-service subscription processes each event exactly once between the two instances",
    handled().every((n) => n === 1), `per-event counts ${JSON.stringify(handled())}`);
  check("broadcast subscriptions in both instances receive every event once",
    batch.every((m) => castA.count(m) === 1 && castB.count(m) === 1),
    `A ${JSON.stringify(batch.map(castA.count))}, B ${JSON.stringify(batch.map(castB.count))}`);
}

/** Collects messages an outside client sees on a Pub/Sub channel. */
async function listen(channel: string) {
  const sub = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
  const got: string[] = [];
  sub.on("message", (_c: string, m: string) => got.push(JSON.parse(JSON.parse(m).payload).marker));
  await sub.subscribe(channel);
  return { got, close: () => sub.quit() };
}

async function environmentChecks() {
  console.log("\nNamespace from the environment; unset keeps today's names\n");
  const ns = `t118e${run}`;
  const fromEnv = createEventBus({ REDIS_URL, EVENT_BUS_NAMESPACE: ns, EVENT_BUS_GROUP: GROUP, EVENT_BUS_SOURCE: "t118-check" });
  const unsetEnv = createEventBus({ REDIS_URL, EVENT_BUS_GROUP: GROUP, EVENT_BUS_SOURCE: "t118-check" });
  buses.push(fromEnv, unsetEnv);
  const sameNs = redisBus(ns, "t118-e-same");
  const legacy = redisBus(undefined, "t118-e-legacy");

  const seenSame = recorder();
  const seenLegacy = recorder();
  sameNs.subscribe(MESSAGE, seenSame.handler);
  legacy.subscribe(MESSAGE, seenLegacy.handler);
  await sameNs.start();
  await legacy.start();
  const castSame = recorder();
  const castLegacy = recorder();
  await sameNs.subscribeBroadcast(MESSAGE, castSame.handler);
  await legacy.subscribeBroadcast(MESSAGE, castLegacy.handler);
  const legacyChannel = await listen(`events:live:${MESSAGE}`);
  const nsChannel = await listen(`${ns}:events:live:${MESSAGE}`);

  const envMarker = `env-${run}`;
  const unsetMarker = `unset-${run}`;
  await fromEnv.publish(MESSAGE, payload(envMarker));
  await unsetEnv.publish(MESSAGE, payload(unsetMarker));
  await settle(() => seenSame.count(envMarker) >= 1 && seenLegacy.count(unsetMarker) >= 1
    && legacyChannel.got.includes(unsetMarker) && nsChannel.got.includes(envMarker));

  check("a bus built with EVENT_BUS_NAMESPACE reaches buses in that namespace (once-per-service and broadcast)",
    seenSame.count(envMarker) === 1 && castSame.count(envMarker) === 1, `subscribe ${seenSame.count(envMarker)}, broadcast ${castSame.count(envMarker)}`);
  check("an un-namespaced bus (old tasks during cutover) never sees the namespaced event",
    seenLegacy.count(envMarker) === 0 && castLegacy.count(envMarker) === 0, `subscribe ${seenLegacy.count(envMarker)}, broadcast ${castLegacy.count(envMarker)}`);
  check("a bus built without EVENT_BUS_NAMESPACE reaches un-namespaced buses",
    seenLegacy.count(unsetMarker) === 1 && castLegacy.count(unsetMarker) === 1, `subscribe ${seenLegacy.count(unsetMarker)}, broadcast ${castLegacy.count(unsetMarker)}`);
  check("a namespaced bus never sees the un-namespaced event",
    seenSame.count(unsetMarker) === 0 && castSame.count(unsetMarker) === 0, `subscribe ${seenSame.count(unsetMarker)}, broadcast ${castSame.count(unsetMarker)}`);

  const groupNames = async (stream: string) =>
    (await admin.exists(stream)) ? ((await admin.xinfo("GROUPS", stream)) as any[]).map((g) => g[1]) : [];
  const legacyStream = `events:${DOMAIN}`;
  const nsStream = `${ns}:events:${DOMAIN}`;
  const legacyHas = (await admin.xrange(legacyStream, "-", "+")).map(([, f]) => f.join(" "));
  const nsHas = (await admin.xrange(nsStream, "-", "+")).map(([, f]) => f.join(" "));
  check("unset namespace: the event is in today's stream `events:<domain>`, read by today's group name",
    legacyHas.some((f) => f.includes(unsetMarker)) && !legacyHas.some((f) => f.includes(envMarker))
      && (await groupNames(legacyStream)).includes(GROUP),
    `entries ${legacyHas.length}, groups ${JSON.stringify(await groupNames(legacyStream))}`);
  check("namespace set: the event is in `<ns>:events:<domain>`, read by group `<ns>:<group>`",
    nsHas.some((f) => f.includes(envMarker)) && !nsHas.some((f) => f.includes(unsetMarker))
      && JSON.stringify(await groupNames(nsStream)) === JSON.stringify([`${ns}:${GROUP}`]),
    `entries ${nsHas.length}, groups ${JSON.stringify(await groupNames(nsStream))}`);
  check("unset namespace: broadcast goes out on today's channel `events:live:<name>` only",
    JSON.stringify(legacyChannel.got) === JSON.stringify([unsetMarker]), `got ${JSON.stringify(legacyChannel.got)}`);
  check("namespace set: broadcast goes out on `<ns>:events:live:<name>` only",
    JSON.stringify(nsChannel.got) === JSON.stringify([envMarker]), `got ${JSON.stringify(nsChannel.got)}`);
  await legacyChannel.close();
  await nsChannel.close();

  check("without REDIS_URL the in-memory bus is used, namespace or not",
    createEventBus({ EVENT_BUS_NAMESPACE: ns }) instanceof InMemoryEventBus && createEventBus({}) instanceof InMemoryEventBus);
  let threw = "";
  try { createEventBus({ REDIS_URL, EVENT_BUS_NAMESPACE: "prod:*" }); } catch (e: any) { threw = e.message; }
  check("a namespace with characters outside [A-Za-z0-9_-] is refused at construction", threw !== "", "did not throw");
}

async function main() {
  console.log("\n#118 — event bus namespaces");
  try {
    await isolationChecks();
    await sameNamespaceChecks();
    await environmentChecks();
  } finally {
    await Promise.allSettled(buses.map((bus) => bus.stop()));
    const keys = await admin.keys(`*${run}*`);
    if (keys.length) await admin.del(...keys);
    await admin.quit();
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
