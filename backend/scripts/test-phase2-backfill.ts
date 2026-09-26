/**
 * Test for the Phase 2 backfill (#34) against a synthetic fixture.
 *
 * Builds the 40 landing rows the adjudication sheet describes into a throwaway
 * database made from db/schema.sql, runs the backfill, and checks the numbers
 * #34 committed to: 19 accounts, 39 links, JOHNNY SILVERHAND excluded, the two
 * Tyler Campbells kept apart, Geoff's two personas kept apart, the admin pin
 * applied, and tiers derived from provenance.
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest \
 *     npx tsx scripts/test-phase2-backfill.ts --csv ../person-merge-adjudication.csv
 *
 * The fixture only has to be shaped right, not real — it exercises the merge
 * logic. The sheet is the real one.
 */
import fs from "fs";
import path from "path";
import pool from "../db/index.js";
import { parseCsv, runBackfill, validate, type MergeRow } from "./phase2-backfill.js";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? pass++ : fail++;
}

/** Insert each CSV row as a landing row, filling only what its table has. */
async function seed(client: any, rows: MergeRow[]) {
  await client.query(`TRUNCATE sf_users, sf_accounts, sf_contacts, sf_leads,
                      accounts, account_source_links CASCADE`);
  for (const r of rows) {
    const email = r.email || null;
    const pw = `hashed:${r.source_id.slice(0, 8)}`;
    const isGeoffAdmin = r.source_table === "sf_users";
    switch (r.source_table) {
      case "sf_users":
        await client.query(
          `INSERT INTO sf_users (id, name, email, handle, password, role, is_verified)
           VALUES ($1,$2,$3,$4,$5,$6,true)`,
          [r.source_id, r.name || null, email, r.handle || null, pw, isGeoffAdmin ? "admin" : "user"]);
        break;
      case "sf_accounts":
        await client.query(
          `INSERT INTO sf_accounts (id, name, email, handle, password, company, is_verified)
           VALUES ($1,$2,$3,$4,$5,$6,true)`,
          [r.source_id, r.name || "unnamed", email, r.handle || null, pw, "Murray LLC"]);
        break;
      case "sf_contacts":
        await client.query(
          `INSERT INTO sf_contacts (id, name, email, handle, password, phone, is_verified)
           VALUES ($1,$2,$3,$4,$5,$6,true)`,
          [r.source_id, r.name || "unnamed", email, r.handle || null, pw, "555-0100"]);
        break;
      case "sf_leads": {
        const [first, ...rest] = (r.name || "A Lead").split(" ");
        await client.query(
          `INSERT INTO sf_leads (id, first_name, last_name, email, handle, password, is_verified)
           VALUES ($1,$2,$3,$4,$5,$6,true)`,
          [r.source_id, first, rest.join(" ") || "Lead", email, r.handle || null, pw]);
        break;
      }
    }
  }
}

async function main() {
  const csvArg = process.argv.indexOf("--csv");
  const csvPath = csvArg >= 0 ? process.argv[csvArg + 1]
    : path.resolve(process.cwd(), "..", "person-merge-adjudication.csv");
  const rows = parseCsv(fs.readFileSync(csvPath, "utf8")) as unknown as MergeRow[];

  console.log(`\nPhase 2 backfill — fixture test  (${rows.length} source rows)\n`);

  const client = await pool.connect();
  try {
    // ---- the sheet itself, before any database work
    const { groups, excluded } = validate(rows);
    check("sheet has 40 source rows", rows.length === 40, `got ${rows.length}`);
    check("sheet has 20 groups", groups.size === 20, `got ${groups.size}`);
    check("exactly one group is excluded", excluded.length === 1, `excluded: ${excluded.join(",")}`);

    await client.query("BEGIN");
    await seed(client, rows);
    const r = await runBackfill(client, rows);

    // ---- the counts #34 committed to
    check("19 accounts (not 20 — JOHNNY SILVERHAND never graduates)", r.accounts === 19, `got ${r.accounts}`);
    check("39 account_source_links", r.links === 39, `got ${r.links}`);

    for (const a of r.assertions) check(a.name, a.ok, a.detail);

    // ---- the adjudication rulings
    const { rows: geoff } = await client.query(
      `SELECT id, app_role, app_role_source, account_tier FROM accounts
        WHERE id = '62320595-fc13-5112-9cbb-25f094e08c0a'`);
    check("Geoff's admin persona is admin/manual/patron",
      geoff[0]?.app_role === "admin" && geoff[0]?.app_role_source === "manual" && geoff[0]?.account_tier === "patron",
      JSON.stringify(geoff[0] ?? null));

    const { rows: personas } = await client.query(`
      SELECT count(*)::int AS n FROM accounts
       WHERE id IN (SELECT source_id FROM account_source_links
                     WHERE account_id IN (SELECT id FROM accounts))
         AND (email = 'geoffrey.murray.1995@gmail.com' OR email = 'gdrumz@momurrays.com')`);
    check("Geoff's two personas stayed apart (2 accounts, not 1)", personas[0].n === 2, `got ${personas[0].n}`);

    const tylerIds = rows.filter((x) => x.group_label.startsWith("Tyler Campbell") && x.proposed_winner.toUpperCase() === "TRUE")
      .map((x) => x.source_id);
    const { rows: tylers } = await client.query(
      `SELECT count(*)::int AS n FROM accounts WHERE id = ANY($1::uuid[])`, [tylerIds]);
    check("the two Tyler Campbells are two accounts", tylers[0].n === 2 && tylerIds.length === 2,
      `${tylers[0].n} accounts from ${tylerIds.length} winners`);

    const johnny = rows.find((x) => x.group_label.includes("JOHNNY"))!;
    const { rows: j } = await client.query(
      `SELECT (SELECT count(*)::int FROM accounts WHERE id = $1) AS acct,
              (SELECT count(*)::int FROM account_source_links WHERE source_id = $1) AS link,
              (SELECT count(*)::int FROM sf_leads WHERE id = $1) AS landing`, [johnny.source_id]);
    check("JOHNNY SILVERHAND: no account, no link, landing row kept",
      j[0].acct === 0 && j[0].link === 0 && j[0].landing === 1, JSON.stringify(j[0]));

    // ---- tiers follow provenance, not the person
    const { rows: tiers } = await client.query(
      `SELECT sf_object, account_tier, count(*)::int AS n FROM accounts GROUP BY 1,2 ORDER BY 1`);
    const map: Record<string, string> = { User: "patron", Account: "patron", Contact: "member", Lead: "free" };
    check("account_tier derived from sf_object for every account",
      tiers.every((t: any) => t.account_tier === map[t.sf_object]),
      tiers.map((t: any) => `${t.sf_object}=${t.account_tier}(${t.n})`).join(" "));

    // ---- re-running must be idempotent; #34 expects it to be re-run
    const first = await client.query(`SELECT id, app_role, account_tier FROM accounts ORDER BY id`);
    await runBackfill(client, rows);
    const second = await client.query(`SELECT id, app_role, account_tier FROM accounts ORDER BY id`);
    check("re-running produces an identical result",
      JSON.stringify(first.rows) === JSON.stringify(second.rows), "second run differed");

    // ---- reversal
    await client.query("TRUNCATE accounts, account_source_links CASCADE");
    const { rows: after } = await client.query(
      `SELECT (SELECT count(*)::int FROM accounts) AS a,
              (SELECT count(*)::int FROM sf_accounts) AS landing`);
    check("TRUNCATE reverses it and leaves the landing tables intact",
      after[0].a === 0 && after[0].landing === 18, JSON.stringify(after[0]));

    await client.query("ROLLBACK");
  } catch (e: any) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`\n  ERROR: ${e.message}\n`);
    fail++;
  } finally {
    client.release();
    await pool.end();
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
