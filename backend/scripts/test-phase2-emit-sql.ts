/**
 * backfillSql (--emit-sql) must write exactly what runBackfill writes (#34).
 *
 * --emit-sql exists so the backfill can run through a SQL console against a
 * database this machine holds no credentials for — production, via Neon. That
 * makes it a second implementation of the same merge, so this holds the two
 * row-for-row equal: for many random landing-table fixtures, run each inside
 * the same transaction, snapshot accounts + account_source_links, roll back,
 * compare.
 *
 * The fixtures go after what pick() and union() have to get right: NULL and ''
 * in every text column, a winner from a lower-ranked table than its group-mates,
 * two rows from one table in a group (sheet order breaks the tie), duplicate
 * array entries across sources, a group with no winner.
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-phase2-emit-sql.ts
 */
import pool from "../db/index.js";
import { backfillSql, runBackfill, COLUMNS, type MergeRow } from "./phase2-backfill.js";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? pass++ : fail++;
}

/** mulberry32 — a seeded PRNG, so a failing seed can be replayed. */
function prng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Table = MergeRow["source_table"];

/**
 * Group shapes, winner marked with *. Group 1 is the admin's. Group 3's winner
 * is a Lead beside a Contact; group 5 has two Leads behind an Account; group 6
 * has no winner at all.
 */
const SHAPES: [Table, boolean][][] = [
  [["sf_users", true], ["sf_accounts", false], ["sf_accounts", false], ["sf_contacts", false], ["sf_leads", false], ["sf_leads", false]],
  [["sf_accounts", true], ["sf_contacts", false]],
  [["sf_contacts", false], ["sf_leads", true]],
  [["sf_leads", true]],
  [["sf_accounts", true], ["sf_leads", false], ["sf_leads", false]],
  [["sf_leads", false], ["sf_leads", false]],
  [["sf_users", true], ["sf_contacts", false]],
];

function fixture(seed: number) {
  const r = prng(seed);
  const pickOf = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join("");
  const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;

  const sheet: MergeRow[] = SHAPES.flatMap((shape, g) => shape.map(([table, win]) => ({
    group_id: String(g + 1), group_label: `group ${g + 1}`, source_table: table, source_id: uuid(),
    email: "", handle: "", name: "", refs: "", proposed_winner: win ? "TRUE" : "FALSE", note: "",
  })));
  const linked = sheet.filter((m) => sheet.some((w) => w.group_id === m.group_id && w.proposed_winner === "TRUE"));

  const text = (col: string, g: string) =>
    pickOf([null, "", "", col === "email" ? `G${g}.${hex(3)}@Example.com` : `${col}-${hex(4)}`, `${col}-${hex(4)}`]);
  const date = () => new Date(Date.UTC(2026, Math.floor(r() * 9), 1 + Math.floor(r() * 27), Math.floor(r() * 24)));
  const some = <T>(xs: T[]) => Array.from({ length: Math.floor(r() * 4) }, () => pickOf(xs));

  const rows = sheet.map((m) => {
    const v: Record<string, any> = {};
    for (const col of COLUMNS[m.source_table]) {
      switch (col) {
        case "is_verified": v[col] = r() < 0.3; break;
        case "created_at": v[col] = date(); break;
        case "reset_password_expires": v[col] = r() < 0.5 ? null : date(); break;
        case "favorite_games": v[col] = some(["Catan", "Magic", "D&D", "Chess"]); break;
        case "friends": v[col] = some(linked.map((x) => x.source_id)); break;
        case "status": v[col] = pickOf(["New", "Contacted", "Qualified", "Lost", "Converted"]); break;
        case "role": v[col] = m.source_table === "sf_users" ? pickOf(["user", "admin"]) : text(col, m.group_id); break;
        default: v[col] = text(col, m.group_id);
      }
    }
    return { m, v };
  });

  // Keep the fixture valid, so both sides reach the comparison: every account
  // needs a password somewhere in its group, and NOT NULL text cannot be NULL.
  const notNull: Record<string, string[]> = {
    sf_users: ["password"], sf_accounts: ["name"], sf_contacts: ["name"],
    sf_leads: ["first_name", "last_name", "password", "source"],
  };
  for (const { m, v } of rows) for (const col of notNull[m.source_table]) v[col] ??= "";
  for (const g of new Set(linked.map((m) => m.group_id))) {
    const members = rows.filter((x) => x.m.group_id === g);
    if (!members.some((x) => x.v.password)) pickOf(members).v.password = `hash-${hex(8)}`;
  }
  return { sheet, rows, adminId: sheet[0].source_id };
}

async function seed(client: any, rows: ReturnType<typeof fixture>["rows"]) {
  await client.query(`TRUNCATE sf_users, sf_accounts, sf_contacts, sf_leads, accounts, account_source_links CASCADE`);
  for (const { m, v } of rows) {
    const cols = ["id", ...Object.keys(v)];
    await client.query(
      `INSERT INTO ${m.source_table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
      [m.source_id, ...Object.values(v)]);
  }
}

/** Everything both sides write, minus the two columns stamped with now(). */
async function snapshot(client: any) {
  const { rows: a } = await client.query(`SELECT to_jsonb(a) - 'updated_at' AS r FROM accounts a ORDER BY id`);
  const { rows: l } = await client.query(
    `SELECT to_jsonb(l) - 'linked_at' AS r FROM account_source_links l ORDER BY source_table, source_id`);
  return { accounts: a.map((x: any) => x.r), links: l.map((x: any) => x.r) };
}

async function runSql(client: any, stmts: string[]) {
  for (const s of stmts) await client.query(s);
}

function firstDiff(a: any[], b: any[]) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = JSON.stringify(a[i]), y = JSON.stringify(b[i]);
    if (x !== y) {
      const keys = Object.keys({ ...a[i], ...b[i] }).filter((k) => JSON.stringify(a[i]?.[k]) !== JSON.stringify(b[i]?.[k]));
      return `row ${i}: ${keys.map((k) => `${k}: ts=${JSON.stringify(a[i]?.[k])} sql=${JSON.stringify(b[i]?.[k])}`).join("; ")}`;
    }
  }
  return "";
}

async function main() {
  console.log("\nPhase 2 backfill — backfillSql vs runBackfill\n");
  const client = await pool.connect();
  const SEEDS = 40;
  let equal = 0, rowsCompared = 0;
  const problems: string[] = [];

  try {
    for (let s = 1; s <= SEEDS; s++) {
      const { sheet, rows, adminId } = fixture(s);
      await client.query("BEGIN");
      try {
        await seed(client, rows);
        await client.query("SAVEPOINT before");

        const result = await runBackfill(client, sheet, { adminId });
        const failed = result.assertions.filter((a) => !a.ok);
        if (failed.length) { problems.push(`seed ${s}: fixture fails runBackfill's own assertions: ${failed.map((a) => a.detail).join(" | ")}`); continue; }
        const ts = await snapshot(client);
        await client.query("ROLLBACK TO SAVEPOINT before");

        try {
          await runSql(client, backfillSql(sheet, adminId));
        } catch (e: any) {
          problems.push(`seed ${s}: the emitted SQL raised where runBackfill passed: ${e.message}`);
          continue;
        }
        const sql = await snapshot(client);

        rowsCompared += ts.accounts.length + ts.links.length;
        const d = firstDiff(ts.accounts, sql.accounts) || firstDiff(ts.links, sql.links);
        if (d) problems.push(`seed ${s}: ${d}`); else equal++;
      } finally {
        await client.query("ROLLBACK");
      }
    }
    check(`${SEEDS} random fixtures: accounts and links identical, row for row`, equal === SEEDS,
      problems.slice(0, 5).join("\n          "));
    console.log(`          (${rowsCompared} rows compared)`);

    // The emitted script must refuse everything runBackfill refuses.
    const { sheet, rows, adminId } = fixture(1);
    const refuses = async (name: string, setup: () => Promise<void>, stmts: () => string[], expect: RegExp) => {
      await client.query("BEGIN");
      try {
        await seed(client, rows);
        await setup();
        let msg = "";
        try { await runSql(client, stmts()); } catch (e: any) { msg = e.message; }
        check(name, expect.test(msg), msg ? `raised: ${msg}` : "did not raise");
      } finally {
        await client.query("ROLLBACK");
      }
    };

    await refuses("refuses an --admin that is not in the database (the pin must land)",
      async () => {}, () => backfillSql(sheet, "00000000-0000-4000-a000-000000000000"), /the admin pin landed/);

    await refuses("refuses a queued person_outbox rather than truncating it",
      async () => {
        await client.query(`INSERT INTO accounts (id) VALUES ($1)`, [adminId]);
        await client.query(`INSERT INTO person_outbox (account_id, op, payload) VALUES ($1, 'update', '{}')`, [adminId]);
      }, () => backfillSql(sheet, adminId), /person_outbox holds 1 queued/);

    await refuses("refuses a sheet row that is not in the database",
      async () => { await client.query(`DELETE FROM sf_contacts WHERE id = $1`, [sheet.find((m) => m.source_table === "sf_contacts")!.source_id]); },
      () => backfillSql(sheet, adminId), /sf_contacts row .* not found/);

    await refuses("refuses a person reference that resolves to no account",
      async () => { await client.query(`INSERT INTO notifications (user_id, type, title) VALUES ('00000000-0000-4000-a000-000000000001', 'system', 'x')`); },
      () => backfillSql(sheet, adminId), /every polymorphic person id resolves to an account: notifications\.user_id: 1/);
  } finally {
    client.release();
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
