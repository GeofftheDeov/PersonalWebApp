/**
 * Unified accounts, Phases 4 and 5 (#36, #37): friend typeahead, the
 * campaign's Characters tab, the Paperclip identity link, chat presence,
 * session attendance, and active / inactive players.
 *
 * The routes mounted as server.ts mounts them, the live channel on the same
 * HTTP server, and the process's own event bus (in memory when REDIS_URL is
 * unset). Covers:
 *   - GET /api/friends/search: a typeahead array by handle prefix, the exact
 *     handle#number lookup, at least two characters, and never yourself, a
 *     friend or a deactivated account;
 *   - GET /api/tabletop/characters?campaign=: one party's characters with the
 *     player joined, a former member's flagged, and 403 for an outsider;
 *   - deactivating a player (PATCH /api/campaign-members/:id/active): GM only,
 *     never a GM; the campaign leaves their list, history and posting 403,
 *     their open socket loses the thread at once, rejoining by link is
 *     refused, the GM still sees them and other players don't, and
 *     reactivating brings it all back;
 *   - attendance: the GM's checklist carries the ready check, confirming
 *     replaces the set and records that it was taken, players see attendees
 *     only, a former member stays on it, and the campaign's session list
 *     counts them;
 *   - the Paperclip link: found by email in the member list, kept as the
 *     principalId, dropped when the member leaves, a stored link standing
 *     while Paperclip is down, and never self-set through PUT /users/profile;
 *   - presence: a socket that opens Table Talk is listed to the thread's
 *     sockets, closing it or disconnecting takes it off, a deactivated
 *     player drops off, and another task's presence shows until it expires.
 *
 * Run against a throwaway database loaded from db/schema.sql (it refuses to run
 * against anything but localhost). It deletes every row it creates.
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-unified-accounts-phase4-5.ts
 */
import "./use-test-jwt-secret.js";
import express from "express";
import http from "http";
import type { AddressInfo } from "net";
import WebSocket from "ws";
import pool from "../db/index.js";
import { signJwt } from "../utils/jwt.js";
import { attachLiveChannel, LIVE_PATH, PROTOCOL_VERSION, PRESENCE_TTL_MS } from "../live/liveChannel.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
  process.exit(2);
}

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? pass++ : fail++;
}

async function until(predicate: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return predicate();
}
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

const RUN = Math.random().toString(36).slice(2, 8);
const created = { accounts: [] as string[], campaigns: [] as string[] };

type Person = { id: string; email: string; handle: string };

async function account(handle: string, extra: { active?: boolean; userNumber?: string } = {}): Promise<Person> {
  const full = `${handle}${RUN}`;
  const { rows: [r] } = await pool.query(
    `INSERT INTO accounts (id, handle, name, email, user_number, is_active)
     VALUES (gen_random_uuid(), $1, $1, $2, $3, $4) RETURNING id, email, handle`,
    [full, `${full}@example.test`, extra.userNumber ?? "1000", extra.active ?? true]);
  created.accounts.push(r.id);
  return { id: r.id, email: r.email, handle: r.handle };
}

async function member(campaignId: string, personId: string, status = "Player") {
  const { rows: [r] } = await pool.query(
    `INSERT INTO campaign_members (campaign_id, person_id, status) VALUES ($1, $2, $3) RETURNING id`,
    [campaignId, personId, status]);
  return r.id as string;
}

async function cleanup() {
  const { accounts, campaigns } = created;
  await pool.query(`DELETE FROM messages WHERE campaign_id = ANY($1::uuid[])`, [campaigns]);
  await pool.query(`DELETE FROM characters WHERE campaign_id = ANY($1::uuid[])`, [campaigns]);
  await pool.query(`DELETE FROM campaigns WHERE id = ANY($1::uuid[])`, [campaigns]);
  await pool.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [accounts]);
}

const tokenFor = (p: Person) => signJwt({ id: p.id, email: p.email });
type Frame = { type: string; [k: string]: any };

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
    presence: (thread: string, here = true) => ws.send(JSON.stringify({ type: "presence", thread, here })),
    /** Ids in the latest presence frame for the thread, or null if none arrived. */
    present: (thread: string): string[] | null => {
      const f = frames.filter((x) => x.type === "presence" && x.thread === thread).at(-1);
      return f ? f.people.map((p: any) => p.id) : null;
    },
  };
}

const same = (a: string[] | null, b: string[]) => !!a && a.length === b.length && b.every((x) => a.includes(x));

async function main() {
  const { default: campaignRoutes } = await import("../routes/campaignRoutes.js");
  const { default: campaignMemberRoutes } = await import("../routes/campaignMemberRoutes.js");
  const { default: friendRoutes } = await import("../routes/friendRoutes.js");
  const { default: threadRoutes } = await import("../routes/threadRoutes.js");
  const { default: tabletopRoutes } = await import("../routes/tabletopRoutes.js");
  const { default: userRoutes } = await import("../routes/userRoutes.js");
  const { bus, startEventBus } = await import("../events/index.js");
  const identity = await import("../services/paperclipIdentity.js");

  const app = express();
  app.use(express.json());
  app.use("/api/campaigns", campaignRoutes);
  app.use("/api/campaign-members", campaignMemberRoutes);
  app.use("/api/friends", friendRoutes);
  app.use("/api/threads", threadRoutes);
  app.use("/api/tabletop", tabletopRoutes);
  app.use("/api/users", userRoutes);
  const server = http.createServer(app);
  const live = await attachLiveChannel(server);
  await startEventBus();
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const liveUrl = `ws://127.0.0.1:${port}${LIVE_PATH}`;

  const call = async (method: string, path: string, who: Person, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${tokenFor(who)}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) as any };
  };

  const sockets: ReturnType<typeof client>[] = [];
  try {
    /* ------------------------------------------------------------ */
    console.log("\nFriend search (#36)\n");
    const me = await account("seeker");
    const friend = await account("seekfriend");
    const stranger = await account("seekstranger", { userNumber: "4242" });
    const gone = await account("seekgone", { active: false });
    const lonely = await account("zzlonely");
    await pool.query(`UPDATE accounts SET friends = ARRAY[$2::uuid] WHERE id = $1`, [me.id, friend.id]);
    await pool.query(`UPDATE accounts SET friends = ARRAY[$2::uuid] WHERE id = $1`, [friend.id, me.id]);

    const prefix = await call("GET", `/api/friends/search?query=seek`, me);
    const ids = Array.isArray(prefix.json) ? prefix.json.map((p: any) => p._id) : [];
    check("a prefix answers with an array of matches", prefix.status === 200 && ids.includes(stranger.id), JSON.stringify(prefix));
    check("never yourself, a friend, or a deactivated account",
      !ids.includes(me.id) && !ids.includes(friend.id) && !ids.includes(gone.id), JSON.stringify(ids));
    check("at most ten", ids.length <= 10);
    const exact = await call("GET", `/api/friends/search?query=@${stranger.handle.toUpperCase()}%234242`, me);
    check("handle#number is an exact, case-insensitive lookup",
      exact.status === 200 && exact.json?.length === 1 && exact.json[0]._id === stranger.id, JSON.stringify(exact.json));
    const wrongNumber = await call("GET", `/api/friends/search?query=${stranger.handle}%230001`, me);
    check("a wrong number finds nobody", wrongNumber.status === 200 && wrongNumber.json?.length === 0);
    const short = await call("GET", `/api/friends/search?query=s`, me);
    check("one character is refused", short.status === 400);
    const unrelated = await call("GET", `/api/friends/search?query=seek`, lonely);
    check("results carry no email address", !JSON.stringify(unrelated.json).includes("@example.test"));
    const toGone = await call("POST", `/api/friends/request`, me, { toUserId: gone.id });
    check("a deactivated account can't be sent a request", toGone.status === 404);
    await pool.query(`UPDATE accounts SET is_active = false WHERE id = $1`, [friend.id]);
    const list = await call("GET", `/api/friends/list`, me);
    check("a deactivated friend drops out of the list (#31)", Array.isArray(list.json) && !list.json.some((f: any) => f._id === friend.id));
    const { rows: [arr] } = await pool.query(`SELECT friends FROM accounts WHERE id = $1`, [me.id]);
    check("...but stays in the array, for reactivation", arr.friends.includes(friend.id));

    /* ------------------------------------------------------------ */
    console.log("\nA campaign: characters, deactivation, attendance (#36, #37)\n");
    const gm = await account("gm");
    const ana = await account("ana");
    const bo = await account("bo");
    const outsider = await account("outsider");
    const { rows: [c] } = await pool.query(`INSERT INTO campaigns (title, owner_id) VALUES ('Phase Five', $1) RETURNING id`, [gm.id]);
    const campaignId: string = c.id;
    created.campaigns.push(campaignId);
    const gmSeat = await member(campaignId, gm.id, "Game Master");
    await member(campaignId, ana.id);
    const boSeat = await member(campaignId, bo.id);
    await pool.query(
      `INSERT INTO characters (name, player_id, campaign_id, class, level) VALUES
         ('Anwen', $1, $3, 'Bard', 3), ('Borin', $2, $3, 'Fighter', 4)`, [ana.id, bo.id, campaignId]);

    const chars = await call("GET", `/api/tabletop/characters?campaign=${campaignId}`, ana);
    const borin = chars.json?.find((x: any) => x.name === "Borin");
    check("?campaign= lists the party's characters", chars.status === 200 && chars.json?.length === 2, JSON.stringify(chars.json));
    check("with who plays each, and no email", borin?.player?._id === bo.id && borin?.playerActive === true
      && !JSON.stringify(chars.json).includes("@example.test"), JSON.stringify(borin));
    check("an outsider gets 403", (await call("GET", `/api/tabletop/characters?campaign=${campaignId}`, outsider)).status === 403);
    check("a malformed campaign is 400", (await call("GET", `/api/tabletop/characters?campaign=nope`, ana)).status === 400);

    // A session that already happened, with a ready check.
    const { rows: [s] } = await pool.query(
      `INSERT INTO game_sessions (title, campaign_id, date, ready_check) VALUES ('Night one', $1, now() - interval '2 hours', $2)
       RETURNING id`,
      [campaignId, JSON.stringify({ sentAt: new Date().toISOString(), responses: [
        { playerId: ana.id, name: "ana", ready: true }, { playerId: bo.id, name: "bo", ready: false }] })]);
    const sessionId: string = s.id;
    const { rows: [future] } = await pool.query(
      `INSERT INTO game_sessions (title, campaign_id, date) VALUES ('Night two', $1, now() + interval '2 days') RETURNING id`, [campaignId]);

    const gmView = await call("GET", `/api/tabletop/sessions/${sessionId}/attendance`, gm);
    const anaRow = gmView.json?.people?.find((p: any) => p.playerId === ana.id);
    check("the GM gets the party checklist, not yet taken",
      gmView.status === 200 && gmView.json.canConfirm && gmView.json.confirmedAt === null && gmView.json.people.length === 3, JSON.stringify(gmView.json));
    check("pre-filled from the ready check", anaRow?.ready === true
      && gmView.json.people.find((p: any) => p.playerId === bo.id)?.ready === false);
    const playerView = await call("GET", `/api/tabletop/sessions/${sessionId}/attendance`, ana);
    check("a player sees attendees only (none yet)", playerView.json?.canConfirm === false && playerView.json?.people.length === 0);
    check("a player can't take attendance", (await call("PUT", `/api/tabletop/sessions/${sessionId}/attendance`, ana, { playerIds: [ana.id] })).status === 403);
    check("nor can anyone list an outsider",
      (await call("PUT", `/api/tabletop/sessions/${sessionId}/attendance`, gm, { playerIds: [outsider.id] })).status === 400);
    check("a session still to come isn't open",
      (await call("PUT", `/api/tabletop/sessions/${future.id}/attendance`, gm, { playerIds: [ana.id] })).status === 409);
    const confirmed = await call("PUT", `/api/tabletop/sessions/${sessionId}/attendance`, gm, { playerIds: [ana.id, bo.id] });
    check("the GM confirms who came", confirmed.status === 200 && confirmed.json.confirmedAt
      && confirmed.json.people.filter((p: any) => p.attended).length === 2, JSON.stringify(confirmed.json));
    const again = await call("PUT", `/api/tabletop/sessions/${sessionId}/attendance`, gm, { playerIds: [ana.id] });
    const { rows: rowsNow } = await pool.query(`SELECT player_id FROM player_sessions WHERE session_id = $1`, [sessionId]);
    check("confirming again replaces the set", again.status === 200 && rowsNow.length === 1 && rowsNow[0].player_id === ana.id);
    await call("PUT", `/api/tabletop/sessions/${sessionId}/attendance`, gm, { playerIds: [ana.id, bo.id] });
    const sessionsList = await call("GET", `/api/campaigns/${campaignId}/sessions`, ana);
    const listed = sessionsList.json?.find((x: any) => x._id === sessionId);
    check("the campaign's session list counts attendees", listed?.attendeeCount === 2 && Boolean(listed?.attendanceConfirmedAt), JSON.stringify(listed));

    // Sockets before deactivation, to watch the thread go.
    const thread = `campaign:${campaignId}`;
    const boSock = client(liveUrl, bo); sockets.push(boSock);
    const anaSock = client(liveUrl, ana); sockets.push(anaSock);
    await boSock.ready(); await anaSock.ready();
    check("bo's socket holds the campaign thread", boSock.threads().includes(thread));

    console.log("\n  presence\n");
    anaSock.presence(thread);
    check("opening Table Talk lists you to yourself", await until(() => same(anaSock.present(thread), [ana.id])), JSON.stringify(anaSock.present(thread)));
    boSock.presence(thread);
    check("and to everyone else on the thread", await until(() => same(anaSock.present(thread), [ana.id, bo.id])));
    check("names come with ids, no email", (anaSock.frames.filter((f) => f.type === "presence").at(-1)?.people ?? [])
      .every((p: any) => p.name && !String(p.name).includes("@")));
    anaSock.presence(thread, false);
    check("closing it takes you off", await until(() => same(boSock.present(thread), [bo.id])));
    anaSock.presence(thread);
    anaSock.presence("campaign:00000000-0000-4000-8000-000000000000");
    await until(() => same(boSock.present(thread), [ana.id, bo.id]));

    // Another backend task's presence arrives on the bus and expires.
    const ghost = await account("ghost");
    await member(campaignId, ghost.id);
    await bus.publishEphemeral("presence.changed", {
      task: "other-task/1", threadKey: thread, people: [{ id: ghost.id, name: "ghost" }],
      at: new Date(Date.now() - PRESENCE_TTL_MS + 1500).toISOString(),
    });
    check("another task's people show too", await until(() => same(anaSock.present(thread), [ana.id, bo.id, ghost.id])));
    await bus.publishEphemeral("presence.changed", { task: "other-task/1", threadKey: thread, people: [], at: new Date().toISOString() });
    check("and go when that task says so", await until(() => same(anaSock.present(thread), [ana.id, bo.id])));

    console.log("\n  deactivation\n");
    check("a player can't deactivate anyone", (await call("PATCH", `/api/campaign-members/${boSeat}/active`, ana, { active: false })).status === 403);
    check("a GM can't be deactivated", (await call("PATCH", `/api/campaign-members/${gmSeat}/active`, gm, { active: false })).status === 409);
    check("active must be a boolean", (await call("PATCH", `/api/campaign-members/${boSeat}/active`, gm, { active: "no" })).status === 400);
    const off = await call("PATCH", `/api/campaign-members/${boSeat}/active`, gm, { active: false });
    check("the GM deactivates a player", off.status === 200 && off.json?.member?.isActive === false && off.json?.member?.deactivatedBy === gm.id, JSON.stringify(off.json));
    check("their open socket loses the thread", await until(() => !boSock.threads().includes(thread)));
    check("and they leave Table Talk's presence", await until(() => same(anaSock.present(thread), [ana.id])));
    const boCampaigns = await call("GET", `/api/campaigns`, bo);
    check("the campaign leaves their list", Array.isArray(boCampaigns.json) && !boCampaigns.json.some((x: any) => x._id === campaignId));
    check("history is 403", (await call("GET", `/api/threads/${encodeURIComponent(thread)}/messages`, bo)).status === 403);
    check("posting is 403", (await call("POST", `/api/threads/${encodeURIComponent(thread)}/messages`, bo, { body: "hello?" })).status === 403);
    check("rejoining by link is refused", (await call("POST", `/api/campaigns/${campaignId}/join`, bo)).status === 403);
    const gmMembers = await call("GET", `/api/campaigns/${campaignId}/members`, gm);
    const anaMembers = await call("GET", `/api/campaigns/${campaignId}/members`, ana);
    check("the GM still sees them, marked inactive", gmMembers.json?.some((m: any) => m.playerId === bo.id && m.isActive === false));
    check("other players don't", !anaMembers.json?.some((m: any) => m.playerId === bo.id));
    check("their profile stops being a campaign-mate's", (await call("GET", `/api/users/players/${bo.id}`, ana)).status === 403);
    const charsAfter = await call("GET", `/api/tabletop/characters?campaign=${campaignId}`, ana);
    check("their character stays, flagged former", charsAfter.json?.find((x: any) => x.name === "Borin")?.playerActive === false);
    const attendanceAfter = await call("GET", `/api/tabletop/sessions/${sessionId}/attendance`, ana);
    check("their attendance stays, marked inactive",
      attendanceAfter.json?.people?.some((p: any) => p.playerId === bo.id && p.attended && p.active === false));
    const gmChecklist = await call("GET", `/api/tabletop/sessions/${sessionId}/attendance`, gm);
    const recordedAgain = await call("PUT", `/api/tabletop/sessions/${sessionId}/attendance`, gm, { playerIds: [ana.id, bo.id] });
    check("the GM can keep a former member who came", gmChecklist.json?.people?.some((p: any) => p.playerId === bo.id) && recordedAgain.status === 200);
    check("a GM's generic edit can't flip it back", (await call("PUT", `/api/campaign-members/${boSeat}`, gm, { isActive: true, phone: "555-0100" })).status === 200
      && (await pool.query(`SELECT is_active FROM campaign_members WHERE id = $1`, [boSeat])).rows[0].is_active === false);

    const on = await call("PATCH", `/api/campaign-members/${boSeat}/active`, gm, { active: true });
    check("reactivating brings them back", on.status === 200 && on.json?.member?.isActive === true && on.json?.member?.deactivatedAt == null);
    check("with the thread on their open socket", await until(() => boSock.threads().includes(thread)));
    check("and the campaign on their list", (await call("GET", `/api/campaigns`, bo)).json?.some((x: any) => x._id === campaignId));

    /* ------------------------------------------------------------ */
    console.log("\nPaperclip identity (#36)\n");
    const pcMember = await account("pcmember");
    const pcOther = await account("pcother");
    let members: any[] | null = [
      { principalType: "user", principalId: "pc-1", status: "active", membershipRole: "owner", user: { id: "pc-1", email: pcMember.email.toUpperCase() } },
    ];
    identity.setMemberSourceForTests(async () => members);
    const linked = await identity.resolvePaperclipIdentity(pcMember.id);
    const { rows: [stored] } = await pool.query(`SELECT paperclip_user_id, paperclip_role FROM accounts WHERE id = $1`, [pcMember.id]);
    check("an account is linked by email, case-insensitively", linked?.userId === "pc-1" && stored.paperclip_user_id === "pc-1" && stored.paperclip_role === "owner");
    check("an account with no matching member isn't", (await identity.resolvePaperclipIdentity(pcOther.id)) === null);
    const caps = await call("GET", `/api/users/me/capabilities`, pcMember);
    const capsOther = await call("GET", `/api/users/me/capabilities`, pcOther);
    check("capabilities say so, for the nav", caps.json?.paperclip === true && capsOther.json?.paperclip === false);
    await call("PUT", `/api/users/profile`, pcOther, { paperclipUserId: "pc-1-stolen", name: "Other" });
    const { rows: [self] } = await pool.query(`SELECT paperclip_user_id FROM accounts WHERE id = $1`, [pcOther.id]);
    check("nobody can link themselves through their profile", self.paperclip_user_id === null);
    members = null;
    identity.setMemberSourceForTests(async () => members);
    check("a stored link stands while Paperclip is down", (await identity.resolvePaperclipIdentity(pcMember.id))?.userId === "pc-1");
    members = [{ principalType: "user", principalId: "pc-1", status: "archived", user: { id: "pc-1", email: pcMember.email } }];
    identity.setMemberSourceForTests(async () => members);
    check("a member who left loses the link", (await identity.resolvePaperclipIdentity(pcMember.id)) === null
      && (await pool.query(`SELECT paperclip_user_id FROM accounts WHERE id = $1`, [pcMember.id])).rows[0].paperclip_user_id === null);
    await identity.setPaperclipIdentity(pcOther.id, "pc-2");
    members = [{ principalType: "user", principalId: "pc-2", status: "active", user: { id: "pc-2", email: "someone-else@example.test" } }];
    identity.setMemberSourceForTests(async () => members);
    check("an admin's hand-set link holds for a member with another email", (await identity.resolvePaperclipIdentity(pcOther.id))?.userId === "pc-2");
  } finally {
    for (const s of sockets) s.ws.close();
    await settle();
    await live.close();
    server.close();
    await cleanup().catch((err) => console.error("cleanup failed:", err));
    await bus.stop?.().catch(() => { /* in memory */ });
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
