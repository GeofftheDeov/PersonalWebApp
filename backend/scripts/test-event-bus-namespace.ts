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
}

async function main() {
  console.log("\n#118 — event bus namespaces");
  try {
    await isolationChecks();
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
