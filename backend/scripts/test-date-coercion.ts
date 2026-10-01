/**
 * Regression test for GitHub #41 — "" reaching a timestamptz column.
 *
 * Reproduces the reported 500 (create a record with every optional date left
 * blank, the way an untouched HTML form submits it) against a throwaway
 * Postgres built from db/schema.sql, on every table the issue lists.
 *
 * Run against a throwaway database loaded from db/schema.sql (it inserts rows,
 * and refuses to run against anything but localhost):
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-date-coercion.ts
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

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
  process.exit(2);
}

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

  // #41 flagged campaign_invites as possibly a *different* bug. It was: the
  // table has no date column at all. Its person refs were pinned to sf_users
  // by a FK, so an invite to anyone who was not a User failed on the
  // constraint rather than on coercion (#42). Since Phase 3 (#35) both ends
  // reference accounts(id), so the personas here are accounts rows. The
  // "User -> Contact" case that used to follow tested a cross-table pair that
  // no longer exists; provenance coverage lives in test-person-refs.ts.
  const { rows: people } = await pool.query(
    `INSERT INTO accounts (id, name) VALUES (gen_random_uuid(), 'inviter'), (gen_random_uuid(), 'invitee')
     RETURNING id`);

  await check("campaign_invites: account -> account", async () => {
    const i = await CampaignInvite.create({
      campaign: String(parent._id), from: people[0].id, to: people[1].id,
    });
    if (!i._id) throw new Error("no id returned");
  });

  // Phase 3 made to_account_id nullable: an invite by email to somebody with
  // no account yet leaves it unset. Sent as "" by an untouched input, that is
  // the opportunities.account_id case above on a column #41 predates.
  await check("campaign_invites: blank optional uuid (invite by email, no account yet)", async () => {
    const i = await CampaignInvite.create({
      campaign: String(parent._id), from: people[0].id, to: "", toEmail: "new-player@example.com",
    });
    assertNull(i, ["to"]);
    if (i.toEmail !== "new-player@example.com") {
      throw new Error(`expected toEmail to be kept, got ${JSON.stringify(i.toEmail)}`);
    }
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
