/**
 * Live access follows membership and friendship (#105, spec #58 seam 2):
 * "leaving a campaign stops delivery without reconnecting", and the rest of
 * the ways access changes while a socket is open.
 *
 * Real WebSocket clients against the real server wiring: the routes that
 * change membership and friendship mounted as server.ts mounts them, the live
 * channel attached to the same HTTP server, and the process's own event bus
 * (in memory when REDIS_URL is unset, Redis Streams + Pub/Sub when it is set).
 * Covers:
 *   - every path that changes membership or friendship publishes its event:
 *     create campaign, add member, join by link, accept invite, remove member
 *     (yourself or by the GM), delete campaign (the admin table browser, the
 *     only place a campaign is deleted), accept friend request, remove friend,
 *     and deleting an account there (its memberships go with it);
 *   - each one changes the open sockets' threads in place: a fresh `ready`
 *     with the new list, on the same connection, no reconnect;
 *   - a member who leaves stops getting the campaign's `message.created` and
 *     `typing` at once, while the others keep getting them; one who joins
 *     (invite, link or added by the GM) starts getting them;
 *   - after unfriending neither socket gets the other's DMs and a DM send is
 *     403; becoming friends makes the DM live for both;
 *   - an admin's socket never picks up a campaign it isn't a member of;
 *   - a socket closes with 4001 when its token expires, or its account is
 *     deleted;
 *   - the frontend's LiveClient follows a re-sent `ready` without
 *     reconnecting, and catches up the thread that became available.
 *
 * Run against a throwaway database loaded from db/schema.sql (it refuses to run
 * against anything but localhost). It deletes every row it creates.
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-live-access.ts
 *   (add REDIS_URL=redis://127.0.0.1:6379 EVENT_BUS_NAMESPACE=<ns> for the Redis bus)
 */
import "./use-test-jwt-secret.js";
import express from "express";
import http from "http";
import type { AddressInfo } from "net";
import WebSocket from "ws";
import pool from "../db/index.js";
import { signJwt } from "../utils/jwt.js";
import { attachLiveChannel, LIVE_PATH, PROTOCOL_VERSION, TYPING_MIN_INTERVAL_MS } from "../live/liveChannel.js";
import { campaignThreadKey, dmThreadKey } from "../services/threads.js";

type LiveClientLike = {
  status: string;
  threadStatus(thread: string): string;
  subscribe(thread: string, handlers: {
    onMessage?: (m: { body: string }, thread: string) => void; onReconnect?: () => void;
  }): () => void;
  onThreads(listener: (threads: string[]) => void): () => void;
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

async function account(handle: string, appRole = "user"): Promise<Person> {
  const { rows } = await pool.query(
    `INSERT INTO accounts (id, handle, name, email, app_role) VALUES (gen_random_uuid(), $1, $2, $3, $4)
     RETURNING id, email`,
    [`t105-${handle}-${RUN}`, `${handle} name`, `t105.${handle}.${RUN}@example.test`, appRole]);
  created.accounts.push(rows[0].id);
  return { id: rows[0].id, email: rows[0].email };
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
  await pool.query(`DELETE FROM campaigns WHERE id = ANY($1::uuid[])`, [campaigns]);
  // Accounts cascade to memberships, invites, friend requests, notifications and read state.
  await pool.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [accounts]);
}

const tokenFor = (p: Person, expiresIn?: number) =>
  signJwt({ id: p.id, email: p.email }, expiresIn ? { expiresIn } : undefined);

type Frame = { type: string; [k: string]: any };

/** A raw protocol client that authenticates with the first frame and records every frame. */
function client(url: string, who: Person, token = tokenFor(who)) {
  const ws = new WebSocket(url);
  const frames: Frame[] = [];
  let closeCode: number | null = null;
  ws.on("error", () => { /* surfaces as close */ });
  ws.on("open", () => ws.send(JSON.stringify({ type: "auth", v: PROTOCOL_VERSION, token })));
  ws.on("close", (code) => { closeCode = code; });
  ws.on("message", (data) => {
    let frame: Frame;
    try { frame = JSON.parse(String(data)); } catch { return; }
    frames.push(frame);
    if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
  });
  const readies = () => frames.filter((f) => f.type === "ready");
  return {
    ws, frames,
    get closeCode() { return closeCode; },
    ready: () => until(() => readies().length > 0),
    /** The threads the server's latest `ready` subscribed this socket to. */
    threads: (): string[] => readies().at(-1)?.threads ?? [],
    readyCount: () => readies().length,
    of: (type: string) => frames.filter((f) => f.type === type),
    typing: (thread: string) => ws.send(JSON.stringify({ type: "typing", thread })),
  };
}
type Client = ReturnType<typeof client>;

async function main() {
  const { default: campaignRoutes } = await import("../routes/campaignRoutes.js");
  const { default: campaignMemberRoutes } = await import("../routes/campaignMemberRoutes.js");
  const { default: inviteRoutes } = await import("../routes/inviteRoutes.js");
  const { default: friendRoutes } = await import("../routes/friendRoutes.js");
  const { default: threadRoutes } = await import("../routes/threadRoutes.js");
  const { default: dbRoutes } = await import("../routes/dbRoutes.js");
  const { bus, startEventBus } = await import("../events/index.js");
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use("/db", dbRoutes);
  app.use("/api/campaigns", campaignRoutes);
  app.use("/api/campaign-members", campaignMemberRoutes);
  app.use("/api/campaign-invites", inviteRoutes);
  app.use("/api/friends", friendRoutes);
  app.use("/api/threads", threadRoutes);
  const server = http.createServer(app);
  let upgrades = 0;
  server.on("upgrade", () => { upgrades++; });
  const live = await attachLiveChannel(server);
  await startEventBus();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}${LIVE_PATH}`;
  console.log(`\n  bus: ${process.env.REDIS_URL ? `redis (namespace ${process.env.EVENT_BUS_NAMESPACE || "none"})` : "in memory"}`);

  // What the paths publish, seen the way the live channel sees it.
  const events: { name: string; payload: any }[] = [];
  const offEvents = [
    await bus.subscribeBroadcast("campaign.changed", (payload) => { events.push({ name: "campaign.changed", payload }); }),
    await bus.subscribeBroadcast("friendship.changed", (payload) => { events.push({ name: "friendship.changed", payload }); }),
    await bus.subscribeBroadcast("account.deleted", (payload) => { events.push({ name: "account.deleted", payload }); }),
  ];
  const published = (name: string, match: (p: any) => boolean) =>
    until(() => events.some((e) => e.name === name && match(e.payload)));

  const call = (method: string, path: string, who: Person, body?: unknown) => fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${tokenFor(who)}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sendTo = (thread: string, who: Person, body: string) =>
    call("POST", `/api/threads/${encodeURIComponent(thread)}/messages`, who, { body });
  const opened: Client[] = [];
  const open = (who: Person, token?: string) => { const c = client(wsUrl, who, token); opened.push(c); return c; };
  const got = (c: Client, thread: string, body: string) =>
    c.of("message.created").some((f) => f.thread === thread && f.message?.body === body);
  const typed = (c: Client, thread: string) => c.of("typing").some((f) => f.thread === thread);

  try {
    const gm = await account("gm");
    const pat = await account("pat");      // joins by link, then leaves
    const ivy = await account("ivy");      // accepts an invite
    const ned = await account("ned");      // added, then removed, by the GM
    const outsider = await account("outsider");
    const admin = await account("admin", "admin");
    await befriend(gm, ivy); // invites go friend to friend

    const sockets = { gm: open(gm), pat: open(pat), ivy: open(ivy), ned: open(ned), outsider: open(outsider), admin: open(admin) };
    await Promise.all(Object.values(sockets).map((c) => c.ready()));
    const upgradesAtStart = upgrades;

    console.log("\nCreating a campaign\n");

    const createRes = await call("POST", "/api/campaigns", gm,
      { title: `t105 table ${RUN}`, description: "test", status: "In Progress", startDate: new Date().toISOString() });
    const campaignId = String((await createRes.json() as any)?.campaign?.id);
    if (createRes.ok) created.campaigns.push(campaignId);
    const table = campaignThreadKey(campaignId);
    check("the GM creates a campaign", createRes.status === 201, `status ${createRes.status}`);
    check("creating it publishes campaign.changed (created)",
      await published("campaign.changed", (p) => p.campaignId === campaignId && p.action === "created" && p.personId === gm.id),
      JSON.stringify(events));
    check("the GM's open socket gets a fresh `ready` that lists the campaign",
      await until(() => sockets.gm.threads().includes(table)), JSON.stringify(sockets.gm.of("ready")));

    console.log("\nJoining while connected\n");

    // Invite → accept.
    const inviteRes = await call("POST", "/api/campaign-invites", gm, { campaignId, toUserId: ivy.id });
    const inviteId = String((await inviteRes.json() as any)?.invite?._id);
    check("the GM invites ivy", inviteRes.status === 201, `status ${inviteRes.status}`);
    const acceptRes = await call("PUT", `/api/campaign-invites/${inviteId}/respond`, ivy, { action: "accept" });
    check("ivy accepts the invite", acceptRes.ok, `status ${acceptRes.status}`);
    check("accepting the invite publishes campaign.changed (member-added)",
      await published("campaign.changed", (p) => p.campaignId === campaignId && p.action === "member-added" && p.personId === ivy.id),
      JSON.stringify(events));
    check("ivy's open socket now lists the campaign", await until(() => sockets.ivy.threads().includes(table)),
      JSON.stringify(sockets.ivy.of("ready")));

    // Join by link.
    const joinRes = await call("POST", `/api/campaigns/${campaignId}/join`, pat);
    const patMemberId = String((await joinRes.json() as any)?.member?._id);
    check("pat joins by the invite link", joinRes.status === 201, `status ${joinRes.status}`);
    check("joining publishes campaign.changed (member-added)",
      await published("campaign.changed", (p) => p.campaignId === campaignId && p.action === "member-added" && p.personId === pat.id));
    check("pat's open socket now lists the campaign", await until(() => sockets.pat.threads().includes(table)));

    // Added by the GM.
    const addRes = await call("POST", "/api/campaign-members", gm, { campaign: campaignId, person: ned.id, status: "Player" });
    const nedMemberId = String((await addRes.json() as any)?.member?._id);
    check("the GM adds ned", addRes.status === 201, `status ${addRes.status}`);
    check("adding a member publishes campaign.changed (member-added)",
      await published("campaign.changed", (p) => p.campaignId === campaignId && p.action === "member-added" && p.personId === ned.id));
    check("ned's open socket now lists the campaign", await until(() => sockets.ned.threads().includes(table)));

    const hello = `hello table ${RUN}`;
    check("a message reaches everyone who joined while connected",
      (await sendTo(table, gm, hello)).status === 201
        && await until(() => [sockets.ivy, sockets.pat, sockets.ned, sockets.gm].every((c) => got(c, table, hello))),
      JSON.stringify([sockets.ivy, sockets.pat, sockets.ned].map((c) => c.of("message.created"))));
    sockets.gm.typing(table);
    check("so does the GM's typing", await until(() => [sockets.ivy, sockets.pat, sockets.ned].every((c) => typed(c, table))));
    check("...without any of them reconnecting", upgrades === upgradesAtStart
      && [sockets.ivy, sockets.pat, sockets.ned].every((c) => c.ws.readyState === WebSocket.OPEN),
      `${upgrades - upgradesAtStart} upgrades`);
    await sleep(300);
    check("an outsider gets none of it", !got(sockets.outsider, table, hello) && !typed(sockets.outsider, table)
      && !sockets.outsider.threads().includes(table));
    check("nor does an admin who isn't a member", !got(sockets.admin, table, hello) && !sockets.admin.threads().includes(table),
      JSON.stringify(sockets.admin.of("ready")));

    console.log("\nLeaving while connected\n");

    const patTyping = sockets.pat.of("typing").length;
    await until(() => sockets.pat.of("thread.updated").some((f) => f.thread === table));
    const patUpdates = sockets.pat.of("thread.updated").length;
    const leaveRes = await call("DELETE", `/api/campaign-members/${patMemberId}`, pat);
    check("pat leaves the campaign", leaveRes.ok, `status ${leaveRes.status}`);
    // Straight after the response, before pat's socket has even been told:
    // the removal reached the bus first, so it is applied first.
    const afterLeave = `after pat left ${RUN}`;
    check("a message right after it is sent", (await sendTo(table, gm, afterLeave)).status === 201);
    await sleep(TYPING_MIN_INTERVAL_MS + 100);
    sockets.gm.typing(table);
    check("leaving publishes campaign.changed (member-removed)",
      await published("campaign.changed", (p) => p.campaignId === campaignId && p.action === "member-removed" && p.personId === pat.id));
    check("pat's open socket gets a `ready` without the campaign",
      await until(() => !sockets.pat.threads().includes(table) && sockets.pat.readyCount() > 2),
      JSON.stringify(sockets.pat.of("ready")));
    check("the others still get the message and the typing",
      await until(() => [sockets.ivy, sockets.ned].every((c) => got(c, table, afterLeave)
        && c.of("typing").filter((f) => f.thread === table).length >= 2)));
    await sleep(300);
    check("pat doesn't get the message sent right after leaving", !got(sockets.pat, table, afterLeave),
      JSON.stringify(sockets.pat.of("message.created")));
    check("nor the typing", sockets.pat.of("typing").length === patTyping, JSON.stringify(sockets.pat.of("typing")));
    check("nor its thread.updated", sockets.pat.of("thread.updated").length === patUpdates,
      JSON.stringify(sockets.pat.of("thread.updated")));
    check("pat's socket stayed open throughout", sockets.pat.ws.readyState === WebSocket.OPEN && upgrades === upgradesAtStart);

    const kickRes = await call("DELETE", `/api/campaign-members/${nedMemberId}`, gm);
    check("the GM removes ned", kickRes.ok, `status ${kickRes.status}`);
    check("removing a member publishes campaign.changed (member-removed)",
      await published("campaign.changed", (p) => p.campaignId === campaignId && p.action === "member-removed" && p.personId === ned.id));
    check("ned's open socket drops the campaign", await until(() => !sockets.ned.threads().includes(table)));
    const afterKick = `after ned left ${RUN}`;
    await sendTo(table, gm, afterKick);
    await until(() => got(sockets.ivy, table, afterKick));
    await sleep(200);
    check("ned no longer gets its messages", !got(sockets.ned, table, afterKick));

    console.log("\nDeleting the campaign\n");

    const delRes = await fetch(`${base}/db/campaigns/delete/${campaignId}?token=${encodeURIComponent(tokenFor(admin))}`,
      { method: "POST" });
    check("an admin deletes the campaign in the table browser", delRes.ok, `status ${delRes.status}`);
    check("deleting it publishes campaign.changed (deleted)",
      await published("campaign.changed", (p) => p.campaignId === campaignId && p.action === "deleted"));
    check("every member's open socket drops the campaign",
      await until(() => [sockets.gm, sockets.ivy].every((c) => !c.threads().includes(table))),
      JSON.stringify([sockets.gm.of("ready").at(-1), sockets.ivy.of("ready").at(-1)]));

    console.log("\nBecoming friends while connected\n");

    const dm = dmThreadKey(pat.id, outsider.id);
    const reqRes = await call("POST", "/api/friends/request", pat, { toUserId: outsider.id });
    check("pat sends the outsider a friend request", reqRes.status === 201, `status ${reqRes.status}`);
    check("a DM between them is refused before they're friends (403)", (await sendTo(dm, pat, "too soon")).status === 403);
    const { rows: [fr] } = await pool.query(`SELECT id FROM friend_requests WHERE from_user = $1 AND to_user = $2`,
      [pat.id, outsider.id]);
    const frRes = await call("PUT", `/api/friends/request/${fr?.id}`, outsider, { action: "accept" });
    check("the outsider accepts", frRes.ok, `status ${frRes.status}`);
    check("accepting publishes friendship.changed (added)",
      await published("friendship.changed", (p) => p.action === "added"
        && [...p.personIds].sort().join() === [pat.id, outsider.id].sort().join()), JSON.stringify(events));
    check("both open sockets now list the DM",
      await until(() => sockets.pat.threads().includes(dm) && sockets.outsider.threads().includes(dm)));
    const hi = `hi friend ${RUN}`;
    check("a DM between them is sent", (await sendTo(dm, pat, hi)).status === 201);
    check("...and reaches both, live", await until(() => got(sockets.pat, dm, hi) && got(sockets.outsider, dm, hi)));

    console.log("\nUnfriending while connected\n");

    const unfriendRes = await call("DELETE", `/api/friends/${pat.id}`, outsider);
    check("the outsider removes pat as a friend", unfriendRes.ok, `status ${unfriendRes.status}`);
    const lateTyping = sockets.pat.of("typing").length;
    sockets.outsider.typing(dm);
    check("removing a friend publishes friendship.changed (removed)",
      await published("friendship.changed", (p) => p.action === "removed"
        && [...p.personIds].sort().join() === [pat.id, outsider.id].sort().join()));
    check("both open sockets drop the DM",
      await until(() => !sockets.pat.threads().includes(dm) && !sockets.outsider.threads().includes(dm)));
    check("sending a DM now gets a 403, either way round",
      (await sendTo(dm, pat, "still there?")).status === 403 && (await sendTo(dm, outsider, "go away")).status === 403);
    await sleep(300);
    check("no DM or typing crossed after unfriending", !got(sockets.outsider, dm, "still there?")
      && !got(sockets.pat, dm, "go away") && sockets.pat.of("typing").length === lateTyping);
    check("no socket reconnected for any of it", upgrades === upgradesAtStart
      && Object.values(sockets).every((c) => c.ws.readyState === WebSocket.OPEN), `${upgrades - upgradesAtStart} upgrades`);

    console.log("\nDeleting an account\n");

    const second = await call("POST", "/api/campaigns", gm,
      { title: `t105 second ${RUN}`, description: "test", status: "In Progress", startDate: new Date().toISOString() });
    const secondId = String((await second.json() as any)?.campaign?.id);
    if (second.ok) created.campaigns.push(secondId);
    const secondTable = campaignThreadKey(secondId);
    await call("POST", "/api/campaign-members", gm, { campaign: secondId, person: outsider.id, status: "Player" });
    check("the outsider joins a second campaign", await until(() => sockets.outsider.threads().includes(secondTable)));
    const delAccount = await fetch(`${base}/db/accounts/delete/${outsider.id}?token=${encodeURIComponent(tokenFor(admin))}`,
      { method: "POST" });
    check("an admin deletes the outsider's account in the table browser", delAccount.ok, `status ${delAccount.status}`);
    check("deleting it publishes campaign.changed (member-removed) for each of its memberships",
      await published("campaign.changed", (p) => p.campaignId === secondId && p.action === "member-removed" && p.personId === outsider.id));
    check("the deleted account's open socket drops the campaign", await until(() => !sockets.outsider.threads().includes(secondTable)));
    const afterDelete = `after the outsider went ${RUN}`;
    await sendTo(secondTable, gm, afterDelete);
    await until(() => got(sockets.gm, secondTable, afterDelete));
    await sleep(200);
    check("...and gets none of its messages", !got(sockets.outsider, secondTable, afterDelete));
    check("deleting it publishes account.deleted",
      await published("account.deleted", (p) => p.personId === outsider.id));
    check("...and the deleted account's open socket is closed with 4001, as an expired token's is",
      await until(() => sockets.outsider.closeCode === 4001), `close code ${sockets.outsider.closeCode}`);
    check("...while everyone else's stay open",
      [sockets.gm, sockets.ivy, sockets.pat, sockets.ned, sockets.admin].every((c) => c.ws.readyState === WebSocket.OPEN));

    console.log("\nToken expiry\n");

    const shortLived = open(ivy, tokenFor(ivy, 2));
    check("a socket with a token about to expire connects", await shortLived.ready());
    check("...and is closed with 4001 once the token expires", await until(() => shortLived.closeCode === 4001, 4_000),
      `close code ${shortLived.closeCode}`);
    check("a socket with a current token stays open", sockets.ivy.ws.readyState === WebSocket.OPEN);

    console.log("\nThe web client follows the change\n");

    const { LiveClient } = await import(LIVE_CLIENT) as { LiveClient: LiveClientCtor };
    const lc = new LiveClient({ url: wsUrl, getToken: () => tokenFor(gm), WebSocket });
    const dm2 = dmThreadKey(gm.id, ned.id);
    const reconnects: string[] = [];
    const lists: string[][] = [];
    const offList = lc.onThreads((threads) => lists.push(threads));
    const offDm2 = lc.subscribe(dm2, { onReconnect: () => reconnects.push(dm2) });
    check("the client connects", await until(() => lc.status === "open"), lc.status);
    const beforeFriends = upgrades;
    await sleep(300);
    check("a DM with someone who isn't a friend yet is unavailable, without a reconnect",
      lc.threadStatus(dm2) === "unavailable" && upgrades === beforeFriends,
      `${lc.threadStatus(dm2)}, ${upgrades - beforeFriends} upgrades`);
    await call("POST", "/api/friends/request", gm, { toUserId: ned.id });
    const { rows: [fr2] } = await pool.query(`SELECT id FROM friend_requests WHERE from_user = $1 AND to_user = $2`,
      [gm.id, ned.id]);
    await call("PUT", `/api/friends/request/${fr2?.id}`, ned, { action: "accept" });
    check("once they're friends, the DM turns live in place", await until(() => lc.threadStatus(dm2) === "open"),
      lc.threadStatus(dm2));
    check("...with no reconnect", upgrades === beforeFriends, `${upgrades - beforeFriends} upgrades`);
    check("onThreads reported the new list", lists.some((l) => l.includes(dm2)), JSON.stringify(lists));
    check("the newly available thread was told to catch up (onReconnect)", reconnects.length === 1,
      JSON.stringify(reconnects));
    offDm2();
    offList();
    lc.close();
  } finally {
    for (const off of offEvents) off();
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
