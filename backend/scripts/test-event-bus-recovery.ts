/**
 * Durable event bus consumers survive Redis outages (#132).
 *
 * Before #132, `RedisStreamBus.start()` threw on XGROUP CREATE when Redis was
 * unreachable at boot, after marking itself running: no stream was ever read
 * and a later start() did nothing, so every `bus.subscribe` consumer stayed
 * dead until the task restarted. A consumer group missing at read time
 * (NOGROUP, e.g. Redis restarted without persistence) was logged every 2 s
 * and never recreated. Covers:
 *   - Redis down at boot: start() resolves, and once Redis is reachable the
 *     group is created and a published event reaches the handler;
 *   - the group destroyed while the bus runs: it is recreated and reading
 *     resumes;
 *   - the stream deleted outright (group and all): the same.
 *
 * Redis sits behind a TCP hop the script takes down and brings back, so
 * nothing outside the script is touched. Streams, groups and namespaces are
 * `t132`-prefixed and random per run; everything written is deleted at the end.
 *
 * Needs the docker-compose Redis (`docker compose up -d redis`):
 *   REDIS_URL=redis://127.0.0.1:6379 npx tsx scripts/test-event-bus-recovery.ts
 */
import { randomUUID } from "node:crypto";
import net from "net";
import type { AddressInfo } from "net";
import { Redis } from "ioredis";
import { RedisStreamBus, busNames } from "../events/RedisStreamBus.js";
import type { EventName } from "../events/index.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
if (!/\/\/(127\.0\.0\.1|localhost)[:/]/.test(REDIS_URL)) {
  console.error("\n  Refusing to run: REDIS_URL must be a local Redis.\n");
  process.exit(2);
}

const run = randomUUID().slice(0, 8);
// A test-only event name under a per-run domain no real subscriber reads.
const DOMAIN = `t132${run}`;
const PING = `${DOMAIN}.ping` as EventName;
const GROUP = "t132-group";
const NS = `t132${run}`;
const names = busNames(NS);
const STREAM = names.stream(PING);
const FULL_GROUP = names.group(GROUP);

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? pass++ : fail++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(50);
  }
  return cond();
}

/**
 * A TCP hop in front of Redis that can be down (refusing connections) and
 * come up.
 */
async function redisHop(target: URL) {
  const pipes = new Set<net.Socket>();
  let server: net.Server | null = null;
  // Reserve a port, then let it go: "down" means nothing listens there.
  const port = await new Promise<number>((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(p));
    });
  });
  return {
    url: `redis://127.0.0.1:${port}`,
    up: () => new Promise<void>((resolve) => {
      server = net.createServer((inbound) => {
        const outbound = net.connect(Number(target.port || 6379), target.hostname);
        for (const s of [inbound, outbound]) { pipes.add(s); s.on("close", () => pipes.delete(s)); s.on("error", () => {}); }
        inbound.pipe(outbound).pipe(inbound);
      });
      server.listen(port, "127.0.0.1", () => resolve());
    }),
    down: () => new Promise<void>((resolve) => {
      for (const s of pipes) s.destroy();
      if (!server) return resolve();
      server.close(() => resolve());
      server = null;
    }),
  };
}

async function main() {
  const direct = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  const hop = await redisHop(new URL(REDIS_URL));
  const received: string[] = [];
  const bus = new RedisStreamBus({ url: hop.url, group: GROUP, namespace: NS, consumer: `t132-${run}` });
  bus.subscribe(PING, (payload: any) => { received.push(payload.n); });

  async function groupExists() {
    const groups = (await direct.xinfo("GROUPS", STREAM).catch(() => [])) as any[];
    return groups.some((g) => g[g.indexOf("name") + 1] === FULL_GROUP);
  }
  /** XADDs like the bus does, straight to Redis (another task publishing). */
  async function publish(n: string) {
    await direct.xadd(STREAM, "*", "name", PING, "ts", new Date().toISOString(), "source", "t132", "payload", JSON.stringify({ n }));
  }

  try {
    console.log("\n  Redis down at boot");
    const started = await bus.start().then(() => true, (err) => (console.error(err), false));
    check("start() resolves while Redis is unreachable", started);
    check("no group exists yet", !(await groupExists()));

    await hop.up();
    check("the group is created once Redis is reachable", await until(groupExists, 15_000));
    await publish("after-boot");
    check("an event published then reaches the handler", await until(() => received.includes("after-boot"), 10_000), `received=${JSON.stringify(received)}`);

    console.log("\n  Group destroyed while running");
    await direct.xgroup("DESTROY", STREAM, FULL_GROUP);
    check("the group is recreated", await until(groupExists, 15_000));
    await publish("after-destroy");
    check("reading resumes", await until(() => received.includes("after-destroy"), 10_000), `received=${JSON.stringify(received)}`);

    console.log("\n  Stream deleted while running");
    await direct.del(STREAM);
    check("the stream and group are recreated", await until(groupExists, 15_000));
    await publish("after-del");
    check("reading resumes", await until(() => received.includes("after-del"), 10_000), `received=${JSON.stringify(received)}`);

    check("each event was handled exactly once", received.length === 3, `received=${JSON.stringify(received)}`);
  } finally {
    await bus.stop();
    await hop.down();
    await direct.del(STREAM).catch(() => {});
    await direct.quit();
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
