/**
 * Friend DMs on the live channel (#99, spec #58 seam 2): "DMs reach only the pair".
 *
 * Real WebSocket clients against the real server wiring: the message router
 * mounted as server.ts mounts it, the live channel attached to the same HTTP
 * server, and the process's own event bus (in memory here, since REDIS_URL is
 * unset). Covers:
 *   - a DM between two friends reaches both of their sockets, the sender's
 *     other device included, as `message.created` on the DM thread, the same
 *     frame shape campaign messages use, without email addresses;
 *   - it never reaches a third socket: a friend of one of them, or a stranger;
 *   - the campaign and DM SSE stream endpoints are gone (404);
 *   - the shared realtime client carries a campaign thread and a DM thread on
 *     one WebSocket connection, as the dock and a campaign page do in a tab.
 *
 * Run against a throwaway database loaded from db/schema.sql (it refuses to run
 * against anything but localhost). It deletes every row it creates.
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-live-dms.ts
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

/** The frontend's realtime client, loaded by path at run time (see test-live-channel.ts). */
type LiveClientLike = {
  status: string;
  threadStatus(thread: string): string;
  subscribe(thread: string, handlers: {
    onMessage?: (m: { body: string }, thread: string) => void; onReconnect?: () => void;
  }): () => void;
  close(): void;
};
type LiveClientCtor = new (opts: { url: string; getToken: () => string | null; WebSocket: unknown }) => LiveClientLike;
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
    [`t99-${handle}-${RUN}`, `${handle} name`, `t99.${handle}.${RUN}@example.test`]);
  created.accounts.push(rows[0].id);
  return { id: rows[0].id, email: rows[0].email };
}

async function campaign(title: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO campaigns (title, status) VALUES ($1, 'In Progress') RETURNING id`, [`t99 ${title} ${RUN}`]);
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

async function main() {
  const { default: messageRoutes } = await import("../routes/messageRoutes.js");
  const app = express();
  app.use(express.json());
  app.use("/api/messages", messageRoutes);
  const server = http.createServer(app);
  let upgrades = 0;
  server.on("upgrade", () => { upgrades++; });
  const live = await attachLiveChannel(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}${LIVE_PATH}`;

  const post = (path: string, who: Person, body: unknown) => fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokenFor(who)}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const opened: ReturnType<typeof client>[] = [];
  const open = (who: Person) => { const c = client(wsUrl, who); opened.push(c); return c; };

  try {
    const alice = await account("alice");
    const bob = await account("bob");
    const carol = await account("carol"); // alice's friend, not in the alice–bob DM
    const stranger = await account("stranger");
    await befriend(alice, bob);
    await befriend(alice, carol);
    const thread = dmThreadKey(alice.id, bob.id);

    console.log("\nDMs reach only the pair\n");

    const aliceLaptop = open(alice);
    const alicePhone = open(alice);
    const bobSocket = open(bob);
    const carolSocket = open(carol);
    const strangerSocket = open(stranger);
    await Promise.all(opened.map((c) => c.ready()));
    check("`ready` lists the DM thread for both of the pair",
      [aliceLaptop, bobSocket].every((c) => c.of("ready")[0]?.threads?.includes(thread)),
      JSON.stringify([aliceLaptop.of("ready")[0], bobSocket.of("ready")[0]]));

    const sent = await post(`/api/messages/dm/${bob.id}`, alice, { body: `psst ${RUN}` });
    const saved = await sent.json() as any;
    check("alice's DM to bob is saved", sent.status === 201, `status ${sent.status}`);
    const got = (c: ReturnType<typeof client>) =>
      c.of("message.created").some((f) => f.thread === thread && f.message?.body === `psst ${RUN}`);
    check("bob receives it as message.created on the DM thread", await until(() => got(bobSocket)),
      JSON.stringify(bobSocket.frames));
    check("alice's own sockets receive it too, her other device included",
      await until(() => got(aliceLaptop) && got(alicePhone)),
      `laptop ${JSON.stringify(aliceLaptop.frames)} phone ${JSON.stringify(alicePhone.frames)}`);

    const frame = bobSocket.of("message.created")[0];
    check("the frame has the campaign frame's shape: thread, and message id, sender, body, createdAt",
      frame?.thread === thread && frame?.message?.id === String(saved._id)
        && frame?.message?.sender?.id === alice.id && typeof frame?.message?.sender?.name === "string"
        && frame?.message?.body === `psst ${RUN}` && typeof frame?.message?.createdAt === "string",
      JSON.stringify(frame));
    check("the frame carries no email address",
      !JSON.stringify(frame ?? {}).includes(alice.email) && !JSON.stringify(frame ?? {}).includes(bob.email),
      JSON.stringify(frame));

    const reply = await post(`/api/messages/dm/${alice.id}`, bob, { body: `hi back ${RUN}` });
    check("bob's reply is saved", reply.status === 201, `status ${reply.status}`);
    check("bob's reply reaches both of alice's devices and bob's own socket",
      await until(() => [aliceLaptop, alicePhone, bobSocket].every((c) =>
        c.of("message.created").some((f) => f.thread === thread && f.message?.body === `hi back ${RUN}`))));

    await sleep(400);
    check("alice's other friend never receives the pair's DMs", carolSocket.of("message.created").length === 0,
      JSON.stringify(carolSocket.frames));
    check("a stranger never receives them", strangerSocket.of("message.created").length === 0,
      JSON.stringify(strangerSocket.frames));
    check("each socket of the pair receives each DM exactly once",
      [aliceLaptop, alicePhone, bobSocket].every((c) => c.of("message.created").length === 2),
      [aliceLaptop, alicePhone, bobSocket].map((c) => c.of("message.created").length).join(","));

    console.log("\nSSE retired\n");

    const table = await campaign("Curse of Strahd");
    await member(table, alice);
    for (const [label, path] of [
      ["campaign", `/api/messages/campaign/${table}/stream`],
      ["DM", `/api/messages/dm/${bob.id}/stream`],
    ] as const) {
      const ctl = new AbortController();
      const res = await fetch(`${base}${path}?token=${encodeURIComponent(tokenFor(alice))}`, { signal: ctl.signal });
      const type = res.headers.get("content-type") ?? "";
      ctl.abort();
      check(`the ${label} SSE stream endpoint is gone (404)`, res.status === 404 && !type.includes("event-stream"),
        `got ${res.status} ${type}`);
    }

    console.log("\nOne connection for every thread\n");

    const { LiveClient } = await import(LIVE_CLIENT) as { LiveClient: LiveClientCtor };
    const before = upgrades;
    const lc = new LiveClient({ url: wsUrl, getToken: () => tokenFor(alice), WebSocket });
    const seen: string[] = [];
    // As the dock (a DM) and a campaign page (Table Talk) subscribe in one tab.
    const offDm = lc.subscribe(thread, { onMessage: (m, t) => seen.push(`${t} ${m.body}`) });
    const offTable = lc.subscribe(campaignThreadKey(table), { onMessage: (m, t) => seen.push(`${t} ${m.body}`) });
    check("the client connects", await until(() => lc.status === "open"), lc.status);
    await post(`/api/messages/dm/${alice.id}`, bob, { body: `dock ${RUN}` });
    await post(`/api/messages/campaign/${table}`, alice, { body: `table ${RUN}` });
    check("a DM and a campaign message both arrive through the one client",
      await until(() => seen.includes(`${thread} dock ${RUN}`) && seen.includes(`${campaignThreadKey(table)} table ${RUN}`)),
      JSON.stringify(seen));
    check("both threads share one WebSocket connection", upgrades - before === 1, `${upgrades - before} upgrades`);

    console.log("\nA friend added while the socket is open\n");

    // The server works out a socket's threads at connect (#105 will follow
    // changes live). Until then, opening a thread the open socket wasn't
    // subscribed to makes the client reconnect once, so a DM with a brand-new
    // friend is live without a reload, as it was with its own SSE stream.
    const dave = await account("dave");
    await befriend(alice, dave);
    const newThread = dmThreadKey(alice.id, dave.id);
    const reconnects: number[] = [];
    const beforeNew = upgrades;
    const offNew = lc.subscribe(newThread, {
      onMessage: (m, t) => seen.push(`${t} ${m.body}`),
      onReconnect: () => reconnects.push(Date.now()),
    });
    check("opening the new friend's DM brings it live", await until(() => lc.threadStatus(newThread) === "open"),
      lc.threadStatus(newThread));
    check("...with one reconnect", upgrades - beforeNew === 1 && reconnects.length === 1,
      `${upgrades - beforeNew} upgrades, ${reconnects.length} reconnects`);
    await post(`/api/messages/dm/${alice.id}`, dave, { body: `new friend ${RUN}` });
    check("the new friend's DM arrives live", await until(() => seen.includes(`${newThread} new friend ${RUN}`)),
      JSON.stringify(seen));
    check("threads open before the reconnect stay live after it", lc.threadStatus(thread) === "open"
      && lc.threadStatus(campaignThreadKey(table)) === "open");

    const beforeStranger = upgrades;
    const offStranger = lc.subscribe(dmThreadKey(alice.id, stranger.id), {});
    await sleep(600);
    check("a thread the person still can't see stays unavailable after at most one reconnect",
      lc.threadStatus(dmThreadKey(alice.id, stranger.id)) === "unavailable" && upgrades - beforeStranger <= 1,
      `${lc.threadStatus(dmThreadKey(alice.id, stranger.id))}, ${upgrades - beforeStranger} upgrades`);
    offStranger();
    offNew();
    offDm();
    offTable();
    lc.close();
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
