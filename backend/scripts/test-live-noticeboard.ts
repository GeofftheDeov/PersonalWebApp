/**
 * The live Notice Board (#57): `noticeboard.changed` on the live channel.
 *
 * Real WebSocket clients against the real wiring: the planning router (with
 * the integrations fake installed) and the live channel on one HTTP server,
 * and the process's own event bus (in memory when REDIS_URL is unset, Redis
 * Streams + Pub/Sub when it is set). Covers:
 *   - kicking off, shortlisting and voting each reach every party member's
 *     socket as `noticeboard.changed` on the campaign's thread, the actor's
 *     own included, with no planning content in the frame;
 *   - someone outside the party, and a member of another campaign, get none;
 *   - quests, the torch and campaign changes (the other events the board
 *     shows) send it too, and a deleted campaign doesn't;
 *   - the shared realtime client hands the frame to the thread's
 *     `onNoticeBoard`, which the board's hook refetches on.
 *
 * Run against a throwaway database loaded from db/schema.sql (it refuses to run
 * against anything but localhost). It deletes every row it creates.
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-live-noticeboard.ts
 *   (add REDIS_URL=redis://127.0.0.1:6379 EVENT_BUS_NAMESPACE=<ns> for the Redis bus)
 */
import "./use-test-jwt-secret.js";
import express from "express";
import http from "http";
import type { AddressInfo } from "net";
import WebSocket from "ws";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
  process.exit(2);
}

const { default: pool } = await import("../db/index.js");
const { bus, startEventBus, stopEventBus } = await import("../events/index.js");
const { signJwt } = await import("../utils/jwt.js");
const { attachLiveChannel, LIVE_PATH, PROTOCOL_VERSION } = await import("../live/liveChannel.js");
const { campaignThreadKey } = await import("../services/threads.js");
const { buildPlanningRouter } = await import("../routes/planningRoutes.js");
const { createPlanner } = await import("../planning/planner.js");
const { createFakeIntegrations } = await import("../testing/fakeIntegrations.js");

/** The frontend's realtime client, loaded by path at run time (see test-live-channel.ts). */
type LiveClientLike = {
  status: string;
  subscribe(thread: string, handlers: { onNoticeBoard?: (thread: string) => void }): () => void;
  close(): void;
};
type LiveClientCtor = new (opts: { url: string; getToken: () => string | null; WebSocket: unknown }) => LiveClientLike;
const LIVE_CLIENT = new URL("../../frontend/src/lib/realtime/liveClient.ts", import.meta.url).href;

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
const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;

type Person = { id: string; email: string };
const created = { accounts: [] as string[], campaigns: [] as string[] };

async function account(handle: string): Promise<Person> {
  const { rows } = await pool.query(
    `INSERT INTO accounts (id, handle, name, email) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id, email`,
    [`t57live-${handle}-${RUN}`, `${handle} name`, `t57live.${handle}.${RUN}@example.test`]);
  created.accounts.push(rows[0].id);
  return { id: rows[0].id, email: rows[0].email };
}

async function campaign(title: string, owner: Person): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO campaigns (title, status, owner_id, quorum) VALUES ($1, 'In Progress', $2, 2) RETURNING id`,
    [`t57live ${title} ${RUN}`, owner.id]);
  created.campaigns.push(rows[0].id);
  return rows[0].id;
}

async function member(campaignId: string, person: Person, status: "Game Master" | "Player") {
  await pool.query(`INSERT INTO campaign_members (campaign_id, person_id, status) VALUES ($1, $2, $3)`,
    [campaignId, person.id, status]);
}

async function cleanup() {
  const { accounts, campaigns } = created;
  if (!accounts.length && !campaigns.length) return;
  await pool.query(`DELETE FROM messages WHERE campaign_id = ANY($1::uuid[])`, [campaigns]);
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
    boards: (thread?: string) => frames.filter((f) => f.type === "noticeboard.changed" && (!thread || f.thread === thread)),
  };
}

async function main() {
  const fake = createFakeIntegrations();
  const uninstall = fake.install();

  const app = express();
  app.use(express.json());
  app.use("/api/planning", buildPlanningRouter(createPlanner()));
  const server = http.createServer(app);
  const live = await attachLiveChannel(server);
  await startEventBus();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}${LIVE_PATH}`;
  console.log(`\n  bus: ${process.env.REDIS_URL ? `redis (namespace ${process.env.EVENT_BUS_NAMESPACE || "none"})` : "in memory"}`);

  const post = async (path: string, who: Person, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenFor(who)}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
  const opened: ReturnType<typeof client>[] = [];
  const open = (who: Person) => { const c = client(wsUrl, who); opened.push(c); return c; };
  let liveClient: LiveClientLike | null = null;

  try {
    const gm = await account("gm");
    const player = await account("player");
    const outsider = await account("outsider");
    const elsewhere = await account("elsewhere");
    const table = await campaign("Ashen Crown", gm);
    await member(table, gm, "Game Master");
    await member(table, player, "Player");
    const otherTable = await campaign("Other table", elsewhere);
    await member(otherTable, elsewhere, "Game Master");
    const thread = campaignThreadKey(table);

    const gmSocket = open(gm);
    const playerSocket = open(player);
    const playerPhone = open(player);
    const outsiderSocket = open(outsider);
    const elsewhereSocket = open(elsewhere);
    await Promise.all(opened.map((c) => c.ready()));
    const party = [gmSocket, playerSocket, playerPhone];
    const counts = () => opened.map((c) => c.boards().length).join(",");

    console.log("\nnoticeboard.changed: planning reaches the party live\n");

    const kickoff = await post(`/api/planning/campaigns/${table}/kickoff`, gm, { title: `Session ${RUN}`, isOnline: true });
    const sid = kickoff.session.id as string;
    check("kicking off reaches every party socket, the GM's own included",
      await until(() => party.every((c) => c.boards(thread).length >= 1)), counts());
    check("...as a frame on the campaign's thread that carries nothing else",
      party.every((c) => c.boards().every((f) => f.thread === thread && Object.keys(f).sort().join() === "thread,type")),
      JSON.stringify(gmSocket.boards()));

    const t0 = Math.ceil((Date.now() + 7 * DAY) / HOUR) * HOUR;
    const A = { start: new Date(t0).toISOString(), end: new Date(t0 + 4 * HOUR).toISOString() };
    const B = { start: new Date(t0 + DAY).toISOString(), end: new Date(t0 + DAY + 4 * HOUR).toISOString() };
    let before = playerSocket.boards().length;
    const shortlisted = await post(`/api/planning/sessions/${sid}/shortlist`, gm, { options: [A, B] });
    check("the GM shortlisting nights reaches the player",
      await until(() => playerSocket.boards().length > before), counts());

    before = gmSocket.boards().length;
    const optionA = shortlisted.night.options.find((o: any) => o.start === A.start).id;
    await post(`/api/planning/sessions/${sid}/vote`, player, { optionIds: [optionA] });
    check("the player's vote reaches the GM", await until(() => gmSocket.boards().length > before), counts());
    check("...and the voter's other device", await until(() => playerPhone.boards().length > before), counts());

    await sleep(300);
    check("nobody outside the party gets any of it: not someone with no campaign, not another campaign's GM",
      outsiderSocket.boards().length === 0 && elsewhereSocket.boards().length === 0, counts());

    console.log("\nnoticeboard.changed: the other things the board shows\n");

    const lastCounts = () => party.map((c) => c.boards().length);
    let mark = lastCounts();
    const grew = () => until(() => lastCounts().every((n, i) => n > mark[i]));

    await bus.publish("quest.assigned", {
      questId: "00000000-0000-4000-8000-000000000001", sessionId: sid, campaignId: table, kind: "custom",
      assigneeId: player.id, previousAssigneeId: null, assignedBy: gm.id,
    });
    check("a quest assigned", await grew(), counts());
    mark = lastCounts();
    await bus.publish("quest.completed", {
      questId: "00000000-0000-4000-8000-000000000001", sessionId: sid, campaignId: table, assigneeId: player.id, completedBy: player.id,
    });
    check("a quest done", await grew(), counts());
    mark = lastCounts();
    await bus.publish("campaign.torch_passed", {
      campaignId: table, scope: "session", sessionId: sid, byId: gm.id, fromId: null, toId: player.id,
    });
    check("the torch passed", await grew(), counts());
    mark = lastCounts();
    await bus.publish("campaign.changed", { campaignId: table, action: "updated" });
    check("the campaign's details (its GM title) changed", await grew(), counts());

    console.log("\nthe realtime client\n");

    const { LiveClient } = await import(LIVE_CLIENT) as { LiveClient: LiveClientCtor };
    liveClient = new LiveClient({ url: wsUrl, getToken: () => tokenFor(player), WebSocket });
    const heard: string[] = [];
    liveClient.subscribe(thread, { onNoticeBoard: (t) => heard.push(t) });
    await until(() => liveClient!.status === "open");
    await post(`/api/planning/sessions/${sid}/vote`, gm, { optionIds: [optionA] });
    check("LiveClient hands noticeboard.changed to the thread's onNoticeBoard",
      await until(() => heard.length > 0 && heard.every((t) => t === thread)), JSON.stringify(heard));

    console.log("\nnot after the campaign is gone\n");

    await sleep(300);
    mark = lastCounts();
    await bus.publish("campaign.changed", { campaignId: table, action: "deleted" });
    await sleep(500);
    check("a deleted campaign sends no noticeboard.changed",
      lastCounts().every((n, i) => n === mark[i]), `${mark} → ${lastCounts()}`);
  } finally {
    liveClient?.close();
    for (const c of opened) c.ws.close();
    await live.close();
    await new Promise<void>((r) => server.close(() => r()));
    await cleanup().catch((err) => console.error("cleanup failed:", err.message));
    uninstall();
    await stopEventBus();
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
