/**
 * Probe: does the Phase 2 backfill put the RIGHT Salesforce Id on each
 * account_source_links row?
 *
 * The fixture test seeds landing rows with no sf_id / sf_lead_id at all, so
 * every link's sf_id comes out NULL there and a wrong value cannot show. This
 * probe seeds a distinct, realistic Salesforce Id on every landing row — which
 * is what the real dev database looks like — and then asks the obvious
 * question of each link: is this the Salesforce Id of MY source row?
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest \
 *     npx tsx scripts/test-phase2-gaps.ts --csv ../person-merge-adjudication.csv
 */
import fs from "fs";
import path from "path";
import pool from "../db/index.js";
import { parseCsv, runBackfill, type MergeRow } from "./phase2-backfill.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n          ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

/** A stable, per-row fake Salesforce Id — 18 chars, prefixed by object type. */
const PREFIX: Record<string, string> = {
  sf_users: "005", sf_accounts: "001", sf_contacts: "003", sf_leads: "00Q",
};
const sfIdFor = (r: MergeRow) =>
  PREFIX[r.source_table] + r.source_id.replace(/-/g, "").slice(0, 15);

async function seed(client: any, rows: MergeRow[]) {
  await client.query(`TRUNCATE sf_users, sf_accounts, sf_contacts, sf_leads,
                      accounts, account_source_links CASCADE`);
  for (const r of rows) {
    const email = r.email || null;
    const pw = `hashed:${r.source_id.slice(0, 8)}`;
    const sfId = sfIdFor(r);
    switch (r.source_table) {
      case "sf_users":
        await client.query(
          `INSERT INTO sf_users (id, name, email, handle, password, role, is_verified, sf_id)
           VALUES ($1,$2,$3,$4,$5,'admin',true,$6)`,
          [r.source_id, r.name || null, email, r.handle || null, pw, sfId]);
        break;
      case "sf_accounts":
        await client.query(
          `INSERT INTO sf_accounts (id, name, email, handle, password, company, is_verified, sf_id)
           VALUES ($1,$2,$3,$4,$5,'Murray LLC',true,$6)`,
          [r.source_id, r.name || "unnamed", email, r.handle || null, pw, sfId]);
        break;
      case "sf_contacts":
        await client.query(
          `INSERT INTO sf_contacts (id, name, email, handle, password, phone, is_verified, sf_id)
           VALUES ($1,$2,$3,$4,$5,'555-0100',true,$6)`,
          [r.source_id, r.name || "unnamed", email, r.handle || null, pw, sfId]);
        break;
      case "sf_leads": {
        const [first, ...rest] = (r.name || "A Lead").split(" ");
        await client.query(
          `INSERT INTO sf_leads (id, first_name, last_name, email, handle, password, is_verified, sf_lead_id)
           VALUES ($1,$2,$3,$4,$5,$6,true,$7)`,
          [r.source_id, first, rest.join(" ") || "Lead", email, r.handle || null, pw, sfId]);
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
  const expected = new Map(rows.map((r) => [`${r.source_table}:${r.source_id}`, sfIdFor(r)]));

  console.log(`\nProbe — Salesforce Id fidelity through the Phase 2 backfill\n`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await seed(client, rows);
    const result = await runBackfill(client, rows);
    check("backfill still produces 19 accounts / 39 links",
      result.accounts === 19 && result.links === 39,
      `${result.accounts} accounts, ${result.links} links`);

    // ---- 1. every link should carry ITS OWN source row's Salesforce Id
    const { rows: links } = await client.query(
      `SELECT source_table, source_id::text, sf_id, sf_object, is_primary
         FROM account_source_links ORDER BY source_table, source_id`);
    const wrong = links.filter(
      (l: any) => l.sf_id !== expected.get(`${l.source_table}:${l.source_id}`));
    check("every account_source_links row carries its own source row's sf_id",
      wrong.length === 0,
      wrong.length === 0 ? "" :
        `${wrong.length} of ${links.length} links carry another row's Salesforce Id, e.g.\n` +
        wrong.slice(0, 4).map((l: any) =>
          `            ${l.source_table} ${l.source_id.slice(0, 8)} ` +
          `has ${l.sf_id}, should be ${expected.get(`${l.source_table}:${l.source_id}`)}`).join("\n"));

    // How bad: does (sf_object, sf_id) still identify one Salesforce record?
    const { rows: collide } = await client.query(
      `SELECT sf_object, sf_id, count(*)::int AS n
         FROM account_source_links GROUP BY 1,2 HAVING count(*) > 1 ORDER BY 3 DESC`);
    check("(sf_object, sf_id) identifies at most one link — write-back can target a record",
      collide.length === 0,
      collide.length === 0 ? "" :
        `${collide.length} colliding pair(s): ` +
        collide.slice(0, 3).map((c: any) => `${c.sf_object}/${c.sf_id} x${c.n}`).join(", "));

    // Cross-object contamination is the sharp edge: a Contact link holding an
    // Account's 001 Id would make a write-back update the wrong SF object.
    const { rows: mismatched } = await client.query(
      `SELECT count(*)::int AS n FROM account_source_links
        WHERE sf_id IS NOT NULL AND left(sf_id,3) <> CASE sf_object
          WHEN 'User' THEN '005' WHEN 'Account' THEN '001'
          WHEN 'Contact' THEN '003' WHEN 'Lead' THEN '00Q' END`);
    check("no link points sf_object at a different object's Salesforce Id",
      mismatched[0].n === 0, `${mismatched[0].n} link(s) mismatched`);

    // ---- 2. the account itself should carry the winner's Salesforce Id
    const { rows: accts } = await client.query(
      `SELECT a.id::text, a.sf_object, a.sf_id, l.source_table, l.source_id::text
         FROM accounts a JOIN account_source_links l
           ON l.account_id = a.id AND l.is_primary`);
    const badAcct = accts.filter(
      (a: any) => a.sf_id !== expected.get(`${a.source_table}:${a.source_id}`));
    check("every account carries its winning source row's sf_id",
      badAcct.length === 0,
      badAcct.length === 0 ? "" : `${badAcct.length} of ${accts.length} accounts wrong`);

    // ---- 3. the sf_leads naming difference the PR claims to have handled
    const { rows: leadAcct } = await client.query(
      `SELECT a.sf_id FROM accounts a JOIN account_source_links l
         ON l.account_id = a.id AND l.is_primary
        WHERE l.source_table = 'sf_leads'`);
    check("a Lead-won account picks up sf_lead_id (not NULL)",
      leadAcct.length > 0 && leadAcct.every((r: any) => r.sf_id),
      leadAcct.map((r: any) => String(r.sf_id)).join(", ") || "no Lead-won account");

    // ---- 4. the backfill must not silently discard the write-back queue.
    // person_outbox FKs accounts, so `TRUNCATE ... CASCADE` reaches it.
    await client.query(
      `INSERT INTO person_outbox (account_id, op, payload)
       SELECT id, 'create', '{}'::jsonb FROM accounts LIMIT 1`);
    let refused = "";
    try {
      await runBackfill(client, rows);
    } catch (e: any) { refused = e.message; }
    check("a re-run refuses while person_outbox holds queued write-backs",
      /person_outbox holds 1 queued/.test(refused),
      refused || "the re-run proceeded and truncated the queue");

    await client.query("ROLLBACK");
    console.log(`\n  ${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
  } catch (e: any) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`\n  ERROR: ${e.message}\n`);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}
main();
