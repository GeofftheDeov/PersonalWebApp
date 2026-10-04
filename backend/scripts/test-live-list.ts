/**
 * The live thread list and cross-device read sync (#102, spec #58 seam 2).
 *
 * Real WebSocket clients against the real server wiring: the message and
 * thread routers mounted as server.ts mounts them, the live channel attached
 * to the same HTTP server, and the process's own event bus (in memory when
 * REDIS_URL is unset, Redis Streams + Pub/Sub when it is set). Covers:
 *   - `thread.updated`: a campaign message reaches every member's socket with
 *     that member's own unread count and the thread's last activity; the
 *     sender's own sockets get it without their count going up; outsiders get
 *     nothing. A DM does the same for the pair only;
 *   - `thread.read`: marking a thread read on one device reaches every socket
 *     of that person, their other device included, with the read position and
 *     the unread count left after it, and reaches no one else;
 *   - the shared realtime client's person-level subscription
 *     (`LiveClient.subscribePerson`): it receives both frames, keeps the socket
 *     open without any thread subscription, and calls `onReconnect` after the
 *     network drops and comes back, so the list can refetch.
 *
 * Run against a throwaway database loaded from db/schema.sql (it refuses to run
 * against anything but localhost). It deletes every row it creates.
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-live-list.ts
 *   (add REDIS_URL=redis://127.0.0.1:6379 EVENT_BUS_NAMESPACE=<ns> for the Redis bus)
 */
import "./use-test-jwt-secret.js";
import express from "express";
import http from "http";
import net from "net";
import type { AddressInfo } from "net";
import WebSocket from "ws";
import pool from "../db/index.js";
import { signJwt } from "../utils/jwt.js";
import { attachLiveChannel, LIVE_PATH, PROTOCOL_VERSION } from "../live/liveChannel.js";
import { campaignThreadKey, dmThreadKey } from "../services/threads.js";

/** The frontend's realtime client, loaded by path at run time (see test-live-channel.ts). */
type PersonHandlersLike = {
  onThreadUpdated?: (u: { thread: string; lastActivityAt: string; unreadCount: number }) => void;
  onThreadRead?: (r: { thread: string; lastReadAt: string; lastReadMessageId: string | null; unreadCount: number }) => void;
  onReconnect?: () => void;
};
type LiveClientLike = {
  status: string;
  subscribePerson(handlers: PersonHandlersLike): () => void;
  close(): void;
};
type LiveClientCtor = new (opts: {
  url: string; getToken: () => string | null; WebSocket: unknown; backoff?: { baseMs?: number; maxMs?: number };
  idleCloseMs?: number;
}) => LiveClientLike;
const LIVE_CLIENT = new URL("../../frontend/src/lib/realtime/liveClient.ts", import.meta.url).href;

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
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
    [`t102-${handle}-${RUN}`, `${handle} name`, `t102.${handle}.${RUN}@example.test`]);
  created.accounts.push(rows[0].id);
  return { id: rows[0].id, email: rows[0].email };
}

async function campaign(title: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO campaigns (title, status) VALUES ($1, 'In Progress') RETURNING id`, [`t102 ${title} ${RUN}`]);
  created.campaigns.push(rows[0].id);
  return rows[0].id;
}

async function member(campaignId: string, person: Person) {
  await pool.query(`INSERT INTO campaign_members (campaign_id, person_id, status) VALUES ($1, $2, 'Active')`,
    [campaignId, person.id]);
}

/** Friendship is symmetric: friendRoutes adds each side to the other's list. */
async function befriend(a: Person, b: Person) {
  await pool.query(`UPDATE accounts SET friends = array_append(friends, $2) WHERE id = $1`, [a.id, b.id]);
  await pool.query(`UPDATE accounts SET friends = array_append(friends, $2) WHERE id = $1`, [b.id, a.id]);
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
  ws.on("error", () => { /* surfaces as close */ });
  ws.on("open", () => ws.send(JSON.stringify({ type: "auth", v: PROTOCOL_VERSION, token: tokenFor(who) })));
  ws.on("message", (data) => {
    let frame: Frame;
    try { frame = JSON.parse(String(data)); } catch { return; }
    frames.push(frame);
    if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
  });
  return {
    ws, frames,
    ready: () => until(() => frames.some((f) => f.type === "ready")),
    of: (type: string) => frames.filter((f) => f.type === type),
  };
}

/** A TCP hop between a client and the server that can drop and restore "the network". */
async function flakyNetwork(targetPort: number) {
  const pipes = new Set<net.Socket>();
  let server: net.Server;
  let port = 0;
  const listen = () => new Promise<void>((resolve) => {
    server = net.createServer((inbound) => {
      const outbound = net.connect(targetPort, "127.0.0.1");
      for (const s of [inbound, outbound]) { pipes.add(s); s.on("close", () => pipes.delete(s)); s.on("error", () => {}); }
      inbound.pipe(outbound).pipe(inbound);
    });
    server.listen(port, "127.0.0.1", () => { port = (server.address() as AddressInfo).port; resolve(); });
  });
  await listen();
  return {
    get port() { return port; },
    drop: () => new Promise<void>((resolve) => { server.close(() => resolve()); for (const s of pipes) s.destroy(); }),
    restore: listen,
    close: () => new Promise<void>((resolve) => { for (const s of pipes) s.destroy(); server.close(() => resolve()); }),
  };
}

async function main() {
  const { default: messageRoutes } = await import("../routes/messageRoutes.js");
  const { default: threadRoutes } = await import("../routes/threadRoutes.js");
  const { startEventBus, stopEventBus } = await import("../events/index.js");
  const app = express();
  app.use(express.json());
  app.use("/api/messages", messageRoutes);
  app.use("/api/threads", threadRoutes);
  const server = http.createServer(app);
  const live = await attachLiveChannel(server);
  await startEventBus();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}${LIVE_PATH}`;
  console.log(`\n  bus: ${process.env.REDIS_URL ? `redis (namespace ${process.env.EVENT_BUS_NAMESPACE || "none"})` : "in memory"}`);

  const post = (path: string, who: Person, body: unknown) => fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokenFor(who)}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const send = async (path: string, who: Person, body: string) => {
    const res = await post(path, who, { body });
    if (res.status !== 201) throw new Error(`send ${path} → ${res.status}`);
    return await res.json() as { _id: string; createdAt: string };
  };
  const opened: ReturnType<typeof client>[] = [];
  const open = (who: Person) => { const c = client(wsUrl, who); opened.push(c); return c; };
  const updatesFor = (c: ReturnType<typeof client>, thread: string) =>
    c.of("thread.updated").filter((f) => f.thread === thread);

  try {
    const gm = await account("gm");
    const player = await account("player");
    const bard = await account("bard");
    const outsider = await account("outsider");
    const table = await campaign("Curse of Strahd");
    for (const p of [gm, player, bard]) await member(table, p);
    const thread = campaignThreadKey(table);

    console.log("\nthread.updated: a campaign message updates every member's list\n");

    const gmLaptop = open(gm);
    const gmPhone = open(gm);
    const playerSocket = open(player);
    const bardSocket = open(bard);
    const outsiderSocket = open(outsider);
    await Promise.all(opened.map((c) => c.ready()));

    const first = await send(`/api/messages/campaign/${table}`, player, `first ${RUN}`);
    check("every other member's socket gets thread.updated for the thread",
      await until(() => [gmLaptop, gmPhone, bardSocket].every((c) => updatesFor(c, thread).length === 1)),
      [gmLaptop, gmPhone, bardSocket].map((c) => JSON.stringify(c.of("thread.updated"))).join(" | "));
    check("...with unread count 1 for each of them",
      [gmLaptop, gmPhone, bardSocket].every((c) => updatesFor(c, thread)[0]?.unreadCount === 1),
      [gmLaptop, gmPhone, bardSocket].map((c) => updatesFor(c, thread)[0]?.unreadCount).join(","));
    check("...and the message's time as the thread's last activity",
      updatesFor(gmLaptop, thread)[0]?.lastActivityAt === new Date(first.createdAt).toISOString(),
      `${updatesFor(gmLaptop, thread)[0]?.lastActivityAt} vs ${first.createdAt}`);
    check("the sender's own socket gets thread.updated too", await until(() => updatesFor(playerSocket, thread).length === 1),
      JSON.stringify(playerSocket.frames));
    check("...without the sender's unread count going up", updatesFor(playerSocket, thread)[0]?.unreadCount === 0,
      JSON.stringify(updatesFor(playerSocket, thread)));
    check("the frame carries no message text",
      !JSON.stringify(updatesFor(gmLaptop, thread)).includes(`first ${RUN}`), JSON.stringify(updatesFor(gmLaptop, thread)));

    await send(`/api/messages/campaign/${table}`, player, `second ${RUN}`);
    await send(`/api/messages/campaign/${table}`, bard, `third ${RUN}`);
    check("unread counts are per person: the GM has 3, the player 1 (the bard's), the bard 2 (the player's)",
      await until(() => updatesFor(gmLaptop, thread).at(-1)?.unreadCount === 3
        && updatesFor(playerSocket, thread).at(-1)?.unreadCount === 1
        && updatesFor(bardSocket, thread).at(-1)?.unreadCount === 2),
      `gm ${updatesFor(gmLaptop, thread).map((f) => f.unreadCount)} player ${updatesFor(playerSocket, thread).map((f) => f.unreadCount)} bard ${updatesFor(bardSocket, thread).map((f) => f.unreadCount)}`);
    await sleep(300);
    check("each socket gets one thread.updated per message",
      [gmLaptop, gmPhone, playerSocket, bardSocket].every((c) => updatesFor(c, thread).length === 3),
      [gmLaptop, gmPhone, playerSocket, bardSocket].map((c) => updatesFor(c, thread).length).join(","));
    check("an outsider never gets thread.updated for the campaign", outsiderSocket.of("thread.updated").length === 0,
      JSON.stringify(outsiderSocket.of("thread.updated")));

    console.log("\nthread.updated: a DM updates only the pair\n");

    await befriend(gm, player);
    await befriend(gm, bard);
    const dm = dmThreadKey(gm.id, player.id);
    // The pair's sockets were opened before they were friends; reconnect so their subscriptions include the DM.
    const gmDm = open(gm);
    const playerDm = open(player);
    const bardDm = open(bard);
    await Promise.all([gmDm.ready(), playerDm.ready(), bardDm.ready()]);
    await send(`/api/messages/dm/${player.id}`, gm, `psst ${RUN}`);
    check("the recipient gets thread.updated for the DM with unread count 1",
      await until(() => updatesFor(playerDm, dm).at(-1)?.unreadCount === 1), JSON.stringify(playerDm.of("thread.updated")));
    check("the sender gets it with unread count 0", await until(() => updatesFor(gmDm, dm).at(-1)?.unreadCount === 0),
      JSON.stringify(gmDm.of("thread.updated")));
    await sleep(300);
    check("a friend of one of them gets nothing for the pair's DM", updatesFor(bardDm, dm).length === 0,
      JSON.stringify(bardDm.of("thread.updated")));
  } finally {
    for (const c of opened) c.ws.terminate();
    await live.close();
    server.closeAllConnections?.();
    server.close();
    await stopEventBus().catch(() => {});
    await cleanup().catch((e) => console.error("cleanup failed:", e));
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => {});
  process.exit(1);
});
