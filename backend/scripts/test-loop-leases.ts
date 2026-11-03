/**
 * Regression test for GitHub #133: background loops assumed one backend task.
 *
 * Every task runs the same setInterval loops, so with two tasks (or the old
 * and new task overlapping in a deploy) each tick ran twice: two Alpaca
 * snapshots, two vault pulls on the shared checkout, and the ready check sent
 * twice (two bells, two Table Talk posts), since the sweep found due sessions
 * and stamped them in separate steps.
 *
 * Two "tasks" here are concurrent calls in one process: each runs its own
 * queries on its own pooled connection, which is what the database sees from
 * two processes.
 *
 * Run against a throwaway database loaded from db/schema.sql (it inserts and
 * deletes its own rows, and refuses to run against anything but localhost):
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-loop-leases.ts
 */
import pool from "../db/index.js";
import { claimLoopTick, runLoopTick } from "../utils/loopLease.js";
import { runReadyCheckSweep } from "../utils/readyCheck.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
  process.exit(2);
}

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? pass++ : fail++;
}

const RUN = Math.random().toString(36).slice(2, 8);
const MINUTE = 60_000;

async function main() {
  console.log("\n#133 — loop leases\n");

  const loop = `test-loop-${RUN}`;
  const firstTick = await Promise.all([claimLoopTick(loop, 5 * MINUTE), claimLoopTick(loop, 5 * MINUTE)]);
  check("two tasks claiming a new loop's tick at once: exactly one wins",
    firstTick.filter(Boolean).length === 1, `got ${JSON.stringify(firstTick)}`);

  check("a task ticking mid-interval finds the tick held", !(await claimLoopTick(loop, 5 * MINUTE)));

  // The next tick, as if the interval has passed: wound back rather than waited for.
  await pool.query(`UPDATE loop_leases SET next_due = now() - interval '1 second' WHERE name = $1`, [loop]);
  const nextTick = await Promise.all([claimLoopTick(loop, 5 * MINUTE), claimLoopTick(loop, 5 * MINUTE)]);
  check("once due again, exactly one of two tasks wins the next tick",
    nextTick.filter(Boolean).length === 1, `got ${JSON.stringify(nextTick)}`);

  const { rows: [lease] } = await pool.query(
    `SELECT extract(epoch FROM next_due - claimed_at) AS secs FROM loop_leases WHERE name = $1`, [loop]);
  check("the lease runs a little short of the interval, so jitter can't skip the winner's next tick",
    lease.secs > 4 * 60 && lease.secs < 5 * 60, `lease ${lease.secs}s`);

  const other = `test-loop-other-${RUN}`;
  check("a different loop has its own lease", await claimLoopTick(other, 5 * MINUTE));

  const gated = `test-loop-gated-${RUN}`;
  let runs = 0;
  const work = async () => { runs++; };
  await Promise.all([runLoopTick(gated, MINUTE, work), runLoopTick(gated, MINUTE, work), runLoopTick(gated, MINUTE, work)]);
  check("runLoopTick: three tasks on the same tick run the work once", runs === 1, `ran ${runs} times`);

  console.log("\n#133 — the ready check is sent once\n");

  const { rows: [campaign] } = await pool.query(
    `INSERT INTO campaigns (title) VALUES ($1) RETURNING id`, [`loop-leases ${RUN}`]);
  const { rows: [session] } = await pool.query(
    `INSERT INTO game_sessions (title, campaign_id, date, ready_check)
     VALUES ('Two Tasks', $1, $2, '{"responses":[{"status":"ready"}]}') RETURNING id`,
    [campaign.id, new Date(Date.now() + 10 * MINUTE)]);

  // Two backend tasks' sweeps landing in the same minute.
  await Promise.all([runReadyCheckSweep(), runReadyCheckSweep()]);

  const { rows: [posts] } = await pool.query(
    `SELECT count(*)::int AS n FROM messages WHERE campaign_id = $1 AND body LIKE '%READY CHECK%'`, [campaign.id]);
  check("two sweeps at once post one ready check to Table Talk", posts.n === 1, `got ${posts.n} posts`);

  const { rows: [after] } = await pool.query(`SELECT ready_check FROM game_sessions WHERE id = $1`, [session.id]);
  check("the session is stamped sent", typeof after.ready_check?.sentAt === "string"
    && !Number.isNaN(Date.parse(after.ready_check.sentAt)), JSON.stringify(after.ready_check));
  check("responses already on the session are kept",
    after.ready_check?.responses?.length === 1 && after.ready_check.responses[0].status === "ready",
    JSON.stringify(after.ready_check));

  await runReadyCheckSweep();
  const { rows: [again] } = await pool.query(
    `SELECT count(*)::int AS n FROM messages WHERE campaign_id = $1 AND body LIKE '%READY CHECK%'`, [campaign.id]);
  check("a later sweep doesn't send it again", again.n === 1, `got ${again.n} posts`);

  await pool.query(`DELETE FROM campaigns WHERE id = $1`, [campaign.id]);
  await pool.query(`DELETE FROM loop_leases WHERE name LIKE $1`, [`%${RUN}`]);

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
