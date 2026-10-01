/**
 * Person references on a database built from schema.sql.
 *
 * Written for GitHub #42, when a person could live in any of four tables
 * (sf_users / sf_leads / sf_contacts / sf_accounts) and schema.sql still pinned
 * friend_requests / campaign_invites / notifications / characters to one of
 * them, so anything built from it came up broken for 18 of 19 people. The fix
 * then was to drop those FKs, and this suite asserted they stayed dropped.
 *
 * Phase 3 (#35) unified people into `accounts` and put the FKs back, pointed at
 * accounts(id) (db/migrations/2026-09-09-phase3-schema-additions.sql). The #42
 * bug in its current form is a person column pinned to a landing table again,
 * so that is what this suite now guards:
 *
 *   - every app-facing person FK references accounts(id), and no FK outside
 *     Salesforce's own relationships references a landing table;
 *   - an account of any provenance (sf_object Lead / Contact / Account / User)
 *     can send and receive friend requests and campaign invites;
 *   - an id that exists only in a landing table is refused where an FK exists.
 *
 * The old 12-pair "User -> Lead" matrix is gone on purpose. It tested that no
 * constraint named one of four tables; there is now one table, the FK never
 * reads sf_object, and every pair would exercise the same constraint. A ring
 * (Lead -> Contact -> Account -> User -> Lead) keeps each provenance on both
 * ends of a request without repeating that twelve times.
 *
 * Run against a throwaway database loaded from db/schema.sql (it inserts rows,
 * and refuses to run against anything but localhost):
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-person-refs.ts
 */
import pool from "../db/index.js";

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

/**
 * The statement must fail with this SQLSTATE. Matching the code, not just "it
 * threw", is what keeps a renamed column from passing as a refusal — the way
 * this suite's campaign_invites cases silently tested a column that no longer
 * existed after Phase 3.
 */
async function refused(sql: string, params: unknown[], code: string) {
  try {
    await pool.query(sql, params);
  } catch (e: any) {
    if (e.code === code) return;
    throw new Error(`expected SQLSTATE ${code}, got ${e.code}: ${e.message}`);
  }
  throw new Error(`expected SQLSTATE ${code}, but the insert succeeded`);
}

const FK_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";

async function main() {
  console.log("\n#42 / #35 — person refs on a schema.sql-built database\n");

  // One account per provenance, standing in for the four landing tables a
  // person could come from before Phase 3. accounts.id has no default.
  const people: Array<[string, string]> = [];
  for (const sfObject of ["Lead", "Contact", "Account", "User"]) {
    const { rows } = await pool.query(
      `INSERT INTO accounts (id, name, sf_object) VALUES (gen_random_uuid(), $1, $2) RETURNING id`,
      [`a ${sfObject.toLowerCase()}`, sfObject]);
    people.push([sfObject, rows[0].id]);
  }
  const ring = people.map((from, i) => [from, people[(i + 1) % people.length]] as const);

  // A landing row that never became an account: the kind of id #42-era code
  // wrote everywhere, and that the app no longer resolves.
  const { rows: stray } = await pool.query(
    `INSERT INTO sf_leads (first_name, last_name) VALUES ('landing','only') RETURNING id`);
  const strayId = stray[0].id;
  const [, someone] = people[0];

  // ── friend_requests ──────────────────────────────────────────────────────
  for (const [[fromType, fromId], [toType, toId]] of ring) {
    await check(`friend_request ${fromType} -> ${toType}`, async () => {
      await pool.query(
        `INSERT INTO friend_requests (from_user, to_user) VALUES ($1, $2)`, [fromId, toId]);
    });
  }
  await check("friend_request to or from a landing-only id is refused", async () => {
    await refused(`INSERT INTO friend_requests (from_user, to_user) VALUES ($1, $2)`,
      [someone, strayId], FK_VIOLATION);
    await refused(`INSERT INTO friend_requests (from_user, to_user) VALUES ($1, $2)`,
      [strayId, someone], FK_VIOLATION);
  });

  // ── campaign_invites ─────────────────────────────────────────────────────
  // Anyone can be invited to a campaign (Geoff, 2026-08-22). Since #35 that
  // means any account, or an email for somebody who has no account yet.
  const { rows: camp } = await pool.query(
    `INSERT INTO campaigns (title) VALUES ('a campaign') RETURNING id`);
  const campaignId = camp[0].id;

  for (const [[fromType, fromId], [toType, toId]] of ring) {
    await check(`campaign_invite ${fromType} -> ${toType}`, async () => {
      await pool.query(
        `INSERT INTO campaign_invites (campaign_id, from_account_id, to_account_id) VALUES ($1, $2, $3)`,
        [campaignId, fromId, toId]);
    });
  }
  await check("campaign_invite to an email with no account yet", async () => {
    await pool.query(
      `INSERT INTO campaign_invites (campaign_id, from_account_id, to_email) VALUES ($1, $2, $3)`,
      [campaignId, someone, "not-yet-registered@example.com"]);
  });
  await check("campaign_invite with neither an account nor an email is refused", async () => {
    await refused(`INSERT INTO campaign_invites (campaign_id, from_account_id) VALUES ($1, $2)`,
      [campaignId, someone], CHECK_VIOLATION);
  });
  await check("campaign_invite to or from a landing-only id is refused", async () => {
    await refused(
      `INSERT INTO campaign_invites (campaign_id, from_account_id, to_account_id) VALUES ($1, $2, $3)`,
      [campaignId, someone, strayId], FK_VIOLATION);
    await refused(
      `INSERT INTO campaign_invites (campaign_id, from_account_id, to_account_id) VALUES ($1, $2, $3)`,
      [campaignId, strayId, someone], FK_VIOLATION);
  });

  // ── notifications / characters ───────────────────────────────────────────
  // Still FK-less: the Phase 3 migration left them for after the cutover has
  // soaked. This suite deliberately does not assert that they stay FK-less —
  // asserting the absence of a constraint is how it went stale last time.
  for (const [type, id] of people) {
    await check(`notification for a ${type}-sourced account`, async () => {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title) VALUES ($1, 'system', 't')`, [id]);
    });
    await check(`character with a ${type}-sourced account as player`, async () => {
      await pool.query(`INSERT INTO characters (name, player_id) VALUES ('c', $1)`, [id]);
    });
  }

  // ── constraint shape ─────────────────────────────────────────────────────
  // Read by column rather than constraint name: schema.sql's inline REFERENCES
  // and the Phase 3 migration name the same constraints differently.
  const { rows: fks } = await pool.query(`
    SELECT c.conrelid::regclass::text || '.' || a.attname AS col,
           c.confrelid::regclass::text AS refs
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND cardinality(c.conkey) = 1`);
  const refsOf = new Map(fks.map((r) => [r.col as string, r.refs as string]));

  // The positive half. Without it, dropping every FK in the schema would also
  // pass the landing-table check below.
  await check("every app-facing person FK references accounts(id)", async () => {
    const want = [
      "friend_requests.from_user", "friend_requests.to_user",
      "campaign_invites.from_account_id", "campaign_invites.to_account_id",
      "campaign_members.person_id",
      "api_key_vault.user_id", "cloud_claw_sessions.user_id",
    ];
    const wrong = want.filter((col) => refsOf.get(col) !== "accounts");
    if (wrong.length) {
      throw new Error(wrong.map((col) => `${col} -> ${refsOf.get(col) ?? "no FK"}`).join(", "));
    }
  });

  // #42 itself: a person column pinned to one landing table. Only Salesforce's
  // own relationships may point there, plus campaign_members' superseded
  // per-table columns until the final Phase 3 migration drops them.
  await check("no FK outside Salesforce's own relationships references a landing table", async () => {
    const allowed = new Set([
      "sf_contacts.account_id", "opportunities.account_id",
      "campaign_members.lead_id", "campaign_members.contact_id", "campaign_members.account_id",
    ]);
    const landing = new Set(["sf_users", "sf_leads", "sf_contacts", "sf_accounts"]);
    const pinned = [...refsOf].filter(([col, refs]) => landing.has(refs) && !allowed.has(col));
    if (pinned.length) throw new Error(pinned.map(([col, refs]) => `${col} -> ${refs}`).join(", "));
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
