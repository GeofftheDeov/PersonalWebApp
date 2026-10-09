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
 *   - a typing frame for a thread the sender can't see is dropped, and a
 *     burst of frames from one socket reaches the thread once;
 *   - typing leaves no database rows and, on Redis, no stream entries;
 *   - the frontend's LiveClient and TypingTracker (frontend/src/lib/realtime/
 *     typing.ts), on an injected clock: holding a key down sends one frame
 *     every 3 s; the indicator clears 5 s after the last frame, a refresh
 *     extends it, and the typist's message clears it at once; the same in a
 *     campaign thread (Table Talk) and a friend DM (the dock).
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
import { attachLiveChannel, LIVE_PATH, PROTOCOL_VERSION, TYPING_MIN_INTERVAL_MS } from "../live/liveChannel.js";
import { campaignThreadKey, dmThreadKey } from "../services/threads.js";

/** Past the server's per-socket typing guard, which runs on real time. */
const PAST_GUARD = TYPING_MIN_INTERVAL_MS + 150;

/**
 * The frontend's realtime client and typing tracker, loaded by path at run
 * time (the backend's Docker build sees only backend/; see test-live-channel.ts).
 */
type LiveClientLike = {
  status: string;
  threadStatus(thread: string): string;
  close(): void;
};
type LiveClientCtor = new (opts: { url: string; getToken: () => string | null; WebSocket: unknown }) => LiveClientLike;
type Typist = { personId: string; name: string };
type TrackerLike = {
  readonly typists: Typist[];
  onChange(listener: (typists: Typist[]) => void): () => void;
  typing(): void;
  sent(): void;
  dispose(): void;
};
type TypingModule = {
  TypingTracker: new (opts: { client: LiveClientLike; thread: string; clock?: Clock }) => TrackerLike;
  typingLabel(typists: Typist[]): string;
  TYPING_THROTTLE_MS: number;
  TYPING_EXPIRY_MS: number;
};
const LIVE_CLIENT = new URL("../../frontend/src/lib/realtime/liveClient.ts", import.meta.url).href;
const TYPING = new URL("../../frontend/src/lib/realtime/typing.ts", import.meta.url).href;

/** An injected clock: time only moves when the test says so. */
type Clock = { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => { timers.set(++nextId, { at: now + ms, fn }); return nextId; },
    clearTimeout: (handle: unknown) => { timers.delete(handle as number); },
    pending: () => timers.size,
    /** Move time forward, firing due timers in order. */
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

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

async function account(name: string, appRole: "user" | "admin" = "user"): Promise<Person> {
  const handle = `t103-${name}-${RUN}`;
  const { rows } = await pool.query(
    `INSERT INTO accounts (id, handle, name, email, app_role) VALUES (gen_random_uuid(), $1, $2, $3, $4)
     RETURNING id, email`,
    [handle, `${name} name`, `t103.${name}.${RUN}@example.test`, appRole]);
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
      const [next, keys] = await redis.scan(cursor, "COUNT", 500, "TYPE", "stream");
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
    const admin = await account("admin", "admin");
    const leaver = await account("leaver");
    const table = await campaign("Curse of Strahd");
    for (const p of [alice, bob, mara, leaver]) await member(table, p);
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
    // (Sockets opened after the friendship: befriend() writes SQL directly and
    // publishes no friendship event, so earlier sockets wouldn't follow it.)
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

    // An admin may read any campaign's history, but a socket only types in the
    // threads its `ready` subscribed it to (which also bounds the work an
    // arbitrary thread key can cost the server).
    const adminSocket = open(admin);
    await adminSocket.ready();
    const beforeAdmin = typingIn(bobSocket, tableThread).length;
    adminSocket.typing(tableThread);
    await sleep(500);
    check("an admin who isn't a member: typing in that campaign reaches nobody",
      typingIn(bobSocket, tableThread).length === beforeAdmin,
      `${typingIn(bobSocket, tableThread).length - beforeAdmin} delivered`);

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

    // Everything up to here was typing (and opening sockets); messages come later.
    const rowsAfter = await rowCounts();
    const changed = Object.keys({ ...rowsBefore, ...rowsAfter }).filter((t) => rowsBefore[t] !== rowsAfter[t]);
    check("all that typing left no database rows: every table's row count is unchanged", changed.length === 0,
      changed.map((t) => `${t}: ${rowsBefore[t]} -> ${rowsAfter[t]}`).join(", "));

    console.log("\nAccess that ended since the socket connected\n");

    // The row is deleted behind the routes' back, so no access event is
    // published and the leaver's socket still lists the campaign; the access
    // check at typing time is what stops this. (With the event, #105 drops the
    // subscription itself: test-live-access.ts.)
    const leaverSocket = open(leaver);
    await leaverSocket.ready();
    check("the leaver's socket was subscribed to Table Talk", leaverSocket.of("ready")[0]?.threads?.includes(tableThread));
    await pool.query(`DELETE FROM campaign_members WHERE campaign_id = $1 AND person_id = $2`, [table, leaver.id]);
    const beforeLeft = typingIn(bobSocket, tableThread).length;
    leaverSocket.typing(tableThread);
    await sleep(500);
    check("after leaving the campaign, their typing there reaches nobody",
      typingIn(bobSocket, tableThread).length === beforeLeft,
      `${typingIn(bobSocket, tableThread).length - beforeLeft} delivered`);

    console.log("\nThe client: throttling, expiry, clearing\n");

    const { LiveClient } = await import(LIVE_CLIENT) as { LiveClient: LiveClientCtor };
    const { TypingTracker, typingLabel, TYPING_THROTTLE_MS, TYPING_EXPIRY_MS } =
      await import(TYPING) as TypingModule;
    check("the client's constants match the spec: refresh every 3 s, expire after 5 s",
      TYPING_THROTTLE_MS === 3_000 && TYPING_EXPIRY_MS === 5_000, `${TYPING_THROTTLE_MS} ${TYPING_EXPIRY_MS}`);

    /** Counts the typing frames a client actually puts on the wire. */
    const wire: Record<string, number> = {};
    const countingSocket = (who: string) => class extends WebSocket {
      send(data: any, ...rest: any[]) {
        try { if (JSON.parse(String(data)).type === "typing") wire[who] = (wire[who] ?? 0) + 1; } catch { /* not JSON */ }
        return (super.send as any)(data, ...rest);
      }
    };
    const aliceClock = fakeClock();
    const bobClock = fakeClock();
    const aliceClient = new LiveClient({ url: wsUrl, getToken: () => tokenFor(alice), WebSocket: countingSocket("alice") });
    const bobClient = new LiveClient({ url: wsUrl, getToken: () => tokenFor(bob), WebSocket: countingSocket("bob") });
    const aliceTable = new TypingTracker({ client: aliceClient, thread: tableThread, clock: aliceClock });
    const bobTable = new TypingTracker({ client: bobClient, thread: tableThread, clock: bobClock });
    const bobChanges: string[][] = [];
    bobTable.onChange((t) => bobChanges.push(t.map((p) => p.name)));
    check("both clients connect", await until(() => aliceClient.status === "open" && bobClient.status === "open"),
      `${aliceClient.status} ${bobClient.status}`);

    // Key repeat: a keystroke every 50 ms for 7 seconds of (fake) time.
    for (let t = 0; t <= 7_000; t += 50) { aliceTable.typing(); aliceClock.advance(50); }
    check("holding a key down for 7 s sends 3 typing frames (at 0, 3 and 6 s), not one per keystroke",
      wire.alice === 3, `${wire.alice} frames`);
    check("bob's indicator shows alice", await until(() => bobTable.typists.some((p) => p.personId === alice.id)),
      JSON.stringify(bobTable.typists));
    check("...by display name: \"<name> is writing…\"", typingLabel(bobTable.typists) === `${alice.handle} is writing…`,
      typingLabel(bobTable.typists));
    check("alice's own indicator stays empty", aliceTable.typists.length === 0, JSON.stringify(aliceTable.typists));
    check("bob's tracker announced the change", bobChanges.at(-1)?.[0] === alice.handle, JSON.stringify(bobChanges));

    bobClock.advance(4_999);
    check("it is still showing 4.999 s after the last frame", bobTable.typists.length === 1,
      JSON.stringify(bobTable.typists));
    bobClock.advance(1);
    check("it clears 5 s after the last frame, on its own", bobTable.typists.length === 0,
      JSON.stringify(bobTable.typists));
    check("...and announces that", bobChanges.at(-1)?.length === 0, JSON.stringify(bobChanges));

    // A refresh pushes the expiry out: frames at 0 and 3 s keep it up until 8 s.
    await sleep(PAST_GUARD);
    aliceClock.advance(3_000);
    aliceTable.typing();
    check("a new frame shows alice again", await until(() => bobTable.typists.length === 1));
    bobClock.advance(3_000);
    await sleep(PAST_GUARD);
    aliceClock.advance(3_000);
    const bobChangesBefore = bobChanges.length;
    aliceTable.typing();
    await until(() => false, 300); // let the refresh arrive (it changes nothing visible)
    check("a refresh doesn't flicker the indicator", bobChanges.length === bobChangesBefore, JSON.stringify(bobChanges));
    bobClock.advance(4_000);
    check("a refresh 3 s in keeps it showing 7 s after the first frame", bobTable.typists.length === 1);
    bobClock.advance(1_000);
    check("...and it clears 5 s after the refresh", bobTable.typists.length === 0);

    // Alice's message clears her indicator at once, without waiting out the 5 s.
    await sleep(PAST_GUARD);
    aliceClock.advance(3_000);
    aliceTable.typing();
    check("alice is writing again", await until(() => bobTable.typists.length === 1));
    const posted = await fetch(`http://127.0.0.1:${port}/api/messages/campaign/${table}`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenFor(alice)}`, "content-type": "application/json" },
      body: JSON.stringify({ body: `there ${RUN}` }),
    });
    check("alice's message is saved", posted.status === 201, `status ${posted.status}`);
    check("her message arriving clears her indicator immediately (no clock advanced)",
      await until(() => bobTable.typists.length === 0), JSON.stringify(bobTable.typists));

    // Sending ends the typing burst: the next keystroke announces at once.
    const sentBefore = wire.alice;
    aliceTable.typing(); // within 3 s of the last frame: throttled
    aliceTable.sent();
    await sleep(400); // a quick typist starting the next message
    aliceTable.typing();
    check("after sending, the next keystroke sends a frame without waiting out the 3 s",
      wire.alice === sentBefore + 1, `${wire.alice - sentBefore} frames`);
    check("...and the server lets it through, so bob sees alice writing again",
      await until(() => bobTable.typists.length === 1, 1_500), JSON.stringify(bobTable.typists));
    bobClock.advance(5_000);
    check("...until it expires like any other", bobTable.typists.length === 0, JSON.stringify(bobTable.typists));

    console.log("\nThe client in a dock DM\n");

    // Fresh sockets: these clients' DM subscriptions date from after the friendship.
    const aliceDmClock = fakeClock();
    const bobDmClock = fakeClock();
    const aliceDmTyping = new TypingTracker({ client: aliceClient, thread: dmThread, clock: aliceDmClock });
    const bobDmTyping = new TypingTracker({ client: bobClient, thread: dmThread, clock: bobDmClock });
    check("both clients carry the DM thread",
      await until(() => aliceClient.threadStatus(dmThread) === "open" && bobClient.threadStatus(dmThread) === "open"),
      `${aliceClient.threadStatus(dmThread)} ${bobClient.threadStatus(dmThread)}`);
    await sleep(PAST_GUARD);
    bobDmTyping.typing();
    check("bob typing in the DM shows on alice's side",
      await until(() => aliceDmTyping.typists.some((p) => p.personId === bob.id)), JSON.stringify(aliceDmTyping.typists));
    check("...and not in alice's Table Talk indicator", aliceTable.typists.length === 0 && bobTable.typists.length === 0);
    aliceDmClock.advance(5_000);
    check("it expires after 5 s in the DM too", aliceDmTyping.typists.length === 0);
    await sleep(PAST_GUARD);
    bobDmClock.advance(3_000);
    bobDmTyping.typing();
    await until(() => aliceDmTyping.typists.length === 1);
    const dm = await fetch(`http://127.0.0.1:${port}/api/messages/dm/${alice.id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenFor(bob)}`, "content-type": "application/json" },
      body: JSON.stringify({ body: `dm ${RUN}` }),
    });
    check("bob's DM is saved", dm.status === 201, `status ${dm.status}`);
    check("bob's DM arriving clears his indicator immediately", await until(() => aliceDmTyping.typists.length === 0),
      JSON.stringify(aliceDmTyping.typists));

    for (const t of [aliceTable, bobTable, aliceDmTyping, bobDmTyping]) t.dispose();
    check("disposing a tracker cancels its expiry timers", [aliceClock, bobClock, aliceDmClock, bobDmClock]
      .every((c) => c.pending() === 0), [aliceClock, bobClock, aliceDmClock, bobDmClock].map((c) => c.pending()).join(","));
    aliceClient.close();
    bobClient.close();

    check("labels: nobody, one, two, several",
      typingLabel([]) === ""
        && typingLabel([{ personId: "1", name: "Theo" }]) === "Theo is writing…"
        && typingLabel([{ personId: "1", name: "Theo" }, { personId: "2", name: "Mara" }]) === "Theo and Mara are writing…"
        && typingLabel([{ personId: "1", name: "Theo" }, { personId: "2", name: "Mara" }, { personId: "3", name: "Ash" }])
          === "Several people are writing…");

    if (process.env.REDIS_URL) {
      console.log("\nTyping is ephemeral on Redis\n");

      const streams = await streamEntries();
      // Alice's real message went through the stream, so the scan is looking in the right place.
      // Other runs' namespaces can leave their own gamenight streams, so look in all of them.
      const gamenight = Object.entries(streams).filter(([key]) => key.endsWith("events:gamenight"));
      check("alice's real message is in the Redis stream history (so the scan sees streams)",
        gamenight.some(([, entries]) => entries.some((e) => e.includes(`there ${RUN}`))), Object.keys(streams).join(", "));
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
