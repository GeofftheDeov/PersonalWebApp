/**
 * The live channel recovers from Redis outages (#106, spec #58).
 *
 * The live channel needs its broadcast subscriptions (Redis SUBSCRIBE) before
 * it can take sockets. Before #106 a SUBSCRIBE that failed at boot (Redis not
 * up yet, a network blip) left `/api/live` dead until the task restarted.
 * `startLiveChannel` (what server.ts calls) now keeps trying. Covers:
 *   - Redis down at boot: no upgrades are taken and the channel retries with
 *     backoff; once Redis is reachable it attaches, and messages, thread list
 *     updates and typing reach a socket, each exactly once;
 *   - Redis dropping every connection after boot: the subscriptions come back
 *     by themselves (no new socket needed) and delivery resumes;
 *   - a subscription that fails half-way through attaching leaves nothing
 *     subscribed behind it, so retries never pile up handlers;
 *   - closing the channel while it is still retrying stops the retries and
 *     leaves no upgrade listener.
 *
 * Redis sits behind a TCP hop this script can take down and bring back, so
 * nothing outside the script is touched. The script's own HTTP routes publish
 * on the process bus, which talks to Redis directly: that is the "other
 * backend task" sending.
 *
 * Needs a throwaway database loaded from db/schema.sql and a local Redis (it
 * refuses anything but localhost for either). It deletes every row it creates.
 *   REDIS_URL=redis://127.0.0.1:6379 EVENT_BUS_NAMESPACE=t106 \
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-live-redis-recovery.ts
 */
import "./use-test-jwt-secret.js";
import express from "express";
import http from "http";
import net from "net";
import type { AddressInfo } from "net";
import WebSocket from "ws";
import pool from "../db/index.js";
import { signJwt } from "../utils/jwt.js";
import { LIVE_PATH, PROTOCOL_VERSION } from "../live/liveChannel.js";
import { startLiveChannel } from "../live/startLiveChannel.js";
import { InMemoryEventBus } from "../events/InMemoryEventBus.js";
import { createEventBus, type EventBus } from "../events/index.js";
import { campaignThreadKey } from "../services/threads.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
  process.exit(2);
}
const REDIS_URL = process.env.REDIS_URL ?? "";
if (!/\/\/(127\.0\.0\.1|localhost)[:/]/.test(REDIS_URL)) {
  console.error("\n  Refusing to run: REDIS_URL must be set to a local Redis.\n");
  process.exit(2);
}

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? pass++ : fail++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
  return cond();
}

/** Keeps reruns against the same database clear of the unique email index. */
const RUN = Math.random().toString(36).slice(2, 8);

type Person = { id: string; email: string };
const created = { accounts: [] as string[], campaigns: [] as string[] };

async function account(handle: string): Promise<Person> {
  const { rows } = await pool.query(
    `INSERT INTO accounts (id, handle, name, email) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id, email`,
    [`t106-${handle}-${RUN}`, `${handle} name`, `t106.${handle}.${RUN}@example.test`]);
  created.accounts.push(rows[0].id);
  return { id: rows[0].id, email: rows[0].email };
}

async function campaign(title: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO campaigns (title, status) VALUES ($1, 'In Progress') RETURNING id`, [`t106 ${title} ${RUN}`]);
  created.campaigns.push(rows[0].id);
  return rows[0].id;
}

async function member(campaignId: string, person: Person) {
  await pool.query(`INSERT INTO campaign_members (campaign_id, person_id, status) VALUES ($1, $2, 'Active')`,
    [campaignId, person.id]);
}

async function cleanup() {
  const { accounts, campaigns } = created;
  if (!accounts.length && !campaigns.length) return;
  await pool.query(`DELETE FROM thread_reads WHERE person_id = ANY($1::uuid[])`, [accounts]);
  await pool.query(`DELETE FROM messages WHERE campaign_id = ANY($1::uuid[]) OR sender_id = ANY($2::text[])`,
    [campaigns, accounts]);
  await pool.query(`DELETE FROM notifications WHERE user_id = ANY($1::uuid[])`, [accounts]);
  await pool.query(`DELETE FROM campaigns WHERE id = ANY($1::uuid[])`, [campaigns]);
  await pool.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [accounts]);
}

const tokenFor = (p: Person) => signJwt({ id: p.id, email: p.email });

type Frame = { type: string; [k: string]: any };

/** A raw protocol client that authenticates with the first frame and records every frame. */
function client(url: string, who: Person) {
  const ws = new WebSocket(url);
  const frames: Frame[] = [];
  let closed = false;
  ws.on("error", () => { /* surfaces as close */ });
  ws.on("close", () => { closed = true; });
  ws.on("open", () => ws.send(JSON.stringify({ type: "auth", v: PROTOCOL_VERSION, token: tokenFor(who) })));
  ws.on("message", (data) => {
    let frame: Frame;
    try { frame = JSON.parse(String(data)); } catch { return; }
    frames.push(frame);
    if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
  });
  return {
    ws, frames,
    get closed() { return closed; },
    ready: (ms?: number) => until(() => frames.some((f) => f.type === "ready"), ms),
    of: (type: string) => frames.filter((f) => f.type === type),
    typing: (thread: string) => ws.send(JSON.stringify({ type: "typing", thread })),
  };
}

/**
 * A TCP hop in front of Redis that can be down (refusing connections), come
 * up, and cut every connection through it, like Redis restarting.
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
  const cut = () => { for (const s of pipes) s.destroy(); };
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
      cut();
      if (!server) return resolve();
      server.close(() => resolve());
      server = null;
    }),
    cut,
  };
}

/** Wraps a bus to count the broadcast subscriptions currently held, and to fail chosen ones. */
function countingBus(inner: EventBus, failOn: (call: number) => boolean = () => false) {
  let calls = 0;
  let held = 0;
  const bus: EventBus = {
    publish: (event, payload) => inner.publish(event, payload),
    publishEphemeral: (event, payload) => inner.publishEphemeral(event, payload),
    subscribe: (event, handler) => inner.subscribe(event, handler),
    async subscribeBroadcast(event, handler) {
      if (failOn(++calls)) throw new Error(`injected failure on broadcast subscription ${calls}`);
      const unsubscribe = await inner.subscribeBroadcast(event, handler);
      held++;
      let done = false;
      return () => { if (!done) { done = true; held--; } unsubscribe(); };
    },
    start: () => inner.start(),
    stop: () => inner.stop(),
  };
  return { bus, get held() { return held; }, get calls() { return calls; } };
}

async function main() {
  const { default: messageRoutes } = await import("../routes/messageRoutes.js");
  const { default: threadRoutes } = await import("../routes/threadRoutes.js");
  const { startEventBus, stopEventBus } = await import("../events/index.js");
  const app = express();
  app.use(express.json());
  app.use("/api/messages", messageRoutes);
  app.use("/api/threads", threadRoutes);
  await startEventBus();

  const servers: http.Server[] = [];
  async function listen() {
    const server = http.createServer(app);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    return { server, base: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}${LIVE_PATH}` };
  }

  const opened: ReturnType<typeof client>[] = [];
  const open = (url: string, who: Person) => { const c = client(url, who); opened.push(c); return c; };
  const send = async (base: string, who: Person, campaignId: string, body: string) => {
    const res = await fetch(`${base}/api/messages/campaign/${campaignId}`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenFor(who)}`, "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });
    if (res.status !== 201) throw new Error(`send → ${res.status}`);
    return await res.json() as { _id: string };
  };
  const messagesWith = (c: ReturnType<typeof client>, id: string) =>
    c.of("message.created").filter((f) => f.message?.id === id);

  const hop = await redisHop(new URL(REDIS_URL));
  const busesToStop: EventBus[] = [];
  const handles: Array<{ close(): Promise<void> }> = [];

  try {
    const gm = await account("gm");
    const player = await account("player");
    const table = await campaign("Out of the Abyss");
    for (const p of [gm, player]) await member(table, p);
    const thread = campaignThreadKey(table);

    console.log(`\nRedis down at boot (namespace ${process.env.EVENT_BUS_NAMESPACE || "none"})\n`);

    // This "task" reaches Redis only through the hop, which is down.
    const viaHop = createEventBus({ ...process.env, REDIS_URL: hop.url });
    busesToStop.push(viaHop);
    const { server, base, wsUrl } = await listen();
    const retries: number[] = [];
    let attachedAt = 0;
    const handle = startLiveChannel(server, {
      bus: viaHop,
      retryMs: 100,
      maxRetryMs: 400,
      onRetry: (_err, delayMs) => { retries.push(delayMs); },
    });
    handles.push(handle);
    void handle.ready.then((ch) => { if (ch) attachedAt = Date.now(); });

    check("while Redis is unreachable, the channel keeps retrying",
      await until(() => retries.length >= 2, 15_000), `retries so far: ${retries.length}`);
    check("...each retry waits no longer than the cap", retries.every((ms) => ms >= 0 && ms <= 400),
      JSON.stringify(retries));
    check("...and it has not attached", attachedAt === 0);
    const early = open(wsUrl, gm);
    check("a socket opened meanwhile never gets ready (no upgrades taken)", !(await early.ready(1_000)),
      JSON.stringify(early.frames));

    await hop.up();
    check("once Redis is reachable, the channel attaches by itself", await until(() => attachedAt > 0, 15_000),
      `retries: ${retries.length}`);
    const retriesAtAttach = retries.length;

    const gmSocket = open(wsUrl, gm);
    const playerSocket = open(wsUrl, player);
    check("sockets connect and get ready", await gmSocket.ready() && await playerSocket.ready());

    const first = await send(base, player, table, `first ${RUN}`);
    check("a campaign message sent through another task reaches the gm's socket",
      await until(() => messagesWith(gmSocket, first._id).length === 1), JSON.stringify(gmSocket.frames));
    check("...with thread.updated for the thread",
      await until(() => gmSocket.of("thread.updated").some((f) => f.thread === thread && f.unreadCount === 1)),
      JSON.stringify(gmSocket.of("thread.updated")));
    playerSocket.typing(thread);
    check("typing reaches the other member",
      await until(() => gmSocket.of("typing").some((f) => f.thread === thread && f.personId === player.id)),
      JSON.stringify(gmSocket.frames));
    await sleep(300);
    check("each arrives exactly once (failed attempts left no handlers behind)",
      messagesWith(gmSocket, first._id).length === 1
        && gmSocket.of("thread.updated").filter((f) => f.thread === thread).length === 1
        && gmSocket.of("typing").length === 1,
      JSON.stringify(gmSocket.frames));
    check("no retries after attaching", retries.length === retriesAtAttach, `${retries.length} vs ${retriesAtAttach}`);

    console.log("\nRedis drops every connection after boot\n");

    await hop.down();
    await sleep(500);
    await hop.up();
    // Pub/Sub keeps nothing for a subscriber that is away, so probe with
    // typing (no rows) until the resubscription is through.
    const typingBefore = gmSocket.of("typing").length;
    let probes = 0;
    const back = await until(() => {
      if (gmSocket.of("typing").length > typingBefore) return true;
      if (probes++ % 15 === 0) playerSocket.typing(thread); // every ~300 ms, past the server's 250 ms guard
      return false;
    }, 20_000);
    check("the subscriptions come back by themselves (typing flows again)", back,
      `${gmSocket.of("typing").length} typing frames`);
    check("...on the same sockets, which never closed", !gmSocket.closed && !playerSocket.closed);
    const second = await send(base, player, table, `second ${RUN}`);
    check("a message after the outage reaches the gm exactly once",
      await until(() => messagesWith(gmSocket, second._id).length === 1)
        && (await sleep(300), messagesWith(gmSocket, second._id).length === 1),
      JSON.stringify(gmSocket.of("message.created")));

    console.log("\nA subscription failing half-way leaves nothing behind\n");

    {
      // A clean attach, to learn how many broadcast subscriptions one channel holds.
      const clean = countingBus(new InMemoryEventBus("t106"));
      const { server: s1 } = await listen();
      const h1 = startLiveChannel(s1, { bus: clean.bus, retryMs: 10, maxRetryMs: 20 });
      handles.push(h1);
      await h1.ready;
      const perChannel = clean.held;
      check("a channel holds some broadcast subscriptions", perChannel > 1, String(perChannel));

      // The first attempt's 2nd subscription fails, after its 1st succeeded.
      const flaky = countingBus(new InMemoryEventBus("t106"), (call) => call === 2);
      const { server: s2 } = await listen();
      const attempts: number[] = [];
      const h2 = startLiveChannel(s2, { bus: flaky.bus, retryMs: 10, maxRetryMs: 20, onRetry: () => attempts.push(flaky.held) });
      handles.push(h2);
      await h2.ready;
      check("the failed attempt was retried", attempts.length === 1, JSON.stringify(attempts));
      check("...after giving back what it had subscribed", attempts[0] === 0, JSON.stringify(attempts));
      check("the attached channel holds the same subscriptions as a clean one", flaky.held === perChannel,
        `${flaky.held} vs ${perChannel}`);
      await h1.close();
      await h2.close();
      check("closing gives every subscription back", clean.held === 0 && flaky.held === 0,
        `${clean.held}, ${flaky.held}`);
    }

    console.log("\nClosing while still retrying\n");

    {
      const unreachable = await redisHop(new URL(REDIS_URL)); // never brought up
      const deadBus = createEventBus({ ...process.env, REDIS_URL: unreachable.url });
      busesToStop.push(deadBus);
      const { server: s3 } = await listen();
      const tries: number[] = [];
      const h3 = startLiveChannel(s3, { bus: deadBus, retryMs: 50, maxRetryMs: 100, onRetry: (_e, ms) => tries.push(ms) });
      await until(() => tries.length >= 1, 15_000);
      check("it was retrying", tries.length >= 1);
      await h3.close();
      check("close() settles ready with null", (await h3.ready) === null);
      const after = tries.length;
      await sleep(1_500);
      check("...and no retry happens after close", tries.length === after, `${tries.length} vs ${after}`);
      check("...and no upgrade listener is left on the server", s3.listenerCount("upgrade") === 0,
        String(s3.listenerCount("upgrade")));
    }
  } finally {
    for (const c of opened) c.ws.terminate();
    for (const h of handles) await h.close().catch(() => {});
    await hop.down();
    for (const b of busesToStop) await b.stop().catch(() => {});
    for (const s of servers) { s.closeAllConnections?.(); s.close(); }
    await cleanup().catch((err) => console.error("cleanup failed:", err.message));
    await stopEventBus();
    await pool.end();
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
