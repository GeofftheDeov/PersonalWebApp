/**
 * Live channel (#98, spec #58 seam 2): Table Talk over one authenticated
 * WebSocket per person.
 *
 * Real WebSocket clients against the real server wiring: the message router
 * mounted as server.ts mounts it, the live channel attached to the same HTTP
 * server, and the process's own event bus (in memory here, since REDIS_URL is
 * unset). Covers:
 *   - auth: first-frame token, query-parameter token; missing, malformed,
 *     wrong-secret, expired and silent connections refused with the auth close
 *     code; an unknown protocol version refused with its own code;
 *   - delivery: a campaign message reaches both members as `message.created`
 *     and never reaches an outsider (or an admin who isn't a member);
 *   - automated posts: the ready check arrives live like any other message;
 *   - heartbeat: `ping` every 25 seconds by default, and a socket that stops
 *     answering is dropped while one that answers stays;
 *   - the shared realtime client (frontend/src/lib/realtime/liveClient.ts):
 *     it connects, delivers per-thread, and after the network drops and comes
 *     back it reconnects on its own and tells the thread to refetch, which
 *     then shows what was sent in the meantime.
 *
 * Run against a throwaway database loaded from db/schema.sql (it refuses to run
 * against anything but localhost). It deletes every row it creates. Takes about
 * 30 seconds, most of it waiting for the default 25-second ping.
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-live-channel.ts
 */
import "./use-test-jwt-secret.js";
import crypto from "crypto";
import express from "express";
import http from "http";
import net from "net";
import type { AddressInfo } from "net";
import WebSocket from "ws";
import pool from "../db/index.js";
import { signJwt } from "../utils/jwt.js";
import { attachLiveChannel, LIVE_PATH, CLOSE_UNAUTHORIZED, CLOSE_UNSUPPORTED_VERSION, PROTOCOL_VERSION } from "../live/liveChannel.js";
import { campaignThreadKey } from "../services/threads.js";

/**
 * The frontend's realtime client, loaded by path at run time. The backend's
 * Docker build sees only backend/, so a static import would break `tsc` there.
 */
type LiveClientLike = {
  status: string;
  onStatus(listener: (status: string) => void): () => void;
  subscribe(thread: string, handlers: { onMessage?: (m: { body: string }) => void; onReconnect?: () => void }): () => void;
  close(): void;
};
type LiveClientCtor = new (opts: {
  url: string; getToken: () => string | null; WebSocket: unknown; backoff?: { baseMs?: number; maxMs?: number };
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

async function account(handle: string, appRole: "user" | "admin" = "user"): Promise<Person> {
  const { rows } = await pool.query(
    `INSERT INTO accounts (id, handle, name, email, app_role)
     VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id, email`,
    [`t98-${handle}-${RUN}`, `${handle} name`, `t98.${handle}.${RUN}@example.test`, appRole]);
  created.accounts.push(rows[0].id);
  return { id: rows[0].id, email: rows[0].email };
}

async function campaign(title: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO campaigns (title, status) VALUES ($1, 'In Progress') RETURNING id`, [`t98 ${title} ${RUN}`]);
  created.campaigns.push(rows[0].id);
  return rows[0].id;
}

async function member(campaignId: string, person: Person, status = "Active") {
  await pool.query(
    `INSERT INTO campaign_members (campaign_id, person_id, status) VALUES ($1, $2, $3)`,
    [campaignId, person.id, status]);
}

async function cleanup() {
  const { accounts, campaigns } = created;
  if (!accounts.length && !campaigns.length) return;
  await pool.query(`DELETE FROM messages WHERE campaign_id = ANY($1::uuid[]) OR sender_id = ANY($2::text[])`,
    [campaigns, accounts]);
  await pool.query(`DELETE FROM notifications WHERE user_id = ANY($1::uuid[])`, [accounts]);
  await pool.query(`DELETE FROM campaigns WHERE id = ANY($1::uuid[])`, [campaigns]); // cascades sessions
  await pool.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [accounts]);
}

const tokenFor = (p: Person) => signJwt({ id: p.id, email: p.email });

/** An HS256 token with a valid shape, signed with some other secret. */
function wrongSecretToken(p: Person): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ id: p.id, email: p.email, iat: Math.floor(Date.now() / 1000) })}`;
  return `${head}.${crypto.createHmac("sha256", "not-the-secret").update(head).digest("base64url")}`;
}

type Frame = { type: string; [k: string]: any };

/** A raw protocol client: records every frame, answers pings unless told not to. */
function client(url: string, opts: { first?: unknown; answerPings?: boolean } = {}) {
  const ws = new WebSocket(url);
  const frames: Frame[] = [];
  const pingTimes: number[] = [];
  const opened = Date.now();
  let closeCode: number | null = null;
  const closed = new Promise<number>((resolve) => ws.on("close", (code) => { closeCode = code; resolve(code); }));
  ws.on("error", () => { /* surfaces as close */ });
  ws.on("open", () => {
    if (opts.first !== undefined) ws.send(typeof opts.first === "string" ? opts.first : JSON.stringify(opts.first));
  });
  ws.on("message", (data) => {
    let frame: Frame;
    try { frame = JSON.parse(String(data)); } catch { return; }
    frames.push(frame);
    if (frame.type === "ping") {
      pingTimes.push(Date.now() - opened);
      if (opts.answerPings !== false) ws.send(JSON.stringify({ type: "pong" }));
    }
  });
  return {
    ws, frames, pingTimes, closed,
    get closeCode() { return closeCode; },
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
    /** Cut every connection and refuse new ones. */
    drop: () => new Promise<void>((resolve) => { server.close(() => resolve()); for (const s of pipes) s.destroy(); }),
    restore: listen,
    close: () => new Promise<void>((resolve) => { for (const s of pipes) s.destroy(); server.close(() => resolve()); }),
  };
}

async function main() {
  const { default: messageRoutes } = await import("../routes/messageRoutes.js");
  const { runReadyCheckSweep } = await import("../utils/readyCheck.js");
  const app = express();
  app.use(express.json());
  app.use("/api/messages", messageRoutes);
  const server = http.createServer(app);
  // Default heartbeat (25 s); a short auth timeout so the silent-client check is quick.
  const live = await attachLiveChannel(server, { authTimeoutMs: 400 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}${LIVE_PATH}`;

  // A second channel with a fast heartbeat, for the drop check.
  const fastServer = http.createServer(app);
  const fastLive = await attachLiveChannel(fastServer, { pingIntervalMs: 150 });
  await new Promise<void>((r) => fastServer.listen(0, "127.0.0.1", () => r()));
  const fastUrl = `ws://127.0.0.1:${(fastServer.address() as AddressInfo).port}${LIVE_PATH}`;

  const post = (path: string, who: Person, body: unknown) => fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokenFor(who)}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const auth = (p: Person) => ({ type: "auth", v: PROTOCOL_VERSION, token: tokenFor(p) });
  const opened: ReturnType<typeof client>[] = [];
  const open = (url: string, opts: Parameters<typeof client>[1] = {}) => { const c = client(url, opts); opened.push(c); return c; };

  try {
    const gm = await account("gm");
    const player = await account("player");
    const outsider = await account("outsider");
    const admin = await account("admin", "admin");
    const table = await campaign("Curse of Strahd");
    const elsewhere = await campaign("Lost Mine");
    await member(table, gm, "Game Master");
    await member(table, player);
    await member(elsewhere, outsider);
    const thread = campaignThreadKey(table);

    // Opened first: it waits out the default 25-second ping while the rest runs.
    const heartbeatWatcher = open(wsUrl, { first: auth(outsider) });

    console.log("\nAuth\n");

    const g = open(wsUrl, { first: auth(gm) });
    check("a valid token in the first frame is accepted with `ready`", await g.ready(),
      `frames ${JSON.stringify(g.frames)} close ${g.closeCode}`);
    check("`ready` carries the protocol version and the threads this person sees",
      g.of("ready")[0]?.v === PROTOCOL_VERSION && g.of("ready")[0]?.threads?.includes(thread),
      JSON.stringify(g.of("ready")[0]));

    const q = open(`${wsUrl}?token=${encodeURIComponent(tokenFor(player))}`);
    check("a token in the query parameter is accepted too", await q.ready(), `close ${q.closeCode}`);

    const refused: [string, unknown][] = [
      ["a missing token", { type: "auth", v: PROTOCOL_VERSION }],
      ["a malformed token", { type: "auth", v: PROTOCOL_VERSION, token: "not-a-jwt" }],
      ["a wrong-secret token", { type: "auth", v: PROTOCOL_VERSION, token: wrongSecretToken(gm) }],
      ["an expired token", { type: "auth", v: PROTOCOL_VERSION,
        token: signJwt({ id: gm.id, email: gm.email, exp: Math.floor(Date.now() / 1000) - 60 }) }],
      ["a first frame that isn't JSON", "hello"],
      ["a token for no account", { type: "auth", v: PROTOCOL_VERSION,
        token: signJwt({ id: crypto.randomUUID(), email: "nobody@example.test" }) }],
    ];
    for (const [label, first] of refused) {
      const c = open(wsUrl, { first });
      const code = await Promise.race([c.closed, sleep(3_000).then(() => null)]);
      check(`${label} is refused with the auth close code (${CLOSE_UNAUTHORIZED})`,
        code === CLOSE_UNAUTHORIZED && !c.frames.some((f) => f.type === "ready"), `close ${code}`);
    }
    const badQuery = open(`${wsUrl}?token=${encodeURIComponent(wrongSecretToken(gm))}`);
    check("a bad query-parameter token is refused with the auth close code",
      (await Promise.race([badQuery.closed, sleep(3_000).then(() => null)])) === CLOSE_UNAUTHORIZED,
      `close ${badQuery.closeCode}`);
    const silent = open(wsUrl);
    check("a connection that never authenticates is closed with the auth close code",
      (await Promise.race([silent.closed, sleep(3_000).then(() => null)])) === CLOSE_UNAUTHORIZED,
      `close ${silent.closeCode}`);
    const future = open(wsUrl, { first: { type: "auth", v: 99, token: tokenFor(gm) } });
    check(`an unknown protocol version is refused with its own close code (${CLOSE_UNSUPPORTED_VERSION})`,
      (await Promise.race([future.closed, sleep(3_000).then(() => null)])) === CLOSE_UNSUPPORTED_VERSION,
      `close ${future.closeCode}`);

    console.log("\nDelivery\n");

    const p = open(wsUrl, { first: auth(player) });
    const o = open(wsUrl, { first: auth(outsider) });
    const a = open(wsUrl, { first: auth(admin) });
    await Promise.all([p.ready(), o.ready(), a.ready()]);

    const sent = await post(`/api/messages/campaign/${table}`, player, { body: `hail the party ${RUN}` });
    const saved = await sent.json() as any;
    check("the player's message is saved", sent.status === 201, `status ${sent.status}`);
    const bothGot = await until(() =>
      [g, p].every((c) => c.of("message.created").some((f) => f.message?.body === `hail the party ${RUN}`)));
    check("both members receive it as message.created", bothGot,
      `gm ${JSON.stringify(g.of("message.created"))} player ${JSON.stringify(p.of("message.created"))}`);
    const frame = g.of("message.created")[0];
    check("the frame names the campaign thread and carries the message",
      frame?.thread === thread && frame?.message?.id === String(saved._id)
        && frame?.message?.sender?.id === player.id && typeof frame?.message?.createdAt === "string",
      JSON.stringify(frame));
    check("the frame doesn't carry the sender's email address",
      !JSON.stringify(frame ?? {}).includes(player.email), JSON.stringify(frame));
    await sleep(400);
    check("the outsider never receives it", o.of("message.created").length === 0, JSON.stringify(o.frames));
    check("an admin who isn't a member never receives it", a.of("message.created").length === 0,
      JSON.stringify(a.frames));
    check("each member receives it exactly once",
      g.of("message.created").length === 1 && p.of("message.created").length === 1);

    console.log("\nAutomated posts\n");

    const { rows: [session] } = await pool.query(
      `INSERT INTO game_sessions (title, campaign_id, date) VALUES ($1, $2, now() + interval '10 minutes') RETURNING id`,
      [`t98 session ${RUN}`, table]);
    await runReadyCheckSweep();
    const readyCheckLive = await until(() => [g, p].every((c) =>
      c.of("message.created").some((f) => f.thread === thread && f.message?.sender?.id === "system"
        && String(f.message?.body).includes("READY CHECK"))));
    check("the ready check arrives live for both members", readyCheckLive,
      JSON.stringify(g.of("message.created").map((f) => f.message?.body)));
    check("the ready check never reaches the outsider", o.of("message.created").length === 0);
    void session;

    console.log("\nHeartbeat\n");

    const answers = open(fastUrl, { first: auth(gm) });
    const deaf = open(fastUrl, { first: auth(player), answerPings: false });
    await Promise.all([answers.ready(), deaf.ready()]);
    await sleep(1_200);
    check("the server sends ping frames", answers.of("ping").length >= 3, `pings ${answers.of("ping").length}`);
    check("a socket that stops answering pings is dropped", deaf.closeCode !== null, `close ${deaf.closeCode}`);
    check("a socket that answers stays open", answers.closeCode === null && answers.ws.readyState === WebSocket.OPEN,
      `close ${answers.closeCode}`);

    console.log("\nRealtime client\n");

    const { LiveClient } = await import(LIVE_CLIENT) as { LiveClient: LiveClientCtor };
    const network = await flakyNetwork(port);
    const reconnects: number[] = [];
    const seen: string[] = [];
    const statuses: string[] = [];
    const lc = new LiveClient({
      url: `ws://127.0.0.1:${network.port}${LIVE_PATH}`,
      getToken: () => tokenFor(gm),
      WebSocket,
      backoff: { baseMs: 100, maxMs: 400 },
    });
    lc.onStatus((s) => statuses.push(s));
    const unsubscribe = lc.subscribe(thread, {
      onMessage: (m) => seen.push(m.body),
      onReconnect: () => reconnects.push(Date.now()),
    });
    check("the client connects and authenticates", await until(() => lc.status === "open"),
      `statuses ${statuses.join(",")}`);
    check("the first connect isn't reported as a reconnect", reconnects.length === 0);

    await post(`/api/messages/campaign/${table}`, player, { body: `live ${RUN}` });
    check("the client delivers a message to its thread subscriber", await until(() => seen.includes(`live ${RUN}`)),
      JSON.stringify(seen));

    await network.drop();
    check("the client notices the network drop", await until(() => lc.status !== "open"),
      `statuses ${statuses.join(",")}`);
    const missed = await post(`/api/messages/campaign/${table}`, player, { body: `while you were out ${RUN}` });
    check("a message is sent while the client is offline", missed.status === 201);
    await sleep(600); // a few failed reconnect attempts
    await network.restore();
    check("the client reconnects on its own", await until(() => lc.status === "open" && reconnects.length === 1),
      `statuses ${statuses.join(",")} reconnects ${reconnects.length}`);
    const history = await fetch(`${base}/api/messages/campaign/${table}?limit=50`,
      { headers: { authorization: `Bearer ${tokenFor(gm)}` } }).then((r) => r.json()) as any[];
    check("the thread's refetch after the reconnect shows the message sent in the meantime",
      history.some((m) => m.body === `while you were out ${RUN}`));

    await post(`/api/messages/campaign/${table}`, player, { body: `back again ${RUN}` });
    check("live delivery resumes after the reconnect", await until(() => seen.includes(`back again ${RUN}`)),
      JSON.stringify(seen));

    unsubscribe();
    await post(`/api/messages/campaign/${table}`, player, { body: `after unsubscribe ${RUN}` });
    await sleep(300);
    check("an unsubscribed thread handler gets nothing more", !seen.includes(`after unsubscribe ${RUN}`));
    lc.close();
    await network.close();

    console.log("\nDefault heartbeat (waiting for the 25-second ping)\n");

    await until(() => heartbeatWatcher.pingTimes.length > 0, 30_000);
    const first = heartbeatWatcher.pingTimes[0];
    check("with the default settings the first ping comes 25 seconds after connecting",
      first !== undefined && first >= 24_500 && first <= 26_500, `first ping at ${first} ms`);
  } finally {
    for (const c of opened) c.ws.terminate();
    await live.close();
    await fastLive.close();
    server.closeAllConnections?.();
    server.close();
    fastServer.closeAllConnections?.();
    fastServer.close();
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
