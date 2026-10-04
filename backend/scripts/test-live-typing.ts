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

/** Every table's exact row count, so "no rows written" covers tables nobody thought of. */
async function rowCounts(): Promise<Record<string, number>> {
  const { rows: tables } = await pool.query(
    `SELECT quote_ident(table_name) AS t FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
  const counts: Record<string, number> = {};
  for (const { t } of tables) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${t}`);
    counts[t] = rows[0].n;
  }
  return counts;
}

/** Every Redis stream on the server and its entries, each flattened to one string. */
async function streamEntries(): Promise<Record<string, string[]>> {
  const { default: Redis } = await import("ioredis");
  const redis = new Redis(process.env.REDIS_URL!);
  try {
    const out: Record<string, string[]> = {};
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "TYPE", "stream", "COUNT", 500);
      cursor = next;
      for (const key of keys) {
        const entries = await redis.xrange(key, "-", "+");
        out[key] = entries.map(([id, fields]) => `${id} ${fields.join(" ")}`);
      }
    } while (cursor !== "0");
    return out;
  } finally {
    redis.disconnect();
  }
}

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
    const rowsBefore = await rowCounts();

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

    // A friend DM: only the other one of the pair hears about it.
    await befriend(alice, bob);
    await befriend(bob, mara); // bob's other friend, not in the alice–bob DM
    const dmThread = dmThreadKey(alice.id, bob.id);
    const aliceDm = open(alice);
    const bobDm = open(bob);
    const maraDm = open(mara);
    await Promise.all([aliceDm, bobDm, maraDm].map((c) => c.ready()));
    bobDm.typing(dmThread);
    // (Sockets opened before the friendship aren't subscribed to the DM until #105.)
    check("bob typing in his DM with alice reaches alice",
      await until(() => typingIn(aliceDm, dmThread).length === 1), JSON.stringify(aliceDm.frames));
    check("...naming bob", typingIn(aliceDm, dmThread)[0]?.personId === bob.id
      && typingIn(aliceDm, dmThread)[0]?.name === bob.handle, JSON.stringify(typingIn(aliceDm, dmThread)[0]));
    await sleep(300);
    check("bob's other friend and bob's own sockets never receive it",
      [maraDm, maraSocket, bobDm, bobSocket].every((c) => typingIn(c, dmThread).length === 0),
      [maraDm, maraSocket, bobDm, bobSocket].map((c) => typingIn(c, dmThread).length).join(","));

    console.log("\nTyping for a thread the sender can't see is dropped\n");

    const beforeDrops = [aliceLaptop, bobSocket, maraSocket].map((c) => c.of("typing").length);
    outsiderSocket.typing(tableThread);                     // not a member
    outsiderSocket.typing(dmThreadKey(alice.id, bob.id));    // someone else's DM
    outsiderSocket.typing(dmThreadKey(outsider.id, alice.id)); // a DM with someone who isn't a friend
    outsiderSocket.typing("campaign:not-a-uuid");            // malformed
    outsiderSocket.ws.send(JSON.stringify({ type: "typing" })); // no thread at all
    await sleep(500);
    check("an outsider's typing frames reach nobody",
      [aliceLaptop, bobSocket, maraSocket].every((c, i) => c.of("typing").length === beforeDrops[i]),
      [aliceLaptop, bobSocket, maraSocket].map((c, i) => `${c.of("typing").length - beforeDrops[i]}`).join(","));
    check("...and the outsider's socket stays open", outsiderSocket.ws.readyState === WebSocket.OPEN);

    console.log("\nA client that floods typing frames\n");

    const flood = open(mara);
    await flood.ready();
    const beforeFlood = typingIn(bobSocket, tableThread).length;
    for (let i = 0; i < 20; i++) flood.typing(tableThread);
    await sleep(500);
    check("twenty frames in a burst reach the thread once",
      typingIn(bobSocket, tableThread).length - beforeFlood === 1,
      `${typingIn(bobSocket, tableThread).length - beforeFlood} delivered`);

    console.log("\nTyping is ephemeral\n");

    const rowsAfter = await rowCounts();
    const changed = Object.keys({ ...rowsBefore, ...rowsAfter }).filter((t) => rowsBefore[t] !== rowsAfter[t]);
    check("all that typing left no database rows: every table's row count is unchanged", changed.length === 0,
      changed.map((t) => `${t}: ${rowsBefore[t]} -> ${rowsAfter[t]}`).join(", "));

    if (process.env.REDIS_URL) {
      // A real message goes through the stream, so the scan below is looking in the right place.
      const sent = await fetch(`http://127.0.0.1:${port}/api/messages/campaign/${table}`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor(alice)}`, "content-type": "application/json" },
        body: JSON.stringify({ body: `a real message ${RUN}` }),
      });
      check("a real message is saved", sent.status === 201, `status ${sent.status}`);
      const streams = await streamEntries();
      const gamenight = Object.entries(streams).find(([key]) => key.endsWith("events:gamenight"));
      check("...and lands in the Redis stream history (so the scan sees streams)",
        !!gamenight?.[1].some((e) => e.includes(`a real message ${RUN}`)), Object.keys(streams).join(", "));
      const typingKeys = Object.keys(streams).filter((k) => /letters|typing/.test(k));
      const typingEntries = Object.values(streams).flat().filter((e) => /letters\.typing|"typing"/.test(e));
      check("no Redis stream holds anything typing-related", typingKeys.length === 0 && typingEntries.length === 0,
        `streams ${typingKeys.join(", ")}; entries ${typingEntries.slice(0, 3).join(" | ")}`);
    }
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
