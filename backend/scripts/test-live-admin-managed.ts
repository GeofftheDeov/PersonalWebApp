/**
 * Admins follow the campaigns under admin management (#130, spec #58).
 *
 * The rule: an admin's live channel and Letters list carry, on top of their own
 * memberships, every campaign with no owner (`owner_id` NULL means
 * admin-managed) and every campaign that admin owns. Nothing else they aren't
 * a member of.
 *
 * Real WebSocket clients against the real server wiring, as in
 * test-live-access.ts. Covers:
 *   - at connect, an admin who isn't a member gets `message.created` for an
 *     admin-managed campaign and nothing for one owned by a regular user; an
 *     admin who owns a campaign gets that one too; a regular non-member gets
 *     neither;
 *   - the thread list (GET /api/threads) follows the same rule;
 *   - ownership changes move the admins' sockets in place, with a fresh
 *     `ready` and no reconnect: a player claiming the torch takes the campaign
 *     out of admin management; the table browser setting the owner back to
 *     null brings it back; deleting the owning account (owner_id ON DELETE SET
 *     NULL) makes its campaign admin-managed.
 *
 * Run against a throwaway database loaded from db/schema.sql (it refuses to run
 * against anything but localhost). It deletes every row it creates.
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-live-admin-managed.ts
 *   (add REDIS_URL=redis://127.0.0.1:6379 EVENT_BUS_NAMESPACE=<ns> for the Redis bus)
 */
import "./use-test-jwt-secret.js";
import express from "express";
import http from "http";
import type { AddressInfo } from "net";
import WebSocket from "ws";
import pool from "../db/index.js";
import { signJwt } from "../utils/jwt.js";
import { attachLiveChannel, LIVE_PATH, PROTOCOL_VERSION } from "../live/liveChannel.js";
import { campaignThreadKey } from "../services/threads.js";

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
    [`t130-${handle}-${RUN}`, `${handle} name`, `t130.${handle}.${RUN}@example.test`, appRole]);
  created.accounts.push(rows[0].id);
  return { id: rows[0].id, email: rows[0].email };
}

/** A campaign with this owner (null: admin-managed) and these active members. */
async function campaign(title: string, owner: Person | null, members: { who: Person; status?: string }[]) {
  const { rows: [c] } = await pool.query(
    `INSERT INTO campaigns (title, status, owner_id) VALUES ($1, 'In Progress', $2) RETURNING id`,
    [`t130 ${title} ${RUN}`, owner?.id ?? null]);
  created.campaigns.push(c.id);
  for (const m of members) {
    await pool.query(`INSERT INTO campaign_members (campaign_id, person_id, status, is_active) VALUES ($1, $2, $3, true)`,
      [c.id, m.who.id, m.status ?? "Player"]);
  }
  return String(c.id);
}

async function cleanup() {
  const { accounts, campaigns } = created;
  if (!accounts.length && !campaigns.length) return;
  await pool.query(`DELETE FROM messages WHERE campaign_id = ANY($1::uuid[]) OR sender_id = ANY($2::text[])`,
    [campaigns, accounts]);
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
  const readies = () => frames.filter((f) => f.type === "ready");
  return {
    ws,
    ready: () => until(() => readies().length > 0),
    /** The threads the server's latest `ready` subscribed this socket to. */
    threads: (): string[] => readies().at(-1)?.threads ?? [],
    of: (type: string) => frames.filter((f) => f.type === type),
  };
}
type Client = ReturnType<typeof client>;

async function main() {
  const { default: campaignRoutes } = await import("../routes/campaignRoutes.js");
  const { default: threadRoutes } = await import("../routes/threadRoutes.js");
  const { default: dbRoutes } = await import("../routes/dbRoutes.js");
  const { bus, startEventBus } = await import("../events/index.js");
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use("/db", dbRoutes);
  app.use("/api/campaigns", campaignRoutes);
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

  const events: any[] = [];
  const offEvents = await bus.subscribeBroadcast("campaign.changed", (payload) => { events.push(payload); });
  const published = (match: (p: any) => boolean) => until(() => events.some(match));

  const call = (method: string, path: string, who: Person, body?: unknown) => fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${tokenFor(who)}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sendTo = (thread: string, who: Person, body: string) =>
    call("POST", `/api/threads/${encodeURIComponent(thread)}/messages`, who, { body });
  const listOf = async (who: Person) =>
    ((await (await call("GET", "/api/threads?filter=campaigns", who)).json()) as any).threads?.map((t: any) => t.threadKey) ?? [];
  const opened: Client[] = [];
  const open = (who: Person) => { const c = client(wsUrl, who); opened.push(c); return c; };
  const got = (c: Client, thread: string, body: string) =>
    c.of("message.created").some((f) => f.thread === thread && f.message?.body === body);

  try {
    const admin = await account("admin", "admin");     // a member of nothing
    const ownerAdmin = await account("owneradmin", "admin"); // owns a campaign it isn't in
    const player = await account("player");            // in every campaign
    const owner = await account("owner");              // a regular user who owns one
    const outsider = await account("outsider");

    const managed = campaignThreadKey(await campaign("managed", null, [{ who: player }]));
    const userOwnedId = await campaign("user-owned", owner, [{ who: owner, status: "Game Master" }, { who: player }]);
    const userOwned = campaignThreadKey(userOwnedId);
    const adminOwned = campaignThreadKey(await campaign("admin-owned", ownerAdmin, [{ who: player }]));
    const managedId = managed.slice("campaign:".length);

    const sockets = { admin: open(admin), ownerAdmin: open(ownerAdmin), player: open(player), outsider: open(outsider) };
    await Promise.all(Object.values(sockets).map((c) => c.ready()));
    const upgradesAtStart = upgrades;

    console.log("\nAt connect\n");

    check("an admin who isn't a member subscribes to the admin-managed campaign",
      sockets.admin.threads().includes(managed), JSON.stringify(sockets.admin.threads()));
    check("...but not to campaigns other people own",
      !sockets.admin.threads().includes(userOwned) && !sockets.admin.threads().includes(adminOwned));
    check("an admin who owns a campaign it isn't in subscribes to it, and to the admin-managed one",
      sockets.ownerAdmin.threads().includes(adminOwned) && sockets.ownerAdmin.threads().includes(managed)
        && !sockets.ownerAdmin.threads().includes(userOwned), JSON.stringify(sockets.ownerAdmin.threads()));
    check("a regular non-member subscribes to none of them", sockets.outsider.threads().length === 0,
      JSON.stringify(sockets.outsider.threads()));

    const one = `one ${RUN}`, two = `two ${RUN}`, three = `three ${RUN}`;
    check("the player writes in all three", (await sendTo(managed, player, one)).status === 201
      && (await sendTo(userOwned, player, two)).status === 201 && (await sendTo(adminOwned, player, three)).status === 201);
    check("the admin gets the admin-managed campaign's message", await until(() => got(sockets.admin, managed, one)),
      JSON.stringify(sockets.admin.of("message.created")));
    check("the owning admin gets its own campaign's message", await until(() => got(sockets.ownerAdmin, adminOwned, three)));
    await sleep(300);
    check("the admin gets nothing for the user-owned or the other admin's campaign",
      !got(sockets.admin, userOwned, two) && !got(sockets.admin, adminOwned, three));
    check("the outsider gets none of it", sockets.outsider.of("message.created").length === 0);

    console.log("\nThe thread list\n");

    const adminList = await listOf(admin);
    check("the admin's list has the admin-managed campaign and nothing else it isn't in",
      adminList.includes(managed) && !adminList.includes(userOwned) && !adminList.includes(adminOwned), JSON.stringify(adminList));
    const outsiderList = await listOf(outsider);
    check("the outsider's list has none of them", outsiderList.length === 0, JSON.stringify(outsiderList));

    console.log("\nOwnership changes while connected\n");

    const claimRes = await call("POST", `/api/campaigns/${managedId}/torch/claim`, player);
    check("the player claims the admin-managed campaign's torch", claimRes.ok, `status ${claimRes.status}`);
    check("claiming publishes campaign.changed (owner-changed) naming the new owner",
      await published((p) => p.campaignId === managedId && p.action === "owner-changed" && p.personId === player.id),
      JSON.stringify(events));
    check("both admins' sockets get a fresh `ready` without it",
      await until(() => !sockets.admin.threads().includes(managed) && !sockets.ownerAdmin.threads().includes(managed)),
      JSON.stringify(sockets.admin.of("ready")));
    check("the owning admin keeps its own campaign", sockets.ownerAdmin.threads().includes(adminOwned));
    check("the player keeps it", sockets.player.threads().includes(managed));
    const four = `four ${RUN}`;
    check("a message after the claim reaches the player", (await sendTo(managed, player, four)).status === 201
      && await until(() => got(sockets.player, managed, four)));
    await sleep(300);
    check("...and not the admins", !got(sockets.admin, managed, four) && !got(sockets.ownerAdmin, managed, four));
    check("nor is it on the admin's list now", !(await listOf(admin)).includes(managed));

    const nulled = await fetch(`${base}/db/campaigns/update/${managedId}?token=${encodeURIComponent(tokenFor(admin))}`, {
      method: "POST", redirect: "manual",
      headers: { authorization: `Bearer ${tokenFor(admin)}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ json: JSON.stringify({ owner: null }) }).toString(),
    });
    check("an admin clears the owner in the table browser", nulled.status === 302, `status ${nulled.status}`);
    check("that publishes campaign.changed (owner-changed) with no owner",
      await published((p) => p.campaignId === managedId && p.action === "owner-changed" && !p.personId), JSON.stringify(events));
    check("both admins' sockets get it back", await until(() =>
      sockets.admin.threads().includes(managed) && sockets.ownerAdmin.threads().includes(managed)));

    const delOwner = await fetch(`${base}/db/accounts/delete/${owner.id}?token=${encodeURIComponent(tokenFor(admin))}`, {
      method: "POST", headers: { authorization: `Bearer ${tokenFor(admin)}` },
    });
    check("an admin deletes the owning user's account in the table browser", delOwner.ok, `status ${delOwner.status}`);
    check("its campaign becoming admin-managed publishes campaign.changed (owner-changed)",
      await published((p) => p.campaignId === userOwnedId && p.action === "owner-changed" && !p.personId), JSON.stringify(events));
    check("the admin's socket picks the campaign up", await until(() => sockets.admin.threads().includes(userOwned)),
      JSON.stringify(sockets.admin.of("ready")));
    const five = `five ${RUN}`;
    check("and gets its next message", (await sendTo(userOwned, player, five)).status === 201
      && await until(() => got(sockets.admin, userOwned, five)));
    check("the outsider still has nothing", sockets.outsider.threads().length === 0
      && sockets.outsider.of("message.created").length === 0);

    check("...all without reconnecting", upgrades === upgradesAtStart
      && opened.every((c) => c.ws.readyState === WebSocket.OPEN), `${upgrades - upgradesAtStart} upgrades`);
  } finally {
    offEvents();
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
