/**
 * enqueueRun is atomic (#172).
 *
 * It used to SELECT for a queued or running run of the skill and then INSERT,
 * so two requests that raced could both pass the check and queue the skill
 * twice. The unique partial index from migration 0002 now decides the race.
 *
 * Also checks that migration 0002 builds on a table that a race has already
 * left with two active runs of one skill.
 *
 * Run:  DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-agent-runs-enqueue.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pool, { query } from "../db/index.js";
import { enqueueRun, claimNext, completeRun } from "../services/agentRuns.js";

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

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const activeCount = async () =>
  Number((await query(`SELECT count(*) FROM agent_runs WHERE skill = 'morning-brief' AND status IN ('queued','running')`)).rows[0].count);

async function main() {
  console.log("\n#172 — enqueueRun under concurrency\n");
  await query(`DELETE FROM agent_runs`);

  await check("20 concurrent enqueues create one run and all get it back", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => enqueueRun("morning-brief", null)));
    assert(results.filter(r => r.created).length === 1, `created: ${results.filter(r => r.created).length}`);
    assert(new Set(results.map(r => r.run.id)).size === 1, "callers got different runs");
    assert(await activeCount() === 1, `active rows: ${await activeCount()}`);
  });

  await check("a running run still blocks a new one", async () => {
    const claimed = await claimNext("test-pc", ["morning-brief"]);
    assert(claimed, "nothing to claim");
    const again = await enqueueRun("morning-brief", null);
    assert(!again.created && again.run.id === claimed.id, "a second run was queued beside the running one");
  });

  await check("once the run finishes, the next enqueue creates a new run", async () => {
    const running = (await query(`SELECT id FROM agent_runs WHERE status = 'running'`)).rows[0];
    await completeRun(running.id, { ok: true, summary: "done" });
    const next = await enqueueRun("morning-brief", null);
    assert(next.created && next.run.id !== running.id, "no new run after completion");
  });

  console.log("\nmigration 0002 on a table that already has duplicates\n");

  await check("it fails all but one active run per skill and builds the index", async () => {
    await query(`DELETE FROM agent_runs`);
    await query(`DROP INDEX idx_agent_runs_one_active`);
    const { rows } = await query(
      `INSERT INTO agent_runs (skill, status, requested_at) VALUES
         ('morning-brief', 'queued',  now() - interval '3 minutes'),
         ('morning-brief', 'running', now() - interval '2 minutes'),
         ('morning-brief', 'queued',  now() - interval '1 minute'),
         ('lint-wiki',     'queued',  now() - interval '2 minutes'),
         ('lint-wiki',     'queued',  now() - interval '1 minute')
       RETURNING id, skill, status`);
    const sql = readFileSync(fileURLToPath(new URL("../db/migrations/0002__agent-runs-one-active-per-skill.sql", import.meta.url)), "utf8");
    await query(sql);

    const active = (await query(`SELECT id FROM agent_runs WHERE status IN ('queued','running') ORDER BY id`)).rows.map(r => r.id);
    assert(active.length === 2, `active after migration: ${active.length}`);
    assert(active.includes(rows[1].id), "the running morning-brief run should be kept");
    assert(active.includes(rows[3].id), "the oldest queued lint-wiki run should be kept");
    const idx = await query(`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_agent_runs_one_active'`);
    assert(idx.rows.length === 1, "index missing");
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(async e => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
