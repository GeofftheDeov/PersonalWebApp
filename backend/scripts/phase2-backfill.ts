/**
 * Phase 2 — backfill the unified `accounts` table (GitHub #34, Paperclip MUR-322).
 *
 * Reads person-merge-adjudication.csv (repo root, untracked; also attached to
 * MUR-320) and merges the four sf_* landing tables into `accounts` +
 * `account_source_links`.
 *
 *   npx tsx scripts/phase2-backfill.ts --admin <account-id> [--csv <path>] [--apply]
 *   npx tsx scripts/phase2-backfill.ts --admin <account-id> [--csv <path>] --emit-sql > backfill.sql
 *
 * Without --apply it is a DRY RUN: everything happens inside a transaction that
 * is rolled back at the end, and you still get the full report and every
 * assertion. Run it that way first, always.
 *
 * --admin names the account to pin admin/manual: the winning source_id of the
 * System Administrator's group. Each database has its own ids (dev's is
 * 62320595-…, production's is 4b643037-…), so there is no default.
 *
 * --emit-sql writes the same backfill as a single SQL transaction instead of
 * running it, for a database you can reach through a SQL console but not with a
 * DATABASE_URL. Every value moves table to table inside Postgres — nothing,
 * least of all a password hash, passes through the machine that generates it.
 * A failed assertion raises, so the whole transaction rolls back, exactly as the
 * CLI does. test-phase2-emit-sql.ts holds it row-for-row to runBackfill.
 *
 * Landing tables are never written. Reversal is
 * `TRUNCATE accounts, account_source_links` — see #34, which is why this is
 * safe to re-run and why re-running is expected rather than exceptional.
 */
import fs from "fs";
import path from "path";
import pool from "../db/index.js";
import type pg from "pg";

// ---------------------------------------------------------------- the sheet

export interface MergeRow {
  group_id: string;
  group_label: string;
  source_table: "sf_users" | "sf_accounts" | "sf_contacts" | "sf_leads";
  source_id: string;
  email: string;
  handle: string;
  name: string;
  refs: string;
  proposed_winner: string;
  note: string;
}

/** Minimal RFC-4180 reader — the notes column contains commas and quotes. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const src = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim() !== ""));
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

const isWinner = (r: MergeRow) => r.proposed_winner.toUpperCase() === "TRUE";

const SF_OBJECT: Record<string, string> = {
  sf_users: "User", sf_accounts: "Account", sf_contacts: "Contact", sf_leads: "Lead",
};

/**
 * Field-ownership precedence (§2.6). App-owned columns come from whichever
 * source actually had them — a person's password may live on the Lead while
 * their company lives on the Account — so every column is a COALESCE across
 * the group. The winner is consulted first; the rest follow a fixed table
 * order so the result does not depend on CSV row order.
 */
const TABLE_RANK: Record<string, number> = { sf_users: 0, sf_accounts: 1, sf_contacts: 2, sf_leads: 3 };

/** Columns each landing table actually has. They are not uniform. */
export const COLUMNS: Record<string, string[]> = {
  sf_users: ["name", "email", "phone", "handle", "password", "reset_password_token",
    "reset_password_expires", "is_verified", "email_verification_token", "role",
    "user_number", "user_digit", "sf_id", "discord_id", "discord_handle",
    "profile_picture", "favorite_games", "friends", "created_at"],
  sf_accounts: ["name", "email", "password", "reset_password_token", "reset_password_expires",
    "is_verified", "email_verification_token", "industry", "company", "website", "handle",
    "phone", "address", "user_number", "user_digit", "sf_id", "sf_record_type_id",
    "sf_record_type_name", "profile_picture", "favorite_games", "friends", "created_at"],
  sf_contacts: ["name", "email", "password", "is_verified", "email_verification_token",
    "reset_password_token", "reset_password_expires", "phone", "handle", "role",
    "user_number", "user_digit", "sf_id", "profile_picture", "favorite_games",
    "friends", "created_at"],
  sf_leads: ["first_name", "last_name", "email", "password", "reset_password_token",
    "reset_password_expires", "is_verified", "email_verification_token", "company",
    "handle", "phone", "status", "source", "user_number", "user_digit", "sf_lead_id",
    "sf_record_type_id", "sf_record_type_name", "profile_picture", "favorite_games",
    "friends", "created_at"],
};

/** Winner first, then the fixed table order. The sort is stable, so sheet order breaks ties. */
function precedence(members: MergeRow[]): MergeRow[] {
  const winner = members.find(isWinner)!;
  return [winner, ...members.filter((m) => m !== winner)
    .sort((a, b) => TABLE_RANK[a.source_table] - TABLE_RANK[b.source_table])];
}

// ---------------------------------------------------------------- validation

export function validate(rows: MergeRow[]): { groups: Map<string, MergeRow[]>; excluded: string[] } {
  const groups = new Map<string, MergeRow[]>();
  for (const r of rows) {
    if (!SF_OBJECT[r.source_table]) throw new Error(`unknown source_table "${r.source_table}" (${r.source_id})`);
    if (!/^[0-9a-f-]{36}$/i.test(r.source_id)) throw new Error(`source_id is not a uuid: "${r.source_id}"`);
    (groups.get(r.group_id) ?? groups.set(r.group_id, []).get(r.group_id)!).push(r);
  }

  const excluded: string[] = [];
  for (const [gid, members] of groups) {
    const winners = members.filter(isWinner);
    if (winners.length > 1) {
      throw new Error(`group ${gid} has ${winners.length} winners; exactly one or none is allowed`);
    }
    if (winners.length === 0) excluded.push(gid);
  }

  // A source row must not appear twice — that would produce two links for one row.
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.source_table}:${r.source_id}`;
    if (seen.has(key)) throw new Error(`source row ${key} appears more than once`);
    seen.add(key);
  }
  return { groups, excluded };
}

// ---------------------------------------------------------------- the backfill

export interface BackfillResult {
  accounts: number;
  links: number;
  excluded: string[];
  assertions: { name: string; ok: boolean; detail: string }[];
}

// The checks below run in both runBackfill and backfillSql, so they live here once.

/** #34's headline assertion: app_role must equal sf_users.role, and every sf_users row must have graduated to an account. */
const ROLE_DRIFT_SQL = `
    SELECT u.id, u.email, u.role, a.app_role
      FROM sf_users u
      LEFT JOIN account_source_links l ON l.source_table = 'sf_users' AND l.source_id = u.id
      LEFT JOIN accounts a ON a.id = l.account_id
     WHERE a.id IS NULL
        OR (a.app_role_source = 'sf' AND a.app_role IS DISTINCT FROM u.role)`;

/** Reference sweep (#34): every polymorphic person id must resolve to exactly one account, via accounts.id or account_source_links.source_id. */
const UNRESOLVED_SQL = `
    WITH resolvable AS (
      SELECT id AS pid FROM accounts
      UNION SELECT source_id FROM account_source_links
    ), refs AS (
      SELECT 'friend_requests.from_user' AS site, from_user AS pid FROM friend_requests
      UNION ALL SELECT 'friend_requests.to_user', to_user FROM friend_requests
      UNION ALL SELECT 'campaign_invites.from_user', from_user FROM campaign_invites
      UNION ALL SELECT 'campaign_invites.to_user', to_user FROM campaign_invites
      UNION ALL SELECT 'notifications.user_id', user_id FROM notifications
      UNION ALL SELECT 'characters.player_id', player_id FROM characters
      UNION ALL SELECT 'player_sessions.player_id', player_id FROM player_sessions
      UNION ALL SELECT 'campaign_members.lead_id', lead_id FROM campaign_members WHERE lead_id IS NOT NULL
      UNION ALL SELECT 'campaign_members.contact_id', contact_id FROM campaign_members WHERE contact_id IS NOT NULL
      UNION ALL SELECT 'campaign_members.account_id', account_id FROM campaign_members WHERE account_id IS NOT NULL
      UNION ALL SELECT 'accounts.friends[]', unnest(friends) FROM accounts
    )
    SELECT r.site, count(*)::int AS n
      FROM refs r LEFT JOIN resolvable a ON a.pid = r.pid
     WHERE r.pid IS NOT NULL AND a.pid IS NULL
     GROUP BY r.site ORDER BY r.site`;

/** messages.sender_id is text, and carries the synthetic "system" bot sender. */
const UNRESOLVED_SENDERS_SQL = `
    SELECT count(*)::int AS n FROM messages m
     WHERE m.sender_id <> 'system'
       AND m.sender_id ~ '^[0-9a-f-]{36}$'
       AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id::text = m.sender_id)
       AND NOT EXISTS (SELECT 1 FROM account_source_links l WHERE l.source_id::text = m.sender_id)`;

/** Nobody should be able to log in as somebody else: one email, one account. */
const DUP_EMAIL_SQL = `
    SELECT lower(email::text) AS e, count(*)::int AS n FROM accounts
     WHERE email IS NOT NULL GROUP BY 1 HAVING count(*) > 1`;

/** A person with no password cannot log in — that is gate 1 for that person. */
const NO_PASSWORD_SQL = `SELECT count(*)::int AS n FROM accounts WHERE password IS NULL`;

const PRIMARY_LINKS_SQL = `SELECT count(*)::int AS n FROM account_source_links WHERE is_primary`;

const TIER_MAP_SQL = `
    UPDATE accounts a SET account_tier = t.account_tier
      FROM sf_object_tier_map t
     WHERE t.sf_object = a.sf_object AND a.account_tier_source = 'sf'`;

/** The manual admin pin (#34). Without it a Salesforce Profile change silently revokes admin overnight and there is no route back in via the UI. */
const ADMIN_PIN_SQL = `UPDATE accounts SET app_role = 'admin', app_role_source = 'manual' WHERE id = $1`;

export async function runBackfill(
  client: pg.PoolClient,
  rows: MergeRow[],
  opts: { adminId: string; log?: (s: string) => void },
): Promise<BackfillResult> {
  const log = opts.log ?? (() => {});
  const { groups, excluded } = validate(rows);

  // `person_outbox` has an FK to `accounts`, so a bare CASCADE here also
  // truncates the Salesforce write-back queue — announced by nothing louder
  // than a psql NOTICE. It is empty in Phase 2, but this script is built to be
  // re-run, and from Phase 3 on that queue holds real pending writes. Refuse
  // rather than discard, and name the table being truncated instead of letting
  // CASCADE reach it implicitly.
  const { rows: queued } = await client.query(
    `SELECT count(*)::int AS n FROM person_outbox`);
  if (queued[0].n > 0) {
    throw new Error(
      `person_outbox holds ${queued[0].n} queued Salesforce write-back(s); ` +
      `truncating accounts would discard them. Drain the outbox first.`);
  }
  await client.query("TRUNCATE accounts, account_source_links, person_outbox");

  let accounts = 0;
  let links = 0;

  for (const [gid, members] of [...groups.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const winner = members.find(isWinner);
    if (!winner) {
      log(`  group ${gid} EXCLUDED — no winner (${members[0].group_label})`);
      continue;
    }

    const ordered = precedence(members);

    // Pull every contributing source row, tagged with its precedence index.
    const sources: { row: any; table: string }[] = [];
    for (const m of ordered) {
      const { rows: got } = await client.query(
        `SELECT * FROM ${m.source_table} WHERE id = $1`, [m.source_id]);
      if (!got[0]) throw new Error(`group ${gid}: ${m.source_table} row ${m.source_id} not found`);
      sources.push({ row: got[0], table: m.source_table });
    }

    /** First non-null value for `col` across the group, in precedence order. */
    const pick = (col: string, only?: string) => {
      for (const s of sources) {
        if (only && s.table !== only) continue;
        if (!COLUMNS[s.table].includes(col)) continue;
        const v = s.row[col];
        if (v !== null && v !== undefined && v !== "") return v;
      }
      return null;
    };
    /** Union of an array column across the group (favorite_games, friends). */
    const union = (col: string) => {
      const out = new Set<string>();
      for (const s of sources) {
        if (!COLUMNS[s.table].includes(col)) continue;
        for (const v of s.row[col] ?? []) out.add(String(v));
      }
      return [...out];
    };

    // app_role comes from sf_users.role and nowhere else (#34 step 4). A
    // Contact also has a `role` column, but that is the Salesforce Contact
    // role — feeding it in here would hand app access to CRM data.
    const usersRole = pick("role", "sf_users");

    // sf_leads names its Salesforce id sf_lead_id, not sf_id.
    const sfIdOf = (row: any) => row.sf_id ?? row.sf_lead_id ?? null;

    // The account carries the WINNER's Salesforce id...
    const sfId = pick("sf_id") ?? pick("sf_lead_id");

    // ...but each account_source_links row carries its OWN source row's, so
    // (sf_object, sf_id) keeps identifying exactly one Salesforce record. Using
    // the winner's id on every link made a Contact link claim the Account's
    // 001 id, which is the id a write-back would then update.
    const sfIdByRow = new Map<string, string | null>(
      sources.map((s) => [`${s.table}:${s.row.id}`, sfIdOf(s.row)]));

    await client.query(
      `INSERT INTO accounts (
         id, email, password, is_verified, email_verification_token,
         reset_password_token, reset_password_expires,
         app_role, app_role_source, account_tier, account_tier_source,
         name, first_name, last_name, handle, user_number, user_digit,
         profile_picture, favorite_games, discord_id, discord_handle, friends,
         phone, company, industry, website, address, lead_status,
         sf_object, sf_id, sf_record_type_id, sf_record_type_name, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'sf',$9,'sf',$10,$11,$12,$13,$14,$15,
               $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)`,
      [
        winner.source_id,
        pick("email"), pick("password"),
        sources.some((s) => s.row.is_verified === true),
        pick("email_verification_token"),
        pick("reset_password_token"), pick("reset_password_expires"),
        usersRole ?? "user",
        "free", // replaced by the tier map below; NOT NULL needs a seed value
        pick("name"), pick("first_name"), pick("last_name"), pick("handle"),
        pick("user_number"), pick("user_digit"),
        pick("profile_picture"), union("favorite_games"),
        pick("discord_id"), pick("discord_handle"), union("friends"),
        pick("phone"), pick("company"), pick("industry"), pick("website"),
        pick("address"), pick("status"),
        SF_OBJECT[winner.source_table], sfId,
        pick("sf_record_type_id"), pick("sf_record_type_name"),
        pick("created_at") ?? new Date(),
      ],
    );
    accounts++;

    for (const m of members) {
      await client.query(
        `INSERT INTO account_source_links
           (source_table, source_id, account_id, sf_object, sf_id, is_primary)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [m.source_table, m.source_id, winner.source_id,
         SF_OBJECT[m.source_table],
         sfIdByRow.get(`${m.source_table}:${m.source_id}`) ?? null,
         m === winner],
      );
      links++;
    }
  }

  // ---- the two source maps (#28). Tier from provenance; role stays as set.
  await client.query(TIER_MAP_SQL);

  const pin = await client.query(ADMIN_PIN_SQL, [opts.adminId]);

  // ---------------------------------------------------------------- assertions
  const assertions: BackfillResult["assertions"] = [];
  const assert = (name: string, ok: boolean, detail: string) => assertions.push({ name, ok, detail });

  assert("the admin pin landed", pin.rowCount === 1,
    pin.rowCount === 1 ? "1 row pinned to admin/manual" : `expected 1 row, updated ${pin.rowCount}`);

  const { rows: roleDrift } = await client.query(ROLE_DRIFT_SQL);
  assert("every sf_users row resolves, and app_role matches sf_users.role",
    roleDrift.length === 0,
    roleDrift.length === 0 ? "0 rows" : JSON.stringify(roleDrift));

  const { rows: unresolved } = await client.query(UNRESOLVED_SQL);
  assert("every polymorphic person id resolves to an account",
    unresolved.length === 0,
    unresolved.length === 0 ? "0 unresolvable refs"
      : unresolved.map((r: any) => `${r.site}: ${r.n}`).join(", "));

  const { rows: msg } = await client.query(UNRESOLVED_SENDERS_SQL);
  assert("every message sender resolves to an account", msg[0].n === 0, `${msg[0].n} unresolvable senders`);

  const { rows: dupEmail } = await client.query(DUP_EMAIL_SQL);
  assert("no duplicate emails across accounts", dupEmail.length === 0,
    dupEmail.length === 0 ? "0 duplicates" : JSON.stringify(dupEmail));

  const { rows: noPw } = await client.query(NO_PASSWORD_SQL);
  assert("every account carries a password", noPw[0].n === 0,
    noPw[0].n === 0 ? "0 without" : `${noPw[0].n} account(s) have no password`);

  const { rows: primary } = await client.query(PRIMARY_LINKS_SQL);
  assert("exactly one primary link per account", primary[0].n === accounts,
    `${primary[0].n} primary links for ${accounts} accounts`);

  return { accounts, links, excluded, assertions };
}

// ---------------------------------------------------------------- as SQL

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * runBackfill as a list of SQL statements, to be run as ONE transaction
 * (--emit-sql wraps them in BEGIN/COMMIT). The sheet decides the shape — which
 * rows, in which order, contribute to which column — exactly as runBackfill
 * does; Postgres supplies every value. So pick() becomes "first non-null,
 * non-'' value in precedence order" and union() "first occurrence wins", each
 * evaluated server-side over the same candidates runBackfill would read.
 *
 * Table names come from SF_OBJECT's keys and ids are validated as uuids before
 * they are inlined, so nothing from the sheet reaches the SQL unchecked.
 */
export function backfillSql(rows: MergeRow[], adminId: string): string[] {
  if (!/^[0-9a-f-]{36}$/i.test(adminId)) throw new Error(`--admin is not a uuid: "${adminId}"`);
  const { groups } = validate(rows);
  const kept = [...groups.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .filter(([, members]) => members.some(isWinner));

  const cell = (m: MergeRow, col: string) => `(SELECT ${col} FROM ${m.source_table} WHERE id = ${lit(m.source_id)})`;
  const inlineAdmin = (sql: string) => sql.replace(/\$1/g, lit(adminId));

  const out: string[] = [];

  out.push(`DO $$ BEGIN
  IF (SELECT count(*) FROM person_outbox) > 0 THEN
    RAISE EXCEPTION 'person_outbox holds % queued Salesforce write-back(s); truncating accounts would discard them. Drain the outbox first.',
      (SELECT count(*) FROM person_outbox);
  END IF;
END $$`);

  // runBackfill throws on a missing source row as it reads it; do the same, up front.
  out.push(`DO $$ BEGIN
${kept.flatMap(([gid, members]) => members.map((m) =>
    `  IF NOT EXISTS (SELECT 1 FROM ${m.source_table} WHERE id = ${lit(m.source_id)}) THEN RAISE EXCEPTION ${lit(`group ${gid}: ${m.source_table} row ${m.source_id} not found`)}; END IF;`)).join("\n")}
END $$`);

  out.push("TRUNCATE accounts, account_source_links, person_outbox");

  for (const [, members] of kept) {
    const ordered = precedence(members);
    const winner = ordered[0];
    const candidates = (col: string, only?: string) => ordered
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => (!only || m.source_table === only) && COLUMNS[m.source_table].includes(col));

    const pick = (col: string, only?: string) => {
      const c = candidates(col, only);
      if (!c.length) return "NULL";
      return `(SELECT v FROM (VALUES ${c.map(({ m, i }) => `(${i}, ${cell(m, col)})`).join(", ")}) s(o, v)
          WHERE v IS NOT NULL AND v::text <> '' ORDER BY o LIMIT 1)`;
    };
    const union = (col: string, type: string) => {
      const c = candidates(col);
      if (!c.length) return `'{}'::${type}`;
      const parts = c.map(({ m, i }) => `SELECT ${i} AS o, x.v, x.n FROM unnest(${cell(m, col)}) WITH ORDINALITY x(v, n)`);
      return `(SELECT coalesce(array_agg(v ORDER BY o, n), '{}'::${type}) FROM
          (SELECT DISTINCT ON (v) v, o, n FROM (${parts.join(" UNION ALL ")}) u ORDER BY v, o, n) d)`;
    };
    // Every landing table has is_verified; runBackfill ORs it across the whole group.
    const verified = `coalesce((SELECT bool_or(v) FROM (VALUES ${ordered.map((m, i) => `(${i}, ${cell(m, "is_verified")})`).join(", ")}) s(o, v)), false)`;

    out.push(`INSERT INTO accounts (
         id, email, password, is_verified, email_verification_token,
         reset_password_token, reset_password_expires,
         app_role, app_role_source, account_tier, account_tier_source,
         name, first_name, last_name, handle, user_number, user_digit,
         profile_picture, favorite_games, discord_id, discord_handle, friends,
         phone, company, industry, website, address, lead_status,
         sf_object, sf_id, sf_record_type_id, sf_record_type_name, created_at)
       VALUES (${[
         lit(winner.source_id),
         pick("email"), pick("password"), verified,
         pick("email_verification_token"),
         pick("reset_password_token"), pick("reset_password_expires"),
         `coalesce(${pick("role", "sf_users")}, 'user')`, "'sf'", "'free'", "'sf'",
         pick("name"), pick("first_name"), pick("last_name"), pick("handle"),
         pick("user_number"), pick("user_digit"),
         pick("profile_picture"), union("favorite_games", "text[]"),
         pick("discord_id"), pick("discord_handle"), union("friends", "uuid[]"),
         pick("phone"), pick("company"), pick("industry"), pick("website"),
         pick("address"), pick("status"),
         lit(SF_OBJECT[winner.source_table]), `coalesce(${pick("sf_id")}, ${pick("sf_lead_id")})`,
         pick("sf_record_type_id"), pick("sf_record_type_name"),
         `coalesce(${pick("created_at")}, now())`,
       ].join(",\n         ")})`);

    // Each link carries its OWN source row's Salesforce id; sf_leads calls it sf_lead_id.
    out.push(`INSERT INTO account_source_links
         (source_table, source_id, account_id, sf_object, sf_id, is_primary)
       VALUES ${members.map((m) => `(${[
         lit(m.source_table), lit(m.source_id), lit(winner.source_id), lit(SF_OBJECT[m.source_table]),
         cell(m, m.source_table === "sf_leads" ? "sf_lead_id" : "sf_id"), m === winner ? "true" : "false",
       ].join(", ")})`).join(",\n              ")}`);
  }

  out.push(TIER_MAP_SQL.trim());

  // Pin, then every runBackfill assertion; any failure raises and the transaction rolls back.
  out.push(`DO $$
DECLARE cnt int; bad text;
BEGIN
  ${inlineAdmin(ADMIN_PIN_SQL)};
  GET DIAGNOSTICS cnt = ROW_COUNT;
  IF cnt <> 1 THEN RAISE EXCEPTION 'the admin pin landed: expected 1 row, updated %', cnt; END IF;

  SELECT string_agg(concat_ws(' ', id, email, role, app_role), '; ') INTO bad FROM (${ROLE_DRIFT_SQL}) x;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'every sf_users row resolves, and app_role matches sf_users.role: %', bad; END IF;

  SELECT string_agg(x.site || ': ' || x.n, ', ') INTO bad FROM (${UNRESOLVED_SQL}) x;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'every polymorphic person id resolves to an account: %', bad; END IF;

  SELECT x.n INTO cnt FROM (${UNRESOLVED_SENDERS_SQL}) x;
  IF cnt <> 0 THEN RAISE EXCEPTION 'every message sender resolves to an account: % unresolvable senders', cnt; END IF;

  SELECT string_agg(x.e || ' x' || x.n, ', ') INTO bad FROM (${DUP_EMAIL_SQL}) x;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'no duplicate emails across accounts: %', bad; END IF;

  SELECT x.n INTO cnt FROM (${NO_PASSWORD_SQL}) x;
  IF cnt <> 0 THEN RAISE EXCEPTION 'every account carries a password: % account(s) have no password', cnt; END IF;

  SELECT x.n INTO cnt FROM (${PRIMARY_LINKS_SQL}) x;
  IF cnt <> ${kept.length} THEN RAISE EXCEPTION 'exactly one primary link per account: % primary links for ${kept.length} accounts', cnt; END IF;
END $$`);

  return out;
}

// ---------------------------------------------------------------- cli

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const csvArg = args.indexOf("--csv");
  const csvPath = csvArg >= 0
    ? args[csvArg + 1]
    : path.resolve(process.cwd(), "..", "person-merge-adjudication.csv");

  if (!fs.existsSync(csvPath)) {
    console.error(`\n  Cannot find the adjudication sheet at ${csvPath}`);
    console.error(`  It is untracked in the repo root; pass --csv <path> if it lives elsewhere.\n`);
    process.exit(2);
  }

  const rows = parseCsv(fs.readFileSync(csvPath, "utf8")) as unknown as MergeRow[];

  const adminArg = args.indexOf("--admin");
  const adminId = adminArg >= 0 ? args[adminArg + 1] : undefined;
  if (!adminId || !rows.some((r) => isWinner(r) && r.source_id === adminId)) {
    console.error(`\n  --admin <account-id> is required, and must be the winning source_id of a group in the sheet.`);
    console.error(`  It names the account pinned admin/manual — the System Administrator's.\n`);
    process.exit(2);
  }

  // stdout is the SQL itself, so it can be piped straight into a file or psql.
  if (args.includes("--emit-sql")) {
    const stmts = backfillSql(rows, adminId);
    process.stdout.write(`-- Phase 2 backfill (#34), generated from ${path.basename(csvPath)} (${rows.length} source rows)\n`);
    process.stdout.write(`BEGIN;\n\n${stmts.join(";\n\n")};\n\nCOMMIT;\n`);
    await pool.end();
    return;
  }

  console.log(`\nPhase 2 backfill  (#34)   ${apply ? "APPLY" : "DRY RUN — will roll back"}`);
  console.log(`  sheet: ${csvPath}  (${rows.length} source rows)\n`);

  const client = await pool.connect();
  let result: BackfillResult | null = null;
  try {
    await client.query("BEGIN");
    result = await runBackfill(client, rows, { adminId, log: (s) => console.log(s) });

    console.log(`\n  accounts: ${result.accounts}   links: ${result.links}   excluded groups: ${result.excluded.join(", ") || "none"}\n`);
    for (const a of result.assertions) {
      console.log(`  ${a.ok ? "PASS" : "FAIL"}  ${a.name}\n          ${a.detail}`);
    }

    const failed = result.assertions.filter((a) => !a.ok);
    if (failed.length) {
      await client.query("ROLLBACK");
      console.log(`\n  ${failed.length} assertion(s) failed — rolled back, nothing written.\n`);
      process.exit(1);
    }
    if (apply) {
      await client.query("COMMIT");
      console.log("\n  COMMITTED. Reverse with: TRUNCATE accounts, account_source_links;\n");
    } else {
      await client.query("ROLLBACK");
      console.log("\n  Dry run complete — rolled back. Re-run with --apply to keep it.\n");
    }
  } catch (e: any) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`\n  ERROR — rolled back, nothing written.\n  ${e.message}\n`);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

// Run the CLI only when this file IS the entry point. Note the basename check:
// `includes("phase2-backfill")` also matches test-phase2-backfill.ts, which
// imports this module — the CLI then ran alongside the test and the two
// TRUNCATEs deadlocked against each other.
if (path.basename(process.argv[1] ?? "").startsWith("phase2-backfill")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
