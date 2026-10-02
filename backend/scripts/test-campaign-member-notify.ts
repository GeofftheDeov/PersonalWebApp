/**
 * Regression test for GitHub #108 — campaign members synced from Salesforce
 * show as "Unknown Player" and miss Table Talk / ready-check bells.
 *
 * Phase 3 (#35) made campaign_members.person_id the one way a membership points
 * at a person. Salesforce-synced member rows carry nothing else: no name, no
 * email. On prod that was 26 of 28 rows. Notification recipients were still
 * found by the row's email, so every one of those members was skipped.
 *
 * Mounts the real routers the way server.ts does and drives them over HTTP;
 * each member reads their own bell through /api/notifications.
 *
 * Run against a throwaway database loaded from db/schema.sql (it refuses to run
 * against anything but localhost):
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-campaign-member-notify.ts
 */
import express from "express";
import type { AddressInfo } from "net";
import jwt from "jsonwebtoken";
import pool from "../db/index.js";
import campaignRoutes from "../routes/campaignRoutes.js";
import messageRoutes from "../routes/messageRoutes.js";
import notificationRoutes from "../routes/notificationRoutes.js";
import { runReadyCheckSweep } from "../utils/readyCheck.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
  process.exit(2);
}

const SECRET = process.env.JWT_SECRET || "your-secret-key-change-this";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? pass++ : fail++;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/campaigns", campaignRoutes);
  app.use("/api/messages", messageRoutes);
  app.use("/api/notifications", notificationRoutes);
  return app;
}

/** Keeps reruns against the same database clear of the unique email index. */
const RUN = Math.random().toString(36).slice(2, 8);

/** An accounts row; ids carry no database default, so mint one here. */
async function account(handle: string, extra: Record<string, string> = {}) {
  const cols = ["id", "handle", "email", ...Object.keys(extra)];
  const vals = [handle, `${handle}.${RUN}@example.test`, ...Object.values(extra)];
  const { rows } = await pool.query(
    `INSERT INTO accounts (${cols.join(", ")})
     VALUES (gen_random_uuid(), ${vals.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id, email`, vals);
  return { id: rows[0].id as string, email: rows[0].email as string };
}

/** A member row the way the Salesforce sync writes it: person_id and nothing else. */
async function syncedMember(campaignId: string, personId: string, status = "Active") {
  await pool.query(
    `INSERT INTO campaign_members (campaign_id, person_id, status) VALUES ($1, $2, $3)`,
    [campaignId, personId, status]);
}

async function main() {
  const server = buildApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const tokenFor = (p: { id: string; email: string }) => jwt.sign({ id: p.id, email: p.email }, SECRET);
  const call = async (method: string, path: string, who: { id: string; email: string }, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${tokenFor(who)}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) as any };
  };
  const bell = async (who: { id: string; email: string }) =>
    ((await call("GET", "/api/notifications?limit=100", who)).json?.notifications ?? []) as any[];

  /** Bell entries matching `pred`, waiting briefly — Table Talk notifies off the request path. */
  const waitForBell = async (who: { id: string; email: string }, pred: (n: any) => boolean) => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const hits = (await bell(who)).filter(pred);
      if (hits.length || Date.now() > deadline) return hits;
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  try {
    const { rows: [campaign] } = await pool.query(
      `INSERT INTO campaigns (title) VALUES ('Curse of the Unknown Player') RETURNING id`);
    const campaignId: string = campaign.id;

    // The Game Master joined through the app, so their row carries a copy of
    // their name and email. Everyone else came over from Salesforce.
    const gm = await account("gm", { name: "Game Master" });
    await pool.query(
      `INSERT INTO campaign_members (campaign_id, person_id, email, first_name, last_name, status)
       VALUES ($1, $2, $3, 'Game', 'Master', 'Game Master')`, [campaignId, gm.id, gm.email]);

    const synced = await account("synced");
    await syncedMember(campaignId, synced.id);

    // A Phase 2 merge can leave one person with two member rows in a campaign.
    const twice = await account("twice");
    await syncedMember(campaignId, twice.id, "Active");
    await syncedMember(campaignId, twice.id, "Inactive");

    const outsider = await account("outsider");

    console.log("\n#108 — Table Talk bell\n");

    const sent = await call("POST", `/api/messages/campaign/${campaignId}`, gm, { body: "Roll for initiative" });
    check("the GM can post to Table Talk", sent.status === 201, `got ${sent.status} ${JSON.stringify(sent.json)}`);

    const isTableTalk = (n: any) => n.type === "message" && n.link === `/game-night/campaigns/${campaignId}`;

    const syncedBell = await waitForBell(synced, isTableTalk);
    check("a member whose row has no name or email gets the Table Talk bell", syncedBell.length === 1,
      `got ${JSON.stringify(syncedBell)}`);

    const twiceBell = await waitForBell(twice, isTableTalk);
    check("a person with two member rows gets one bell entry, counted once",
      twiceBell.length === 1 && twiceBell[0].count === 1, `got ${JSON.stringify(twiceBell)}`);

    check("the sender is not notified of their own message", !(await bell(gm)).some(isTableTalk));
    check("someone outside the campaign is not notified", !(await bell(outsider)).some(isTableTalk));

    console.log("\n#108 — ready-check bell\n");

    const { rows: [session] } = await pool.query(
      `INSERT INTO game_sessions (title, campaign_id, date) VALUES ('Session Zero', $1, $2) RETURNING id`,
      [campaignId, new Date(Date.now() + 10 * 60 * 1000)]);
    await runReadyCheckSweep();

    const isReadyCheck = (n: any) => n.type === "system" && n.link === `/game-night/sessions/${session.id}`;

    const syncedReady = (await bell(synced)).filter(isReadyCheck);
    check("a member whose row has no name or email gets the ready-check bell", syncedReady.length === 1,
      `got ${JSON.stringify(syncedReady)}`);

    const twiceReady = (await bell(twice)).filter(isReadyCheck);
    check("a person with two member rows gets one ready-check entry, counted once",
      twiceReady.length === 1 && twiceReady[0].count === 1, `got ${JSON.stringify(twiceReady)}`);

    check("the Game Master gets the ready check too", (await bell(gm)).some(isReadyCheck));
    check("someone outside the campaign does not", !(await bell(outsider)).some(isReadyCheck));

    console.log("\n#108 — the Players list\n");

    // The campaign and session pages name members from `person` now, so what
    // the endpoint puts there is load-bearing — and it is every member's view
    // of every other member.
    await pool.query(
      `UPDATE accounts SET password = 'bcrypt-hash', reset_password_token = 'reset-secret',
              email_verification_token = 'verify-secret' WHERE id = $1`, [synced.id]);
    const roster = await call("GET", `/api/campaigns/${campaignId}/members`, gm);
    const syncedRow = (roster.json ?? []).find((m: any) => m.playerId === synced.id);
    check("a synced member's entry carries their handle on `person`", syncedRow?.person?.handle === "synced",
      `got ${JSON.stringify(syncedRow)}`);

    const leaked = (roster.json ?? []).flatMap((m: any) =>
      ["password", "resetPasswordToken", "emailVerificationToken", "resetPasswordExpires"]
        .filter((k) => m.person && k in m.person));
    check("no member's `person` carries a password hash or token", leaked.length === 0,
      `leaked: ${[...new Set(leaked)].join(", ")}`);
  } finally {
    server.close();
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
