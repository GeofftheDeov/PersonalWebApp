/**
 * Regression test for the ready-check sweep failure noted on GitHub #32.
 *
 * utils/readyCheck.ts filters on a dotted path into a jsonb column:
 *
 *   Session.find({ date: {...}, "readyCheck.sentAt": { $exists: false } })
 *
 * Mongo traversed that natively. buildWhere throws on any key not in
 * def.fields, so since the Postgres port the sweep has failed every 60s with
 *
 *   [ready-check] sweep failed: [db] game_sessions: unknown filter field
 *   "readyCheck.sentAt"
 *
 * meaning no ready check has been sent, and no ready_check data has
 * accumulated — which is why #32 can't evaluate its option 2 on the data.
 *
 * Run:  DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-readycheck-sweep.ts
 */
import pool from "../db/index.js";
import Campaign from "../models/Campaign.js";
import Session from "../models/Session.js";

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

async function main() {
  console.log("\n#32 — jsonb path filters (the ready-check sweep)\n");

  const c = await Campaign.create({ title: "sweep campaign" });
  const soon = new Date(Date.now() + 10 * 60 * 1000);
  const later = new Date(Date.now() + 10 * 60 * 60 * 1000);

  const unsent = await Session.create({ title: "unsent", campaign: String(c._id), date: soon });
  await Session.create({
    title: "already sent", campaign: String(c._id), date: soon,
    readyCheck: { sentAt: new Date().toISOString(), responses: [] },
  });
  await Session.create({ title: "out of window", campaign: String(c._id), date: later });

  await check("the sweep query runs at all", async () => {
    await Session.find({
      date: { $gt: new Date(), $lte: new Date(Date.now() + 30 * 60 * 1000) },
      "readyCheck.sentAt": { $exists: false },
    });
  });

  await check("it returns only the un-stamped session in the window", async () => {
    const due = await Session.find({
      date: { $gt: new Date(), $lte: new Date(Date.now() + 30 * 60 * 1000) },
      "readyCheck.sentAt": { $exists: false },
    });
    const titles = due.map((d: any) => d.title).sort();
    if (JSON.stringify(titles) !== JSON.stringify(["unsent"])) {
      throw new Error(`expected ["unsent"], got ${JSON.stringify(titles)}`);
    }
  });

  await check("$exists: true finds the stamped one", async () => {
    const sent = await Session.find({ "readyCheck.sentAt": { $exists: true } });
    if (sent.length !== 1 || sent[0].title !== "already sent") {
      throw new Error(`got ${JSON.stringify(sent.map((s: any) => s.title))}`);
    }
  });

  await check("stamping a session removes it from the due set", async () => {
    unsent.readyCheck = { sentAt: new Date().toISOString(), responses: [] };
    await unsent.save();
    const due = await Session.find({ "readyCheck.sentAt": { $exists: false } });
    if (due.some((d: any) => String(d._id) === String(unsent._id))) {
      throw new Error("still due after stamping");
    }
  });

  await check("an ordering operator on a jsonb path is refused, not answered wrongly", async () => {
    let threw = false;
    try {
      await Session.find({ "readyCheck.sentAt": { $gt: new Date() } });
    } catch (e: any) {
      threw = /not supported on a jsonb path/.test(e.message);
    }
    if (!threw) throw new Error("expected a refusal — text comparison would be silently wrong");
  });

  await check("a genuinely unknown field still errors", async () => {
    let threw = false;
    try {
      await Session.find({ "nonsense.field": 1 });
    } catch (e: any) {
      threw = /unknown filter field/.test(e.message);
    }
    if (!threw) throw new Error("expected 'unknown filter field'");
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
