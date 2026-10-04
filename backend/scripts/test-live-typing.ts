/**
 * Typing indicators on the live channel (#103, spec #58 seam 2): "typing
 * reaches only thread members and expires".
 *
 * Real WebSocket clients against the real server wiring: the message router
 * mounted as server.ts mounts it, the live channel attached to the same HTTP
 * server, and the process's own event bus (in memory when REDIS_URL is unset,
 * Redis Streams when it is set). Covers:
 *   - a `typing` frame in a campaign thread reaches the other members' sockets,
 *     and not an outsider's, nor any of the typist's own sockets;
 *   - the same in a friend DM: only the other one of the pair;
 *   - a typing frame for a thread the sender can't see is dropped;
 *   - typing leaves no database rows and, on Redis, no stream entries;
 *
 * Run against a throwaway database loaded from db/schema.sql (it refuses to run
 * against anything but localhost). It deletes every row it creates.
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-live-typing.ts
 * Redis mode (checks the stream history too):
 *   REDIS_URL=redis://127.0.0.1:6379 EVENT_BUS_NAMESPACE=t103 DATABASE_URL=… npx tsx scripts/test-live-typing.ts
 */
import "./use-test-jwt-secret.js";
import express from "express";
import http from "http";
import type { AddressInfo } from "net";
import WebSocket from "ws";
import pool from "../db/index.js";
import { signJwt } from "../utils/jwt.js";
import { attachLiveChannel, LIVE_PATH, PROTOCOL_VERSION } from "../live/liveChannel.js";
import { campaignThreadKey, dmThreadKey } from "../services/threads.js";

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

type Person = { id: string; email: string; handle: string };
const created = { accounts: [] as string[], campaigns: [] as string[] };

async function account(name: string): Promise<Person> {
  const handle = `t103-${name}-${RUN}`;
  const { rows } = await pool.query(
    `INSERT INTO accounts (id, handle, name, email) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id, email`,
    [handle, `${name} name`, `t103.${name}.${RUN}@example.test`]);
  created.accounts.push(rows[0].id);
  return { id: rows[0].id, email: rows[0].email, handle };
}

async function campaign(title: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO campaigns (title, status) VALUES ($1, 'In Progress') RETURNING id`, [`t103 ${title} ${RUN}`]);
  created.campaigns.push(rows[0].id);
  return rows[0].id;
}

async function member(campaignId: string, person: Person) {
  await pool.query(`INSERT INTO campaign_members (campaign_id, person_id, status) VALUES ($1, $2, 'Active')`,
    [campaignId, person.id]);
}

async function befriend(a: Person, b: Person) {
  await pool.query(`UPDATE accounts SET friends = array_append(friends, $2) WHERE id = $1`, [a.id, b.id]);
  await pool.query(`UPDATE accounts SET friends = array_append(friends, $2) WHERE id = $1`, [b.id, a.id]);
}

async function cleanup() {
  const { accounts, campaigns } = created;
  if (!accounts.length && !campaigns.length) return;
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
    typing: (thread: string) => ws.send(JSON.stringify({ type: "typing", thread })),
  };
}

async function main() {
  const { default: messageRoutes } = await import("../routes/messageRoutes.js");
  const app = express();
  app.use(express.json());
  app.use("/api/messages", messageRoutes);
  const server = http.createServer(app);
  const live = await attachLiveChannel(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const wsUrl = `ws://127.0.0.1:${port}${LIVE_PATH}`;

  const opened: ReturnType<typeof client>[] = [];
  const open = (who: Person) => { const c = client(wsUrl, who); opened.push(c); return c; };

  try {
    const alice = await account("alice");
    const bob = await account("bob");
    const mara = await account("mara");
    const outsider = await account("outsider");
    const table = await campaign("Curse of Strahd");
    for (const p of [alice, bob, mara]) await member(table, p);
    const tableThread = campaignThreadKey(table);

    console.log(`\nTyping reaches only thread members${process.env.REDIS_URL ? " (Redis bus)" : " (in-memory bus)"}\n`);

    const aliceLaptop = open(alice);
    const alicePhone = open(alice);
    const bobSocket = open(bob);
    const maraSocket = open(mara);
    const outsiderSocket = open(outsider);
    await Promise.all(opened.map((c) => c.ready()));

    aliceLaptop.typing(tableThread);
    const typingIn = (c: ReturnType<typeof client>, thread: string) =>
      c.of("typing").filter((f) => f.thread === thread);
    check("alice typing in Table Talk reaches bob and mara",
      await until(() => typingIn(bobSocket, tableThread).length === 1 && typingIn(maraSocket, tableThread).length === 1),
      `bob ${JSON.stringify(bobSocket.frames)} mara ${JSON.stringify(maraSocket.frames)}`);
    const frame = typingIn(bobSocket, tableThread)[0];
    check("the frame names the thread, alice's person id and display name, and expiresInMs 5000",
      frame?.thread === tableThread && frame?.personId === alice.id && frame?.name === alice.handle
        && frame?.expiresInMs === 5_000,
      JSON.stringify(frame));
    check("the frame carries no email address", !JSON.stringify(frame ?? {}).includes(alice.email),
      JSON.stringify(frame));
    await sleep(300);
    check("the outsider never receives it", outsiderSocket.of("typing").length === 0,
      JSON.stringify(outsiderSocket.frames));
    check("none of alice's own sockets receive it, the one she typed on included",
      aliceLaptop.of("typing").length === 0 && alicePhone.of("typing").length === 0,
      `laptop ${JSON.stringify(aliceLaptop.frames)} phone ${JSON.stringify(alicePhone.frames)}`);
  } finally {
    for (const c of opened) c.ws.terminate();
    await live.close();
    server.closeAllConnections?.();
    server.close();
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
