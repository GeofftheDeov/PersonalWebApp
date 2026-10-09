/**
 * Letters across tickets (spec #58, final integration). Behaviour that only
 * exists once several tickets are combined, and that no single ticket's suite
 * covers:
 *   - #105 Ã— #100/#102 Ã— #103: someone who joins a campaign while connected
 *     finds it in their thread list (GET /api/threads) with the right unread
 *     count, and gets its `thread.updated` and `typing` frames; someone who
 *     leaves drops it from the list and gets neither; a read on one of the new
 *     member's sockets reaches their other one as `thread.read`;
 *   - #101 Ã— #102: a resend with the same clientId (200) adds nothing to
 *     anyone's unread count and sends no second `thread.updated`; a send whose
 *     publish failed (500) and was resent counts once;
 *   - #96 Ã— #118: two live channels on buses in different namespaces of one
 *     Redis never see each other's message, thread list or typing frames,
 *     while a third channel in the same namespace does (Redis only);
 *   - #98 Ã— #102 dedupe: a campaign message and a DM whose broadcast events
 *     carry the same id (Redis stream ids are per stream) both reach the
 *     socket, with their `thread.updated` frames.
 *
 * Real WebSocket clients against the real routes, on the process's own event
 * bus (in memory when REDIS_URL is unset, Redis Streams + Pub/Sub when set).
 * Run against a throwaway database loaded from db/schema.sql (it refuses
 * anything but localhost). It deletes every row it creates.
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-live-combined.ts
 *   (add REDIS_URL=redis://127.0.0.1:6379 EVENT_BUS_NAMESPACE=<ns> for the Redis bus)
 */
import "./use-test-jwt-secret.js";
import express from "express";
import http from "http";
import type { AddressInfo } from "net";
import WebSocket from "ws";
import pool from "../db/index.js";
import { signJwt } from "../utils/jwt.js";
import { attachLiveChannel, LIVE_PATH, PROTOCOL_VERSION, type LiveChannel } from "../live/liveChannel.js";
import { startLiveChannel } from "../live/startLiveChannel.js";
import { InMemoryEventBus } from "../events/InMemoryEventBus.js";
import { createEventBus, type EventBus } from "../events/index.js";
import { campaignThreadKey, dmThreadKey } from "../services/threads.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
  process.exit(2);
}
const REDIS_URL = process.env.REDIS_URL ?? "";

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

async function account(handle: string): Promise<Person> {
  const h = `t58-${handle}-${RUN}`;
  const { rows } = await pool.query(
    `INSERT INTO accounts (id, handle, name, email) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id, email`,
    [h, `${handle} name`, `t58.${handle}.${RUN}@example.test`]);
  created.accounts.push(rows[0].id);
  return { id: rows[0].id, email: rows[0].email, handle: h };
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
  // Accounts cascade to memberships, invites, friend requests and read state.
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
  const readies = () => frames.filter((f) => f.type === "ready");
  return {
    ws, frames,
    ready: () => until(() => readies().length > 0),
    threads: (): string[] => readies().at(-1)?.threads ?? [],
    of: (type: string, thread?: string) => frames.filter((f) => f.type === type && (!thread || f.thread === thread)),
    typing: (thread: string) => ws.send(JSON.stringify({ type: "typing", thread })),
  };
}
type Client = ReturnType<typeof client>;

/** A bus that hands every broadcast handler the same event id, as two Redis streams can. */
function sameIdBus(inner: EventBus, id: string): EventBus {
  return {
    publish: (event, payload) => inner.publish(event, payload),
    publishEphemeral: (event, payload) => inner.publishEphemeral(event, payload),
    subscribe: (event, handler) => inner.subscribe(event, handler),
    subscribeBroadcast: (event, handler) => inner.subscribeBroadcast(event, (payload, meta) =>
      handler(payload, { ...meta, id: event === "letters.typing" || event === "thread.read" ? meta.id : id })),
    start: () => inner.start(),
    stop: () => inner.stop(),
  };
}

async function main() {
  const { default: campaignRoutes } = await import("../routes/campaignRoutes.js");
  const { default: campaignMemberRoutes } = await import("../routes/campaignMemberRoutes.js");
  const { default: threadRoutes } = await import("../routes/threadRoutes.js");
  const { bus, startEventBus, stopEventBus } = await import("../events/index.js");
  const app = express();
  app.use(express.json());
  app.use("/api/campaigns", campaignRoutes);
  app.use("/api/campaign-members", campaignMemberRoutes);
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
  // The main server boots its channel the way server.ts does.
  const primary = await listen();
  const handle = startLiveChannel(primary.server);
  await handle.ready;
  const channels: LiveChannel[] = [];
  const busesToStop: EventBus[] = [];
  console.log(`\n  bus: ${REDIS_URL ? `redis (namespace ${process.env.EVENT_BUS_NAMESPACE || "none"})` : "in memory"}`);

  const call = async (method: string, path: string, who: Person, body?: unknown) => {
    const res = await fetch(`${primary.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${tokenFor(who)}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, ok: res.ok, json, text };
  };
  const sendTo = (thread: string, who: Person, body: string, clientId?: string) =>
    call("POST", `/api/threads/${encodeURIComponent(thread)}/messages`, who, { body, ...(clientId ? { clientId } : {}) });
  const listed = async (who: Person, thread: string) =>
    ((await call("GET", "/api/threads?filter=all", who)).json?.threads ?? []).find((t: any) => t.threadKey === thread);
  const opened: Client[] = [];
  const open = (url: string, who: Person) => { const c = client(url, who); opened.push(c); return c; };
  const got = (c: Client, messageId: string) => c.of("message.created").filter((f) => f.message?.id === messageId).length;
  const updatesFor = (c: Client, thread: string, createdAt: string) =>
    c.of("thread.updated", thread).filter((f) => f.lastActivityAt === createdAt);

  try {
    const gm = await account("gm");
    const pat = await account("pat");        // in from the start, then leaves
    const newbie = await account("newbie");  // added while connected
    const outsider = await account("outsider");

    const createRes = await call("POST", "/api/campaigns", gm,
      { title: `t58 table ${RUN}`, description: "test", status: "In Progress", startDate: new Date().toISOString() });
    const campaignId = String(createRes.json?.campaign?.id);
    if (createRes.ok) created.campaigns.push(campaignId);
    const table = campaignThreadKey(campaignId);
    check("the GM creates a campaign", createRes.status === 201, `status ${createRes.status} ${createRes.text}`);
    const addPat = await call("POST", "/api/campaign-members", gm, { campaign: campaignId, person: pat.id, status: "Player" });
    check("...and adds pat", addPat.status === 201, `status ${addPat.status}`);

    const s = {
      gm: open(primary.wsUrl, gm), pat: open(primary.wsUrl, pat),
      newbie: open(primary.wsUrl, newbie), newbiePhone: open(primary.wsUrl, newbie), outsider: open(primary.wsUrl, outsider),
    };
    await Promise.all(Object.values(s).map((c) => c.ready()));
    check("pat's socket lists the campaign", await until(() => s.pat.threads().includes(table)));

    /* -------------------------------------------------------------- */
    console.log("\nJoining and leaving, as the thread list and typing see it (#105 Ã— #102 Ã— #103)\n");

    const m1 = (await sendTo(table, gm, `t58 before the newbie ${RUN}`)).json?.message;
    check("before joining, the newbie gets nothing from the campaign",
      await until(() => got(s.pat, m1?.id) === 1) && (await sleep(200), got(s.newbie, m1?.id) === 0
        && s.newbie.of("thread.updated", table).length === 0));
    check("...and their thread list doesn't have it", !(await listed(newbie, table)));

    const addNewbie = await call("POST", "/api/campaign-members", gm, { campaign: campaignId, person: newbie.id, status: "Player" });
    check("the GM adds the newbie while they're connected", addNewbie.status === 201, `status ${addNewbie.status}`);
    check("...both of the newbie's sockets now list the campaign",
      await until(() => s.newbie.threads().includes(table) && s.newbiePhone.threads().includes(table)));
    const newbieRow = await listed(newbie, table);
    check("...and their thread list picks it up, with the message from before they joined unread",
      newbieRow?.kind === "campaign" && newbieRow?.unreadCount === 1, JSON.stringify(newbieRow));

    const { rows: [patMembership] } = await pool.query(
      `SELECT id FROM campaign_members WHERE campaign_id = $1 AND person_id = $2`, [campaignId, pat.id]);
    const patUpdates = s.pat.of("thread.updated", table).length;
    const patTyping = s.pat.of("typing", table).length;
    const leave = await call("DELETE", `/api/campaign-members/${patMembership?.id}`, pat);
    check("pat leaves the campaign", leave.ok, `status ${leave.status}`);
    check("...and drops it from his socket", await until(() => !s.pat.threads().includes(table)));
    check("...and from his thread list", !(await listed(pat, table)));

    const m2 = (await sendTo(table, gm, `t58 after pat left ${RUN}`)).json?.message;
    check("a new message reaches the newbie on both sockets",
      await until(() => got(s.newbie, m2?.id) === 1 && got(s.newbiePhone, m2?.id) === 1));
    check("...with thread.updated counting both messages as unread",
      await until(() => updatesFor(s.newbie, table, m2?.createdAt).some((f) => f.unreadCount === 2)),
      JSON.stringify(s.newbie.of("thread.updated")));
    s.gm.typing(table);
    check("the GM's typing reaches the newbie", await until(() => s.newbie.of("typing", table).length === 1));
    s.newbie.typing(table);
    check("the newbie's typing reaches the GM", await until(() => s.gm.of("typing", table).some((f) => f.personId === newbie.id)));
    await sleep(300);
    check("pat, who left, gets none of it: no message, thread.updated or typing",
      got(s.pat, m2?.id) === 0 && s.pat.of("thread.updated", table).length === patUpdates
        && s.pat.of("typing", table).length === patTyping,
      JSON.stringify(s.pat.frames.slice(-4)));
    check("nor does the outsider", s.outsider.of("message.created").length === 0 && s.outsider.of("typing").length === 0
      && s.outsider.of("thread.updated").length === 0);

    const read = await call("POST", `/api/threads/${encodeURIComponent(table)}/read`, newbie, { messageId: m2?.id });
    check("the newbie reads up to the latest message", read.ok, `status ${read.status} ${read.text}`);
    check("...their other socket gets thread.read with nothing left unread",
      await until(() => s.newbiePhone.of("thread.read", table).some((f) => f.lastReadMessageId === m2?.id && f.unreadCount === 0)),
      JSON.stringify(s.newbiePhone.of("thread.read")));
    await sleep(200);
    check("...and nobody else does", [s.gm, s.pat, s.outsider].every((c) => c.of("thread.read").length === 0));
    check("...and their thread list shows it read", (await listed(newbie, table))?.unreadCount === 0);

    /* -------------------------------------------------------------- */
    console.log("\nResends and unread counts (#101 Ã— #102)\n");

    const gmUnread = async () => (await listed(gm, table))?.unreadCount as number;
    const before = await gmUnread();
    const clientId = `t58-${RUN}-resend`;
    const first = await sendTo(table, newbie, `t58 once ${RUN}`, clientId);
    const again = await sendTo(table, newbie, `t58 once ${RUN}`, clientId);
    check("a send with a clientId is stored (201) and its resend returns it (200)",
      first.status === 201 && again.status === 200 && again.json?.message?.id === first.json?.message?.id,
      `${first.status}/${again.status}`);
    const once = first.json?.message;
    check("the GM gets it once", await until(() => got(s.gm, once?.id) === 1) && (await sleep(300), got(s.gm, once?.id) === 1));
    check("...with one thread.updated for it, not two", updatesFor(s.gm, table, once?.createdAt).length === 1,
      JSON.stringify(updatesFor(s.gm, table, once?.createdAt)));
    check("...and their unread count went up by exactly one", (await gmUnread()) === before + 1,
      `${before} â†’ ${await gmUnread()}`);
    check("the sender's own thread.updated leaves their count at 0",
      await until(() => updatesFor(s.newbie, table, once?.createdAt).some((f) => f.unreadCount === 0)),
      JSON.stringify(updatesFor(s.newbie, table, once?.createdAt)));

    const realPublish = bus.publish.bind(bus);
    let failNext = true;
    (bus as any).publish = async (...args: Parameters<typeof bus.publish>) => {
      if (failNext) { failNext = false; throw new Error("t58 bus down"); }
      return realPublish(...args);
    };
    const quiet = console.error;
    console.error = () => {};
    const failed = await sendTo(table, newbie, `t58 hiccup ${RUN}`, `t58-${RUN}-hiccup`);
    console.error = quiet;
    const resent = await sendTo(table, newbie, `t58 hiccup ${RUN}`, `t58-${RUN}-hiccup`);
    (bus as any).publish = realPublish;
    check("a send whose publish fails is a 500, and its resend a fresh 201", failed.status === 500 && resent.status === 201,
      `${failed.status}/${resent.status}`);
    check("the GM gets the resent message once", await until(() => got(s.gm, resent.json?.message?.id) === 1));
    check("...and their unread count counts it once", (await gmUnread()) === before + 2, `${before} â†’ ${await gmUnread()}`);

    /* -------------------------------------------------------------- */
    console.log("\nSame event id on two streams (#98 Ã— #102)\n");

    {
      // A stream id is unique only within its stream: gamenight.message and
      // social.dm can carry the same one. Neither may hide the other.
      const fake = sameIdBus(new InMemoryEventBus("t58"), "1700000000000-0");
      const side = await listen();
      channels.push(await attachLiveChannel(side.server, { bus: fake }));
      await befriend(gm, newbie);
      const sock = open(side.wsUrl, newbie);
      const dm = dmThreadKey(gm.id, newbie.id);
      check("a socket on a channel whose events share ids lists the campaign and the DM",
        await sock.ready() && sock.threads().includes(table) && sock.threads().includes(dm), JSON.stringify(sock.threads()));
      const at = new Date().toISOString();
      const sender = { id: gm.id, name: gm.handle, email: gm.email };
      await fake.publish("gamenight.message", { messageId: `c-${RUN}`, campaignId, sender, body: "campaign", createdAt: at });
      await sleep(100);
      await fake.publish("social.dm", { messageId: `d-${RUN}`, dmKey: dm.slice(3), recipientId: newbie.id, sender, body: "dm", createdAt: at });
      check("the campaign message and the DM both arrive",
        await until(() => got(sock, `c-${RUN}`) === 1 && got(sock, `d-${RUN}`) === 1), JSON.stringify(sock.of("message.created")));
      check("...each with its thread.updated",
        await until(() => sock.of("thread.updated", table).length === 1 && sock.of("thread.updated", dm).length === 1),
        JSON.stringify(sock.of("thread.updated")));
      await fake.publish("gamenight.message", { messageId: `c2-${RUN}`, campaignId, sender, body: "again", createdAt: at });
      await sleep(300);
      check("...while a second sighting of the same id on the same stream is still dropped",
        got(sock, `c2-${RUN}`) === 0, JSON.stringify(sock.of("message.created")));
    }

    /* -------------------------------------------------------------- */
    console.log("\nNamespaces keep live frames apart (#96 Ã— #118)\n");

    if (!REDIS_URL) {
      console.log("  (skipped: needs REDIS_URL)");
    } else {
      const ns = process.env.EVENT_BUS_NAMESPACE || "t58";
      const busX = createEventBus({ ...process.env, EVENT_BUS_NAMESPACE: `${ns}-x${RUN}` });
      const busX2 = createEventBus({ ...process.env, EVENT_BUS_NAMESPACE: `${ns}-x${RUN}` });
      const busY = createEventBus({ ...process.env, EVENT_BUS_NAMESPACE: `${ns}-y${RUN}` });
      busesToStop.push(busX, busX2, busY);
      const [sx, sx2, sy] = [await listen(), await listen(), await listen()];
      channels.push(await attachLiveChannel(sx.server, { bus: busX }));
      channels.push(await attachLiveChannel(sx2.server, { bus: busX2 }));
      channels.push(await attachLiveChannel(sy.server, { bus: busY }));
      const onX = open(sx.wsUrl, gm);
      const onX2 = open(sx2.wsUrl, gm);
      const onY = open(sy.wsUrl, gm);
      check("the GM has a socket on each of three channels", (await Promise.all([onX.ready(), onX2.ready(), onY.ready()])).every(Boolean));

      const sender = { id: newbie.id, name: newbie.handle, email: newbie.email };
      const at = new Date().toISOString();
      await busX.publish("gamenight.message", { messageId: `x-${RUN}`, campaignId, sender, body: "in x", createdAt: at });
      check("a message published in namespace x reaches both channels in x, with thread.updated",
        await until(() => got(onX, `x-${RUN}`) === 1 && got(onX2, `x-${RUN}`) === 1
          && onX.of("thread.updated", table).length === 1 && onX2.of("thread.updated", table).length === 1));
      await busY.publishEphemeral("letters.typing", { threadKey: table, personId: newbie.id, name: "newbie", expiresInMs: 5000 });
      await busY.publishEphemeral("thread.read",
        { personId: gm.id, threadKey: table, lastReadAt: at, lastReadMessageId: null, unreadCount: 0 });
      check("typing and thread.read published in namespace y reach the channel in y",
        await until(() => onY.of("typing", table).length === 1 && onY.of("thread.read", table).length === 1));
      await sleep(400);
      check("...but nothing crosses: y never sees x's message or thread.updated, x never sees y's typing or read",
        got(onY, `x-${RUN}`) === 0 && onY.of("thread.updated").length === 0
          && [onX, onX2].every((c) => c.of("typing").length === 0 && c.of("thread.read").length === 0),
        JSON.stringify({ y: onY.frames.map((f) => f.type), x: onX.frames.map((f) => f.type) }));
    }
  } finally {
    for (const c of opened) c.ws.terminate();
    await handle.close();
    for (const ch of channels) await ch.close().catch(() => {});
    for (const b of busesToStop) await b.stop().catch(() => {});
    if (REDIS_URL && busesToStop.length) {
      // The throwaway namespaces' streams (XADDed by the publishes above).
      const { Redis } = await import("ioredis");
      const redis = new Redis(REDIS_URL);
      const ns = process.env.EVENT_BUS_NAMESPACE || "t58";
      for (const suffix of ["x", "y"]) {
        const keys = await redis.keys(`${ns}-${suffix}${RUN}:*`).catch(() => [] as string[]);
        if (keys.length) await redis.del(...keys).catch(() => {});
      }
      await redis.quit().catch(() => {});
    }
    for (const server of servers) { server.closeAllConnections?.(); server.close(); }
    await cleanup().catch((e) => console.error("cleanup failed:", e));
    await stopEventBus();
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
