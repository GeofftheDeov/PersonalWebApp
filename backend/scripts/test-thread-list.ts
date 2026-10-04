/**
 * Letters thread list with unread counts (#100, spec #58).
 *
 * One call answers "which conversations do I have, and where's something
 * new?": one thread per active campaign the person is a member of, one per
 * friend they've exchanged messages with, each with a title, subtitle, last
 * activity and unread count, and never a message body.
 *
 * Tested over HTTP only (the real routers, mounted the way server.ts mounts
 * them): GET /api/threads, POST /api/threads/:threadKey/read, and the existing
 * message send endpoints for the bell notifications.
 *
 * Run against a throwaway database loaded from db/schema.sql (it refuses to run
 * against anything but localhost). It deletes every row it creates.
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-thread-list.ts
 */
import express from "express";
import type { AddressInfo } from "net";
import jwt from "jsonwebtoken";
import pool from "../db/index.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
  process.exit(2);
}

// Set before the routes load, so this keeps working once the secret is
// required at boot (#95).
process.env.JWT_SECRET ||= "t100-thread-list-test-secret";
const SECRET = process.env.JWT_SECRET;

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
  const h = `t100-${handle}-${RUN}`;
  const { rows } = await pool.query(
    `INSERT INTO accounts (id, handle, name, email) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id, email`,
    [h, `${handle} name`, `t100.${handle}.${RUN}@example.test`]);
  created.accounts.push(rows[0].id);
  return { id: rows[0].id, email: rows[0].email, handle: h };
}

async function campaign(title: string, status = "In Progress"): Promise<{ id: string; title: string }> {
  const t = `t100 ${title} ${RUN}`;
  const { rows } = await pool.query(`INSERT INTO campaigns (title, status) VALUES ($1, $2) RETURNING id`, [t, status]);
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
  // DM rows carry no FK to either side; campaign rows cascade with the campaign.
  await pool.query(`DELETE FROM messages WHERE campaign_id = ANY($1::uuid[]) OR sender_id = ANY($2::text[])`,
    [campaigns, accounts]);
  await pool.query(`DELETE FROM notifications WHERE user_id = ANY($1::uuid[])`, [accounts]);
  await pool.query(`DELETE FROM campaigns WHERE id = ANY($1::uuid[])`, [campaigns]);
  await pool.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [accounts]);
}

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

  const tokenFor = (p: Person) => jwt.sign({ id: p.id, email: p.email }, SECRET);
  const call = async (method: string, path: string, who: Person, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${tokenFor(who)}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  };
  /** Sends through the real endpoints; returns the saved message. */
  const say = async (who: Person, to: { campaign?: string; friend?: Person }, body: string) => {
    const path = to.campaign ? `/api/messages/campaign/${to.campaign}` : `/api/messages/dm/${to.friend!.id}`;
    const res = await call("POST", path, who, { body });
    if (res.status !== 201) throw new Error(`send failed: ${res.status} ${res.text}`);
    return res.json as { _id: string; body: string };
  };
  const threadsOf = async (who: Person, filter?: string) => {
    const res = await call("GET", `/api/threads${filter ? `?filter=${filter}` : ""}`, who);
    return { ...res, threads: (res.json?.threads ?? []) as any[] };
  };
  const byKey = (threads: any[], key: string) => threads.find((t) => t.threadKey === key);

  try {
    const gm = await account("gm");
    const player = await account("player");
    const bard = await account("bard");
    const friend = await account("friend");
    const quiet = await account("quiet"); // a friend nobody has messaged

    const strahd = await campaign("Curse of Strahd");
    const phandelver = await campaign("Phandelver", "Not Started");
    const done = await campaign("Lost Mine", "Completed");
    for (const c of [strahd, phandelver, done]) {
      await member(c.id, gm, "Game Master");
      await member(c.id, player);
    }
    await member(strahd.id, bard);
    await befriend(player, friend);
    await befriend(player, quiet);

    const strahdKey = `campaign:${strahd.id}`;
    const phandelverKey = `campaign:${phandelver.id}`;
    const doneKey = `campaign:${done.id}`;
    const dmKey = `dm:${[player.id, friend.id].sort().join(":")}`;
    const quietKey = `dm:${[player.id, quiet.id].sort().join(":")}`;

    // Oldest activity first: Phandelver, then the DM, then Strahd.
    const bodies: string[] = [];
    const s = async (who: Person, to: { campaign?: string; friend?: Person }, body: string) => {
      bodies.push(body);
      return say(who, to, body);
    };
    await s(gm, { campaign: phandelver.id }, "t100 phandelver session zero is friday");
    await s(gm, { campaign: done.id }, "t100 thanks for a great campaign");
    await s(friend, { friend: player }, "t100 are you coming tonight");
    await s(player, { friend }, "t100 yes, bringing snacks");
    await s(gm, { campaign: strahd.id }, "t100 the mists close in");
    await s(bard, { campaign: strahd.id }, "t100 I play a sad song");
    const playerLast = await s(player, { campaign: strahd.id }, "t100 I light a torch");

    console.log("\nThe thread list\n");

    const all = await threadsOf(player);
    check("lists threads (200)", all.status === 200 && Array.isArray(all.json?.threads),
      `got ${all.status} ${all.text}`);
    check("a member of two active campaigns with one messaged friend gets exactly three threads",
      all.threads.length === 3
        && [strahdKey, phandelverKey, dmKey].every((k) => byKey(all.threads, k)),
      `got ${JSON.stringify(all.threads.map((t) => t.threadKey))}`);

    const st = byKey(all.threads, strahdKey);
    check("a campaign thread is titled by the campaign and counts its party",
      st?.kind === "campaign" && st?.title === strahd.title && st?.subtitle === "Campaign · 3 in the party",
      `got ${JSON.stringify(st)}`);
    const ph = byKey(all.threads, phandelverKey);
    check("...whatever its party size",
      ph?.kind === "campaign" && ph?.title === phandelver.title && ph?.subtitle === "Campaign · 2 in the party",
      `got ${JSON.stringify(ph)}`);
    const dm = byKey(all.threads, dmKey);
    check("a DM thread is titled by the friend's handle, subtitled Friend",
      dm?.kind === "dm" && dm?.title === friend.handle && dm?.subtitle === "Friend",
      `got ${JSON.stringify(dm)}`);
    check("each thread names what to open: the campaign id or the friend's id",
      st?.targetId === strahd.id && dm?.targetId === friend.id, `got ${st?.targetId} / ${dm?.targetId}`);
    check("each thread has an avatar hint",
      all.threads.every((t) => typeof t.avatarHint === "string" && t.avatarHint.length > 0),
      `got ${JSON.stringify(all.threads.map((t) => t.avatarHint))}`);

    check("unread counts cover only other people's messages",
      st?.unreadCount === 2 && ph?.unreadCount === 1 && dm?.unreadCount === 1,
      `got strahd=${st?.unreadCount} phandelver=${ph?.unreadCount} dm=${dm?.unreadCount}`);
    check("no message text anywhere in the response",
      bodies.every((b) => !all.text.includes(b)) && !/"body"/.test(all.text), all.text);

    check("sorted by most recent activity",
      JSON.stringify(all.threads.map((t) => t.threadKey)) === JSON.stringify([strahdKey, dmKey, phandelverKey]),
      `got ${JSON.stringify(all.threads.map((t) => t.threadKey))}`);
    check("last activity is the newest message's time",
      typeof st?.lastActivityAt === "string"
        && new Date(st.lastActivityAt).getTime() >= new Date(dm?.lastActivityAt).getTime()
        && new Date(dm?.lastActivityAt).getTime() >= new Date(ph?.lastActivityAt).getTime(),
      `got ${st?.lastActivityAt} / ${dm?.lastActivityAt} / ${ph?.lastActivityAt}`);
    check("a Completed campaign doesn't appear, even with messages", !byKey(all.threads, doneKey));
    check("a friend with no messages doesn't appear", !byKey(all.threads, quietKey));

    console.log("\nFilters\n");

    const campaignsOnly = await threadsOf(player, "campaigns");
    check("the campaigns filter returns only campaign threads",
      campaignsOnly.status === 200 && campaignsOnly.threads.length === 2
        && campaignsOnly.threads.every((t) => t.kind === "campaign"),
      `got ${campaignsOnly.status} ${JSON.stringify(campaignsOnly.threads.map((t) => t.threadKey))}`);
    const friendsOnly = await threadsOf(player, "friends");
    check("the friends filter returns only DM threads",
      friendsOnly.status === 200 && friendsOnly.threads.length === 1 && friendsOnly.threads[0].threadKey === dmKey,
      `got ${friendsOnly.status} ${JSON.stringify(friendsOnly.threads.map((t) => t.threadKey))}`);
    const explicitAll = await threadsOf(player, "all");
    check("filter=all is the whole list", explicitAll.threads.length === 3, `got ${explicitAll.threads.length}`);
    const badFilter = await threadsOf(player, "groups");
    check("an unknown filter is refused with 400", badFilter.status === 400, `got ${badFilter.status}`);

    const anon = await fetch(`${base}/api/threads`);
    check("the list needs a signed-in person (401)", anon.status === 401, `got ${anon.status}`);

    console.log("\nRead state\n");

    const readPath = (key: string) => `/api/threads/${encodeURIComponent(key)}/read`;
    const unread = async (who: Person, key: string) => byKey((await threadsOf(who)).threads, key)?.unreadCount;

    const bardBefore = await unread(bard, strahdKey);
    check("another member starts with their own count", bardBefore === 2, `got ${bardBefore}`);

    const marked = await call("POST", readPath(strahdKey), player, { messageId: playerLast._id });
    check("mark read up to the latest message (200)",
      marked.status === 200 && marked.json?.threadKey === strahdKey && marked.json?.lastReadMessageId === playerLast._id
        && typeof marked.json?.lastReadAt === "string",
      `got ${marked.status} ${marked.text}`);
    check("...clears that thread's unread count", (await unread(player, strahdKey)) === 0);
    check("...and leaves the other threads alone",
      (await unread(player, phandelverKey)) === 1 && (await unread(player, dmKey)) === 1);
    check("read state is per person: another member's count doesn't change",
      (await unread(bard, strahdKey)) === bardBefore, `got ${await unread(bard, strahdKey)}`);

    await say(player, { campaign: strahd.id }, "t100 I search the crypt");
    check("your own messages never count as unread", (await unread(player, strahdKey)) === 0);

    const older = (await call("GET", `/api/messages/campaign/${strahd.id}?limit=50`, player)).json as any[];
    const oldest = older[older.length - 1];
    const back = await call("POST", readPath(strahdKey), player, { messageId: oldest._id });
    check("marking read up to an older message never moves the position back",
      back.status === 200 && back.json?.lastReadMessageId !== oldest._id && (await unread(player, strahdKey)) === 0,
      `got ${back.status} ${back.text}`);

    await say(gm, { campaign: strahd.id }, "t100 a wolf howls");
    check("a new message from someone else counts again", (await unread(player, strahdKey)) === 1);

    const dmLatest = (await call("GET", `/api/messages/dm/${friend.id}?limit=1`, player)).json?.[0];
    const dmRead = await call("POST", readPath(dmKey), player, { messageId: dmLatest?._id });
    check("mark read works for a DM thread too",
      dmRead.status === 200 && (await unread(player, dmKey)) === 0, `got ${dmRead.status} ${dmRead.text}`);
    check("...and only for that side of the pair", (await unread(friend, dmKey)) === 1,
      `got ${await unread(friend, dmKey)}`);

    const outsider = await account("outsider");
    const notMine = await call("POST", readPath(strahdKey), outsider, { messageId: playerLast._id });
    check("someone outside the thread can't mark it read (403)", notMine.status === 403,
      `got ${notMine.status} ${notMine.text}`);
    const wrongThread = await call("POST", readPath(phandelverKey), player, { messageId: playerLast._id });
    check("a message from another thread is refused (404)", wrongThread.status === 404,
      `got ${wrongThread.status} ${wrongThread.text}`);
    const noMessage = await call("POST", readPath(strahdKey), player, {});
    check("a missing message id is refused (400)", noMessage.status === 400, `got ${noMessage.status}`);
    const badKey = await call("POST", readPath("campaign:not-a-uuid"), player, { messageId: playerLast._id });
    check("a malformed thread key is refused (400)", badKey.status === 400, `got ${badKey.status}`);
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
