/**
 * Regression test for GitHub #41 — "" reaching a timestamptz column.
 *
 * Reproduces the reported 500 (create a record with every optional date left
 * blank, the way an untouched HTML form submits it) against a throwaway
 * Postgres built from db/schema.sql, on every table the issue lists.
 *
 * Run:  DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-date-coercion.ts
 *
 * Before the fix, every case below fails with:
 *   invalid input syntax for type timestamp with time zone: ""
 */
import pool from "../db/index.js";
import Campaign from "../models/Campaign.js";
import Task from "../models/Task.js";
import Session from "../models/Session.js";
import Event from "../models/Event.js";
import Opportunity from "../models/Opportunity.js";
import CampaignInvite from "../models/CampaignInvite.js";

let pass = 0;
let fail = 0;

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    pass++;
  } catch (e: any) {
    console.log(`  FAIL  ${name}\n          ${e.message}`);
    fail++;
  }
}

function assertNull(doc: any, fields: string[]) {
  for (const f of fields) {
    const v = f.split(".").reduce((o: any, p) => o?.[p], doc);
    if (v !== null && v !== undefined) {
      throw new Error(`expected ${f} to be NULL, got ${JSON.stringify(v)}`);
    }
  }
}

async function main() {
  console.log("\n#41 — blank optional dates on create\n");

  // A campaign is the parent of sessions/invites, so make a good one first.
  const parent = await Campaign.create({ title: "parent campaign" });

  await check("campaigns: blank start_date + end_date", async () => {
    const c = await Campaign.create({
      title: "blank dates", description: "", status: "Not Started",
      startDate: "", endDate: "",
    });
    assertNull(c, ["startDate", "endDate"]);
  });

  await check("tasks: blank due_date", async () => {
    const t = await Task.create({
      title: "blank due date", description: "", status: "Not Started",
      dueDate: "", sfLastSynced: "", notionLastSynced: "",
    });
    assertNull(t, ["dueDate", "sfLastSynced", "notionLastSynced"]);
  });

  await check("game_sessions: blank end_date", async () => {
    const s = await Session.create({
      title: "blank end date", campaign: String(parent._id), endDate: "",
    });
    assertNull(s, ["endDate"]);
  });

  await check("events: blank start_date + end_date", async () => {
    const e = await Event.create({
      title: "blank dates", description: "", startDate: "", endDate: "",
    });
    assertNull(e, ["startDate", "endDate"]);
  });

  // close_date is a date; account_id is a NULLABLE uuid. An untouched form
  // sends "" for both, and "" is just as invalid for uuid
  // ("invalid input syntax for type uuid") as it is for timestamptz.
  await check("opportunities: blank close_date + blank optional uuid", async () => {
    const o = await Opportunity.create({
      name: "blank close date", stage: "Probe", closeDate: "", accountId: "",
    });
    assertNull(o, ["closeDate", "accountId"]);
  });

  // #41 flagged campaign_invites as possibly a *different* bug — it has no
  // date column at all. It is: from_user/to_user are NOT NULL and still carry
  // FKs to sf_users, so an invite to anyone who is not an sf_users row fails
  // on the constraint, not on coercion. See the note in #42.
  await check("campaign_invites: create with two real sf_users", async () => {
    const { rows } = await pool.query(
      `INSERT INTO sf_users (name, password) VALUES ('a','x'), ('b','x') RETURNING id`);
    const i = await CampaignInvite.create({
      campaign: String(parent._id), from: rows[0].id, to: rows[1].id,
    });
    if (!i._id) throw new Error("no id returned");
  });

  await check("campaign_invites: invite to a non-sf_users person (the real #42 failure)", async () => {
    const { rows: u } = await pool.query(
      `INSERT INTO sf_users (name, password) VALUES ('inviter','x') RETURNING id`);
    const { rows: c } = await pool.query(
      `INSERT INTO sf_contacts (name) VALUES ('a contact') RETURNING id`);
    let threw = false;
    try {
      await CampaignInvite.create({ campaign: String(parent._id), from: u[0].id, to: c[0].id });
    } catch (e: any) {
      threw = /foreign key|violates/i.test(e.message);
    }
    if (!threw) throw new Error("expected the sf_users FK to reject a contact — schema.sql may have been fixed");
  });

  // A real date must still round-trip, and garbage must still be rejected —
  // silently nulling a mistyped date would lose what the user typed.
  await check("a real date still round-trips", async () => {
    const c = await Campaign.create({ title: "real date", startDate: "2026-09-01T00:00:00Z" });
    if (!(c.startDate instanceof Date)) throw new Error(`expected a Date, got ${typeof c.startDate}`);
  });

  await check("an unparseable date is still an error (not silently NULL)", async () => {
    let threw = false;
    try {
      await Campaign.create({ title: "garbage date", startDate: "not-a-date" });
    } catch { threw = true; }
    if (!threw) throw new Error("expected a rejection for an unparseable date");
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
