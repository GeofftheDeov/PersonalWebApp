/**
 * Regression test for GitHub #42 — a database built from schema.sql must not
 * re-impose the person FKs that were dropped by hand on the Neon dev branch.
 *
 * PersonalWebApp treats User | Lead | Contact | Account as interchangeable
 * people (personUtils.ts). Before this fix, schema.sql still declared
 * friend_requests / notifications / characters / player_sessions as REFERENCES
 * sf_users(id) or sf_accounts(id), so anything built from it — including the
 * Neon production branch — came up broken for 18 of 19 accounts.
 *
 * Run against a throwaway cluster loaded from db/schema.sql:
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-person-refs.ts
 */
import pool from "../db/index.js";

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
  console.log("\n#42 — polymorphic person refs on a schema.sql-built database\n");

  const { rows: u } = await pool.query(
    `INSERT INTO sf_users (name, password) VALUES ('a user','x') RETURNING id`);
  const { rows: l } = await pool.query(
    `INSERT INTO sf_leads (first_name, last_name, password) VALUES ('a','lead','x') RETURNING id`);
  const { rows: c } = await pool.query(
    `INSERT INTO sf_contacts (name) VALUES ('a contact') RETURNING id`);
  const { rows: a } = await pool.query(
    `INSERT INTO sf_accounts (name) VALUES ('an account') RETURNING id`);

  const people: Array<[string, string]> = [
    ["User", u[0].id], ["Lead", l[0].id], ["Contact", c[0].id], ["Account", a[0].id],
  ];

  for (const [fromType, fromId] of people) {
    for (const [toType, toId] of people) {
      if (fromId === toId) continue;
      await check(`friend_request ${fromType} -> ${toType}`, async () => {
        await pool.query(
          `INSERT INTO friend_requests (from_user, to_user) VALUES ($1, $2)`, [fromId, toId]);
      });
    }
  }

  for (const [type, id] of people) {
    await check(`notification for a ${type}`, async () => {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title) VALUES ($1, 'system', 't')`, [id]);
    });
    await check(`character with a ${type} as player`, async () => {
      await pool.query(`INSERT INTO characters (name, player_id) VALUES ('c', $1)`, [id]);
    });
  }

  // The five constraints must be absent from a freshly built database.
  const { rows: fks } = await pool.query(`
    SELECT conname FROM pg_constraint
    WHERE contype = 'f' AND conname IN (
      'friend_requests_from_user_fkey','friend_requests_to_user_fkey',
      'notifications_user_id_fkey','characters_player_id_fkey',
      'player_sessions_player_id_fkey')`);
  await check("none of the five person FKs exist", async () => {
    if (fks.length) throw new Error(`still present: ${fks.map((r) => r.conname).join(", ")}`);
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
