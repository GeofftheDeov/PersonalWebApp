/**
 * Letters thread-keyed history and send (#101, spec #58).
 *
 * Every consumer talks to a conversation the same way, by its thread key:
 *   GET  /api/threads/:threadKey/messages?limit=&before=   newest first
 *   POST /api/threads/:threadKey/messages { body, clientId? }
 * The campaign and DM endpoints under /api/messages stay as thin aliases over
 * these until the frontend has moved off them, and must answer exactly as
 * they always have.
 *
 * Tested over HTTP only (the real routers, mounted the way server.ts mounts
 * them), plus the bus events a send publishes, which the live channel turns
 * into `message.created` frames.
 *
 * Run against a throwaway database loaded from db/schema.sql (it refuses to run
 * against anything but localhost). It deletes every row it creates.
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-thread-history.ts
 */
import "./use-test-jwt-secret.js";
import express from "express";
import type { AddressInfo } from "net";
import pool from "../db/index.js";
import { bus } from "../events/index.js";
import { signJwt } from "../utils/jwt.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
  process.exit(2);
}

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? pass++ : fail++;
}

/** Keeps reruns against the same database clear of the unique email index. */
const RUN = Math.random().toString(36).slice(2, 8);

type Person = { id: string; email: string; handle: string };

const created = { accounts: [] as string[], campaigns: [] as string[] };

async function account(handle: string): Promise<Person> {
  const h = `t101-${handle}-${RUN}`;
  const { rows } = await pool.query(
    `INSERT INTO accounts (id, handle, name, email) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id, email`,
    [h, `${handle} name`, `t101.${handle}.${RUN}@example.test`]);
  created.accounts.push(rows[0].id);
  return { id: rows[0].id, email: rows[0].email, handle: h };
}

async function campaign(title: string): Promise<{ id: string; title: string }> {
  const t = `t101 ${title} ${RUN}`;
  const { rows } = await pool.query(`INSERT INTO campaigns (title, status) VALUES ($1, 'In Progress') RETURNING id`, [t]);
  created.campaigns.push(rows[0].id);
  return { id: rows[0].id, title: t };
}

async function member(campaignId: string, person: Person, status = "Active") {
  await pool.query(`INSERT INTO campaign_members (campaign_id, person_id, status) VALUES ($1, $2, $3)`,
    [campaignId, person.id, status]);
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

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  const { default: messageRoutes } = await import("../routes/messageRoutes.js");
  const { default: threadRoutes } = await import("../routes/threadRoutes.js");
  const app = express();
  app.use(express.json());
  app.use("/api/messages", messageRoutes);
  app.use("/api/threads", threadRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call = async (method: string, path: string, who: Person | null, body?: unknown) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (who) headers.authorization = `Bearer ${signJwt({ id: who.id, email: who.email })}`;
    const res = await fetch(`${base}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  };
  const messagesPath = (key: string, qs = "") => `/api/threads/${encodeURIComponent(key)}/messages${qs}`;
  const history = (who: Person, key: string, qs = "") => call("GET", messagesPath(key, qs), who);
  const send = (who: Person, key: string, body: unknown) => call("POST", messagesPath(key), who, body);
  const bodiesOf = (res: { json: any }) => (res.json?.messages ?? []).map((m: any) => m.body);

  try {
    const gm = await account("gm");
    const player = await account("player");
    const friend = await account("friend");
    const stranger = await account("stranger");
    const invited = await account("invited");

    const strahd = await campaign("Curse of Strahd");
    await member(strahd.id, gm, "Game Master");
    await member(strahd.id, player);
    await befriend(player, friend);

    const strahdKey = `campaign:${strahd.id}`;
    const dmKey = `dm:${[player.id, friend.id].sort().join(":")}`;
    const strangerDm = `dm:${[player.id, stranger.id].sort().join(":")}`;

    /* -------------------------------------------------------------- */
    console.log("\nHistory pages newest first\n");

    // Seven messages one second apart, so ordering never rests on a tie.
    const t0 = Date.parse("2026-09-01T18:00:00.000Z");
    const ids: string[] = [];
    for (let i = 1; i <= 7; i++) {
      const who = i % 2 ? gm : player;
      const { rows } = await pool.query(
        `INSERT INTO messages (campaign_id, sender_id, sender_name, sender_email, body, created_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [strahd.id, who.id, who.handle, who.email, `t101 strahd ${i}`, new Date(t0 + i * 1000)]);
      ids.push(rows[0].id);
    }
    const strahdBody = (i: number) => `t101 strahd ${i}`;

    const first = await history(player, strahdKey, "?limit=3");
    check("a member reads the newest page (200)", first.status === 200, `got ${first.status} ${first.text}`);
    check("...newest first, `limit` long",
      sameJson(bodiesOf(first), [strahdBody(7), strahdBody(6), strahdBody(5)]), `got ${JSON.stringify(bodiesOf(first))}`);
    check("...and says there's more", first.json?.hasMore === true, `got ${first.text}`);
    const m7 = first.json?.messages?.[0];
    check("each message has the live frame's shape: id, sender {id, name}, body, createdAt",
      m7?.id === ids[6] && sameJson(m7?.sender, { id: gm.id, name: gm.handle }) && m7?.body === strahdBody(7)
        && m7?.createdAt === new Date(t0 + 7000).toISOString(),
      `got ${JSON.stringify(m7)}`);
    check("...and never the sender's email", !first.text.includes(gm.email) && !first.text.includes(player.email), first.text);

    const second = await history(player, strahdKey, `?limit=3&before=${first.json?.messages?.[2]?.id}`);
    check("`before` a message id gives the page before it",
      second.status === 200 && sameJson(bodiesOf(second), [strahdBody(4), strahdBody(3), strahdBody(2)]),
      `got ${second.status} ${JSON.stringify(bodiesOf(second))}`);
    const last = await history(player, strahdKey, `?limit=3&before=${second.json?.messages?.[2]?.id}`);
    check("the last page is short and says there's no more",
      sameJson(bodiesOf(last), [strahdBody(1)]) && last.json?.hasMore === false, `got ${last.text}`);

    const byTime = await history(player, strahdKey,
      `?limit=2&before=${encodeURIComponent(new Date(t0 + 5000).toISOString())}`);
    check("`before` a timestamp gives the messages strictly older than it",
      byTime.status === 200 && sameJson(bodiesOf(byTime), [strahdBody(4), strahdBody(3)]),
      `got ${byTime.status} ${JSON.stringify(bodiesOf(byTime))}`);

    const all = await history(player, strahdKey);
    check("with no limit, a page is 50 (all seven here)", all.json?.messages?.length === 7 && all.json?.hasMore === false,
      `got ${all.json?.messages?.length}`);
    const huge = await history(player, strahdKey, "?limit=100000");
    check("a huge limit is capped, not refused", huge.status === 200, `got ${huge.status}`);
    const zero = await history(player, strahdKey, "?limit=-4");
    check("a nonsense limit falls back to a sane page", zero.status === 200 && zero.json?.messages?.length > 0,
      `got ${zero.status} ${zero.text}`);
    const badBefore = await history(player, strahdKey, "?before=not-a-time");
    check("a `before` that is neither a message id nor a timestamp is refused (400)", badBefore.status === 400,
      `got ${badBefore.status}`);

    /* -------------------------------------------------------------- */
    console.log("\nPaging never skips or repeats\n");

    // Several messages in one millisecond, and two in the same microsecond:
    // a page boundary between any of them must lose nothing.
    const tight = await campaign("Tight");
    await member(tight.id, player);
    const tightKey = `campaign:${tight.id}`;
    const tightBodies: string[] = [];
    const stamps = [
      "2026-09-02 18:00:00.100100+00", "2026-09-02 18:00:00.100200+00", "2026-09-02 18:00:00.100200+00",
      "2026-09-02 18:00:00.100300+00", "2026-09-02 18:00:00.100300+00", "2026-09-02 18:00:00.100900+00",
    ];
    for (const [i, at] of stamps.entries()) {
      await pool.query(
        `INSERT INTO messages (campaign_id, sender_id, sender_name, sender_email, body, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`,
        [tight.id, player.id, player.handle, player.email, `t101 tight ${i}`, at]);
      tightBodies.push(`t101 tight ${i}`);
    }
    const walked: string[] = [];
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const res = await history(player, tightKey, `?limit=1${cursor ? `&before=${cursor}` : ""}`);
      const msgs = res.json?.messages ?? [];
      walked.push(...msgs.map((m: any) => m.body));
      if (!res.json?.hasMore || !msgs.length) break;
      cursor = msgs[msgs.length - 1].id;
    }
    check("walking one message at a time by id visits every message once, newest first",
      walked.length === tightBodies.length && new Set(walked).size === tightBodies.length
        && walked[0] === "t101 tight 5" && walked[walked.length - 1] === "t101 tight 0",
      `got ${JSON.stringify(walked)}`);

    /* -------------------------------------------------------------- */
    console.log("\nSend by thread key\n");

    const seen: any[] = [];
    const offCampaign = bus.subscribe("gamenight.message", (p) => { seen.push(["gamenight.message", p]); });
    const offDm = bus.subscribe("social.dm", (p) => { seen.push(["social.dm", p]); });
    const published = async (name: string, messageId: string) => {
      for (let i = 0; i < 20 && !seen.some(([n, p]) => n === name && p.messageId === messageId); i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      return seen.filter(([n, p]) => n === name && p.messageId === messageId).map(([, p]) => p);
    };

    const sent = await send(player, strahdKey, { body: "  t101 I light a torch  " });
    check("a member sends to a campaign thread (201)", sent.status === 201, `got ${sent.status} ${sent.text}`);
    const sentMsg = sent.json?.message;
    check("...and gets the saved message back, trimmed, in the history shape",
      typeof sentMsg?.id === "string" && sentMsg?.body === "t101 I light a torch"
        && sameJson(sentMsg?.sender, { id: player.id, name: player.handle }) && typeof sentMsg?.createdAt === "string",
      `got ${sent.text}`);
    const afterSend = await history(gm, strahdKey, "?limit=1");
    check("...which is the newest message another member now reads", afterSend.json?.messages?.[0]?.id === sentMsg?.id,
      `got ${afterSend.text}`);
    const campaignEvents = await published("gamenight.message", sentMsg?.id);
    check("...published once as gamenight.message, the payload the live channel forwards",
      campaignEvents.length === 1 && campaignEvents[0].campaignId === strahd.id
        && campaignEvents[0].body === "t101 I light a torch" && campaignEvents[0].sender?.id === player.id
        && campaignEvents[0].createdAt === sentMsg?.createdAt,
      `got ${JSON.stringify(campaignEvents)}`);

    const dmSent = await send(player, dmKey, { body: "t101 bring snacks" });
    check("a friend sends to a DM thread (201)", dmSent.status === 201, `got ${dmSent.status} ${dmSent.text}`);
    const dmEvents = await published("social.dm", dmSent.json?.message?.id);
    check("...published once as social.dm to the other side of the pair",
      dmEvents.length === 1 && dmEvents[0].dmKey === dmKey.slice(3) && dmEvents[0].recipientId === friend.id,
      `got ${JSON.stringify(dmEvents)}`);
    const friendReads = await history(friend, dmKey);
    check("...and the other side reads it in the DM's history",
      friendReads.status === 200 && friendReads.json?.messages?.[0]?.body === "t101 bring snacks", `got ${friendReads.text}`);

    const empty = await send(player, strahdKey, { body: "   " });
    check("an empty body is refused (400)", empty.status === 400, `got ${empty.status}`);
    const tooLong = await send(player, strahdKey, { body: "x".repeat(4001) });
    check("a body over 4000 characters is refused (400), not a server error", tooLong.status === 400,
      `got ${tooLong.status}`);

    /* -------------------------------------------------------------- */
    console.log("\nResending is exactly once\n");

    const before = (await history(player, strahdKey, "?limit=200")).json?.messages?.length;
    const once = await send(player, strahdKey, { body: "t101 resend me", clientId: `t101-${RUN}-a` });
    const again = await send(player, strahdKey, { body: "t101 resend me", clientId: `t101-${RUN}-a` });
    check("the first send with a clientId creates the message (201)", once.status === 201, `got ${once.status} ${once.text}`);
    check("sending the same clientId again returns that same message (200), not a new one",
      again.status === 200 && again.json?.message?.id === once.json?.message?.id, `got ${again.status} ${again.text}`);
    const afterResend = (await history(player, strahdKey, "?limit=200")).json?.messages ?? [];
    check("...so the thread holds it once",
      afterResend.length === before + 1 && afterResend.filter((m: any) => m.body === "t101 resend me").length === 1,
      `had ${before}, now ${afterResend.length}`);
    check("...and it was published once", (await published("gamenight.message", once.json?.message?.id)).length === 1);
    const otherSender = await send(gm, strahdKey, { body: "t101 same id, other person", clientId: `t101-${RUN}-a` });
    check("another person's clientId never collides with yours", otherSender.status === 201,
      `got ${otherSender.status} ${otherSender.text}`);
    const elsewhere = await send(player, dmKey, { body: "t101 resend me", clientId: `t101-${RUN}-a` });
    check("reusing a clientId in another thread is refused (409)", elsewhere.status === 409,
      `got ${elsewhere.status} ${elsewhere.text}`);
    const badClientId = await send(player, strahdKey, { body: "t101 x", clientId: "a b" });
    check("a malformed clientId is refused (400)", badClientId.status === 400, `got ${badClientId.status}`);

    offCampaign();
    offDm();

    /* -------------------------------------------------------------- */
    console.log("\nOnly the thread's people\n");

    const outsiderReads = await history(stranger, strahdKey);
    check("a non-member can't read a campaign's history (403)", outsiderReads.status === 403,
      `got ${outsiderReads.status}`);
    const outsiderSends = await send(stranger, strahdKey, { body: "t101 let me in" });
    check("...or send to it (403)", outsiderSends.status === 403, `got ${outsiderSends.status}`);
    await member(strahd.id, invited, "Invited");
    check("an invited-but-not-joined person counts as a member (as before)",
      (await history(invited, strahdKey)).status === 200);

    const nonFriendReads = await history(player, strangerDm);
    check("a non-friend can't read a DM thread (403)", nonFriendReads.status === 403, `got ${nonFriendReads.status}`);
    const nonFriendSends = await send(player, strangerDm, { body: "t101 hi stranger" });
    check("...or send to it (403)", nonFriendSends.status === 403, `got ${nonFriendSends.status}`);
    const thirdParty = await history(gm, dmKey);
    check("someone outside a DM pair can't read it (403)", thirdParty.status === 403, `got ${thirdParty.status}`);
    const thirdPartySends = await send(gm, dmKey, { body: "t101 eavesdrop" });
    check("...or send to it (403)", thirdPartySends.status === 403, `got ${thirdPartySends.status}`);

    const badKey = await history(player, "campaign:nope");
    check("a malformed thread key is refused (400)", badKey.status === 400, `got ${badKey.status}`);
    const anon = await call("GET", messagesPath(strahdKey), null);
    check("history needs a signed-in person (401)", anon.status === 401, `got ${anon.status}`);
    const anonSend = await call("POST", messagesPath(strahdKey), null, { body: "t101" });
    check("send needs a signed-in person (401)", anonSend.status === 401, `got ${anonSend.status}`);
    const noSideEffects = await pool.query(`SELECT count(*)::int AS n FROM messages WHERE body LIKE 't101 %' AND sender_id = $1`,
      [stranger.id]);
    check("refused sends write nothing", noSideEffects.rows[0].n === 0);

    /* -------------------------------------------------------------- */
    console.log("\nThe old endpoints answer as before\n");

    /** What GET /api/messages/... always returned: the stored row in the model's shape. */
    const legacyRow = async (id: string) => {
      const { rows: [r] } = await pool.query(`SELECT * FROM messages WHERE id = $1`, [id]);
      return {
        campaign: r.campaign_id, event: r.event_id, dmKey: r.dm_key, recipient: r.recipient,
        sender: { id: r.sender_id, name: r.sender_name, email: r.sender_email },
        body: r.body, createdAt: new Date(r.created_at).toISOString(), _id: r.id, id: r.id,
      };
    };
    const normalize = (rows: any[]) => rows.map((r) => {
      const keys = Object.keys(r).sort();
      return Object.fromEntries(keys.map((k) => [k, k === "sender" ? { ...r.sender } : r[k]]));
    });

    const oldPage = await call("GET", `/api/messages/campaign/${strahd.id}?limit=3`, player);
    const newPage = await history(player, strahdKey, "?limit=3");
    check("old campaign history: a bare array, same messages and order as the thread endpoint",
      oldPage.status === 200 && Array.isArray(oldPage.json)
        && sameJson(oldPage.json.map((m: any) => m._id), newPage.json?.messages?.map((m: any) => m.id)),
      `got ${oldPage.status} ${oldPage.text}`);
    const expected = await Promise.all((oldPage.json ?? []).map((m: any) => legacyRow(m._id)));
    check("...each message in the model's shape, as before",
      sameJson(normalize(oldPage.json ?? []), normalize(expected)), `got ${oldPage.text}\n  want ${JSON.stringify(expected)}`);
    const oldBefore = await call("GET", `/api/messages/campaign/${strahd.id}?limit=2&before=${ids[4]}`, player);
    check("...`before` a message id still pages", sameJson(oldBefore.json?.map((m: any) => m.body), [strahdBody(4), strahdBody(3)]),
      `got ${oldBefore.text}`);
    const oldBeforeTime = await call("GET",
      `/api/messages/campaign/${strahd.id}?limit=2&before=${encodeURIComponent(new Date(t0 + 3000).toISOString())}`, player);
    check("...`before` a timestamp still pages",
      sameJson(oldBeforeTime.json?.map((m: any) => m.body), [strahdBody(2), strahdBody(1)]), `got ${oldBeforeTime.text}`);

    const oldDm = await call("GET", `/api/messages/dm/${friend.id}`, player);
    const newDm = await history(player, dmKey);
    const expectedDm = await Promise.all((oldDm.json ?? []).map((m: any) => legacyRow(m._id)));
    check("old DM history: same messages as the thread endpoint, in the model's shape",
      oldDm.status === 200 && sameJson(oldDm.json?.map((m: any) => m._id), newDm.json?.messages?.map((m: any) => m.id))
        && sameJson(normalize(oldDm.json ?? []), normalize(expectedDm)),
      `got ${oldDm.status} ${oldDm.text}`);

    const oldSend = await call("POST", `/api/messages/campaign/${strahd.id}`, gm, { body: " t101 old send " });
    check("old campaign send: 201 with the saved message in the model's shape",
      oldSend.status === 201 && sameJson(normalize([oldSend.json]), normalize([await legacyRow(oldSend.json?._id)]))
        && oldSend.json?.body === "t101 old send",
      `got ${oldSend.status} ${oldSend.text}`);
    check("...landing in the thread", (await history(player, strahdKey, "?limit=1")).json?.messages?.[0]?.id === oldSend.json?._id);
    const oldDmSend = await call("POST", `/api/messages/dm/${player.id}`, friend, { body: "t101 old dm" });
    check("old DM send: 201 with the saved message, recipient set",
      oldDmSend.status === 201 && oldDmSend.json?.recipient === player.id && oldDmSend.json?.dmKey === dmKey.slice(3)
        && sameJson(normalize([oldDmSend.json]), normalize([await legacyRow(oldDmSend.json?._id)])),
      `got ${oldDmSend.status} ${oldDmSend.text}`);

    const oldForbidden = await call("GET", `/api/messages/campaign/${strahd.id}`, stranger);
    check("old campaign history: non-members still get 403 with the same error",
      oldForbidden.status === 403 && oldForbidden.json?.error === "Not a member of this campaign", `got ${oldForbidden.text}`);
    const oldForbiddenSend = await call("POST", `/api/messages/campaign/${strahd.id}`, stranger, { body: "t101 hi" });
    check("old campaign send: non-members still get 403 with the same error",
      oldForbiddenSend.status === 403 && oldForbiddenSend.json?.error === "Not a member of this campaign",
      `got ${oldForbiddenSend.text}`);
    const oldBadCampaign = await call("GET", `/api/messages/campaign/not-a-uuid`, player);
    check("old campaign history: a malformed campaign id is still 403", oldBadCampaign.status === 403,
      `got ${oldBadCampaign.status}`);
    const oldDmForbidden = await call("GET", `/api/messages/dm/${stranger.id}`, player);
    check("old DM history: non-friends still get 403 with the same error",
      oldDmForbidden.status === 403 && oldDmForbidden.json?.error === "You can only message friends", `got ${oldDmForbidden.text}`);
    const oldDmForbiddenSend = await call("POST", `/api/messages/dm/${stranger.id}`, player, { body: "t101 hi" });
    check("old DM send: non-friends still get 403 with the same error",
      oldDmForbiddenSend.status === 403 && oldDmForbiddenSend.json?.error === "You can only message friends",
      `got ${oldDmForbiddenSend.text}`);
    const oldEmpty = await call("POST", `/api/messages/campaign/${strahd.id}`, player, { body: "" });
    check("old send: an empty body is still 400 'body is required'",
      oldEmpty.status === 400 && oldEmpty.json?.error === "body is required", `got ${oldEmpty.text}`);
  } finally {
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
