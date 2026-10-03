/**
 * Session planning (#57): does migrations/2026-10-01-session-planning.sql do
 * what it says, and does db/schema.sql say the same thing?
 *
 *   MIGRATED  a database built from schema.sql as it was BEFORE the migration.
 *             This script seeds it, applies the migration twice (it claims to
 *             be idempotent) and checks the backfill.
 *   FRESH     a database built from the current schema.sql in one shot.
 *
 * Then it diffs the two schemas whole -- columns, constraints (by name),
 * indexes and triggers -- because a migration and schema.sql that disagree is
 * the #46 failure, and checks that the new constraints refuse what they exist
 * to refuse. Run it through scripts/session-planning-check.sh, which builds
 * both databases.
 *
 *   MIGRATED_URL=... FRESH_URL=... npx tsx scripts/test-session-planning-migration.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import pg from "pg";

const MIGRATION = resolve(dirname(fileURLToPath(import.meta.url)), "../db/migrations/2026-10-01-session-planning.sql");
/** Later session-planning migrations, applied after it in order, so schema.sql parity covers them too. */
const FOLLOW_UPS = ["2026-10-03-quest-reminders.sql"];
const local = /(\/\/|@)(127\.0\.0\.1|localhost)[:/]/;
const { MIGRATED_URL, FRESH_URL } = process.env;
if (!MIGRATED_URL || !FRESH_URL || !local.test(MIGRATED_URL) || !local.test(FRESH_URL)) {
    console.error("\n  Refusing to run: MIGRATED_URL and FRESH_URL must both be local throwaway databases.\n");
    process.exit(2);
}

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
    ok ? pass++ : fail++;
}

/** Runs `sql` and reports whether Postgres refused it. */
async function refuses(db: pg.Client, sql: string, params: unknown[] = []): Promise<boolean> {
    await db.query("SAVEPOINT probe");
    try {
        await db.query(sql, params);
        await db.query("RELEASE SAVEPOINT probe");
        return false;
    } catch {
        await db.query("ROLLBACK TO SAVEPOINT probe");
        return true;
    }
}

async function schemaOf(db: pg.Client): Promise<string[]> {
    const q = async (sql: string) => (await db.query(sql)).rows.map((r) => JSON.stringify(r));
    return [
        ...await q(`SELECT 'column' AS kind, table_name, column_name, data_type, udt_name, is_nullable, column_default
                      FROM information_schema.columns WHERE table_schema = 'public'`),
        ...await q(`SELECT 'constraint' AS kind, t.relname AS table_name, c.conname, pg_get_constraintdef(c.oid) AS def
                      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
                      JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = 'public'`),
        ...await q(`SELECT 'index' AS kind, tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`),
        ...await q(`SELECT 'trigger' AS kind, c.relname, pg_get_triggerdef(t.oid) AS def
                      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                      JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname = 'public' AND NOT t.tgisinternal`),
    ].sort();
}

async function main() {
    const migrated = new pg.Client({ connectionString: MIGRATED_URL });
    const fresh = new pg.Client({ connectionString: FRESH_URL });
    await migrated.connect();
    await fresh.connect();

    // ── seed the pre-migration database ─────────────────────────────────────
    const { rows: [a, b, c] } = await migrated.query(`
        INSERT INTO accounts (id, name, email) VALUES
          (gen_random_uuid(), 'First GM',  'first-gm@example.test'),
          (gen_random_uuid(), 'Second GM', 'second-gm@example.test'),
          (gen_random_uuid(), 'Player',    'player@example.test')
        RETURNING id`);
    const { rows: [twoGms, noGm, oneGm] } = await migrated.query(`
        INSERT INTO campaigns (title) VALUES ('two GMs'), ('no GM'), ('one GM') RETURNING id`);
    await migrated.query(`
        INSERT INTO campaign_members (campaign_id, person_id, status, joined_at) VALUES
          ($1, $3, 'Game Master', '2026-03-01'),   -- joined later
          ($1, $2, 'Game Master', '2026-01-01'),   -- the earliest: becomes owner
          ($1, $4, 'Player',      '2025-12-01'),   -- earlier still, but not a GM
          ($5, $4, 'Player',      '2026-01-01'),
          ($6, $3, 'Game Master', '2026-02-01')`,
        [twoGms.id, a.id, b.id, c.id, noGm.id, oneGm.id]);
    await migrated.query(`
        INSERT INTO game_sessions (title, campaign_id, date) VALUES
          ('fixed date', $1, '2026-10-10T23:00:00Z'), ('another', $2, '2026-09-01T23:00:00Z')`,
        [twoGms.id, oneGm.id]);

    // ── migrate, twice ──────────────────────────────────────────────────────
    const sql = readFileSync(MIGRATION, "utf8");
    let firstError = "", secondError = "";
    try { await migrated.query(sql); } catch (e: any) { firstError = e.message; await migrated.query("ROLLBACK").catch(() => {}); }
    check("the migration applies to the pre-migration schema", !firstError, firstError);
    try { await migrated.query(sql); } catch (e: any) { secondError = e.message; await migrated.query("ROLLBACK").catch(() => {}); }
    check("applying it a second time is a no-op, not an error", !secondError, secondError);

    // ── backfill ────────────────────────────────────────────────────────────
    const owners = Object.fromEntries((await migrated.query(
        `SELECT title, owner_id, gm_title, quorum FROM campaigns`)).rows.map((r) => [r.title, r]));
    check("owner backfills to the earliest Game Master",
        owners["two GMs"].owner_id === a.id, `got ${owners["two GMs"].owner_id}`);
    check("a campaign with no Game Master is left admin-managed (NULL owner)",
        owners["no GM"].owner_id === null, `got ${owners["no GM"].owner_id}`);
    check("a single Game Master becomes the owner", owners["one GM"].owner_id === b.id);
    check("existing campaigns get the default GM title and whole-party quorum",
        Object.values(owners).every((o: any) => o.gm_title === "Dungeon Master" && o.quorum === null));

    const { rows: sessions } = await migrated.query(`SELECT status, planning_stage, date FROM game_sessions`);
    check("existing sessions backfill as scheduled, with no planning stage",
        sessions.length === 2 && sessions.every((s) => s.status === "scheduled" && s.planning_stage === null && s.date),
        JSON.stringify(sessions));

    // ── follow-up migrations, in order, each twice ──────────────────────────
    // #91 anchors quest due times to their session's start. Seed one quest
    // with a due time and one without (added while the night was being voted on).
    const { rows: [fixed] } = await migrated.query(`SELECT id, date FROM game_sessions WHERE title = 'fixed date'`);
    await migrated.query(`
        INSERT INTO session_tasks (session_id, kind, title, due_at, assignee_id) VALUES
          ($1, 'custom', 'has a due time', $2, $3), ($1, 'custom', 'no due time yet', NULL, $3)`,
        [fixed.id, new Date(+fixed.date - 60 * 60 * 1000), a.id]);
    for (const file of FOLLOW_UPS) {
        const followUp = readFileSync(resolve(dirname(MIGRATION), file), "utf8");
        for (const attempt of ["applies", "re-applies as a no-op"]) {
            let error = "";
            try { await migrated.query(followUp); } catch (e: any) { error = e.message; await migrated.query("ROLLBACK").catch(() => {}); }
            check(`${file} ${attempt}`, !error, error);
        }
    }
    const anchors = Object.fromEntries((await migrated.query(
        `SELECT title, due_anchor FROM session_tasks`)).rows.map((r) => [r.title, r.due_anchor]));
    check("#91: a quest with a due time is anchored to its session's start",
        +anchors["has a due time"] === +fixed.date, anchors);
    check("#91: a quest with no due time stays unanchored, so it takes the session's start",
        anchors["no due time yet"] === null, anchors);

    // ── parity with schema.sql ──────────────────────────────────────────────
    const [m, f] = await Promise.all([schemaOf(migrated), schemaOf(fresh)]);
    const onlyMigrated = m.filter((x) => !f.includes(x));
    const onlyFresh = f.filter((x) => !m.includes(x));
    check("schema.sql builds exactly the schema the migration produces",
        onlyMigrated.length === 0 && onlyFresh.length === 0,
        [...onlyMigrated.map((x) => `migration only: ${x}`), ...onlyFresh.map((x) => `schema.sql only: ${x}`)]
            .slice(0, 12).join("\n          "));

    // ── the constraints refuse what they exist to refuse ────────────────────
    await fresh.query("BEGIN");
    const { rows: [p, q] } = await fresh.query(`
        INSERT INTO accounts (id, name) VALUES (gen_random_uuid(), 'P'), (gen_random_uuid(), 'Q') RETURNING id`);
    const { rows: [camp] } = await fresh.query(`INSERT INTO campaigns (title) VALUES ('c') RETURNING id`);

    check("a planning session may have no date yet",
        !await refuses(fresh, `INSERT INTO game_sessions (title, campaign_id, date, status, planning_stage)
                                VALUES ('t', $1, NULL, 'planning', 'night')`, [camp.id]));
    check("a scheduled session must have a date",
        await refuses(fresh, `INSERT INTO game_sessions (title, campaign_id, date) VALUES ('t', $1, NULL)`, [camp.id]));
    check("a planning session must have a stage",
        await refuses(fresh, `INSERT INTO game_sessions (title, campaign_id, status) VALUES ('t', $1, 'planning')`, [camp.id]));
    check("a scheduled session must not have a stage",
        await refuses(fresh, `INSERT INTO game_sessions (title, campaign_id, planning_stage) VALUES ('t', $1, 'venue')`, [camp.id]));
    check("a window cannot be empty",
        await refuses(fresh, `INSERT INTO availability_windows (person_id, weekday, start_time, end_time, time_zone)
                               VALUES ($1, 6, '17:00', '17:00', 'America/Chicago')`, [p.id]));
    check("a window may cross midnight (end before start)",
        !await refuses(fresh, `INSERT INTO availability_windows (person_id, weekday, start_time, end_time, time_zone)
                                VALUES ($1, 5, '21:00', '01:00', 'America/Chicago')`, [p.id]));
    check("weekday is 0-6",
        await refuses(fresh, `INSERT INTO availability_windows (person_id, weekday, start_time, end_time, time_zone)
                               VALUES ($1, 7, '17:00', '23:00', 'UTC')`, [p.id]));
    check("busy_blocks has no column a calendar event title could land in",
        (await fresh.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'busy_blocks'`))
            .rows.every((r) => !/title|summary|name|description/.test(r.column_name)));

    const { rows: [sess] } = await fresh.query(
        `INSERT INTO game_sessions (title, campaign_id, date, status, planning_stage)
         VALUES ('s', $1, NULL, 'planning', 'night') RETURNING id`, [camp.id]);
    const { rows: [poll1] } = await fresh.query(
        `INSERT INTO polls (session_id, kind, eligible_ids, quorum) VALUES ($1, 'night', $2, 2) RETURNING id`,
        [sess.id, [p.id, q.id]]);
    check("only one open poll per session",
        await refuses(fresh, `INSERT INTO polls (session_id, kind, round) VALUES ($1, 'venue', 1)`, [sess.id]));
    const { rows: [opt1] } = await fresh.query(
        `INSERT INTO poll_options (poll_id, starts_at, ends_at) VALUES ($1, '2026-10-10T23:00Z', '2026-10-11T03:00Z') RETURNING id`,
        [poll1.id]);
    check("a night option needs an end after its start",
        await refuses(fresh, `INSERT INTO poll_options (poll_id, starts_at, ends_at) VALUES ($1, '2026-10-10T23:00Z', '2026-10-10T22:00Z')`, [poll1.id]));
    check("a vote needs a ballot",
        await refuses(fresh, `INSERT INTO poll_votes (poll_id, option_id, person_id) VALUES ($1, $2, $3)`, [poll1.id, opt1.id, p.id]));
    await fresh.query(`INSERT INTO poll_ballots (poll_id, person_id) VALUES ($1, $2)`, [poll1.id, p.id]);
    check("with a ballot, the vote is accepted",
        !await refuses(fresh, `INSERT INTO poll_votes (poll_id, option_id, person_id) VALUES ($1, $2, $3)`, [poll1.id, opt1.id, p.id]));
    check("a ballot may approve nothing (\"I can't make any of these\")",
        !await refuses(fresh, `INSERT INTO poll_ballots (poll_id, person_id) VALUES ($1, $2)`, [poll1.id, q.id]));
    check("a closed poll needs a reason",
        await refuses(fresh, `UPDATE polls SET status = 'closed', closed_at = now() WHERE id = $1`, [poll1.id]));
    check("a 'winner' result needs the winning option",
        await refuses(fresh, `UPDATE polls SET status = 'closed', closed_at = now(), closed_reason = 'all_voted',
                               result = 'winner' WHERE id = $1`, [poll1.id]));
    check("a closed poll with its winner is accepted",
        !await refuses(fresh, `UPDATE polls SET status = 'closed', closed_at = now(), closed_reason = 'all_voted',
                                result = 'winner', winning_option_id = $2 WHERE id = $1`, [poll1.id, opt1.id]));
    const { rows: [poll2] } = await fresh.query(
        `INSERT INTO polls (session_id, kind, round) VALUES ($1, 'night', 2) RETURNING id`, [sess.id]);
    await fresh.query(`INSERT INTO poll_ballots (poll_id, person_id) VALUES ($1, $2)`, [poll2.id, p.id]);
    check("a vote cannot point at another poll's option",
        await refuses(fresh, `INSERT INTO poll_votes (poll_id, option_id, person_id) VALUES ($1, $2, $3)`, [poll2.id, opt1.id, p.id]));

    check("reminder offsets are bounded",
        await refuses(fresh, `INSERT INTO session_tasks (session_id, assignee_id, kind, title, reminder_offsets)
                               VALUES ($1, $2, 'custom', 't', '{-5}')`, [sess.id, p.id]));
    const { rows: [task] } = await fresh.query(
        `INSERT INTO session_tasks (session_id, kind, title, reminder_offsets)
         VALUES ($1, 'food', 'Drinks', '{120}') RETURNING id`, [sess.id]);
    await fresh.query(`INSERT INTO session_task_reminders (task_id, offset_minutes, due_at) VALUES ($1, 120, '2026-10-10T23:00Z')`, [task.id]);
    const again = await fresh.query(
        `INSERT INTO session_task_reminders (task_id, offset_minutes, due_at) VALUES ($1, 120, '2026-10-10T23:00Z')
         ON CONFLICT DO NOTHING RETURNING task_id`, [task.id]);
    const moved = await fresh.query(
        `INSERT INTO session_task_reminders (task_id, offset_minutes, due_at) VALUES ($1, 120, '2026-10-17T23:00Z')
         ON CONFLICT DO NOTHING RETURNING task_id`, [task.id]);
    check("a reminder records once per offset and due time; a new due time re-arms it",
        again.rowCount === 0 && moved.rowCount === 1);
    await fresh.query("ROLLBACK");

    console.log(`\n  ${pass} passed, ${fail} failed\n`);
    await migrated.end();
    await fresh.end();
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
