/**
 * Threads module (#97): thread keys and the one access check.
 *
 * A thread is `campaign:<id>` (a campaign's Table Talk) or `dm:<dm_key>` (a
 * friend DM, dm_key being the sorted id pair). The module answers "which
 * threads can this person see" and "may this person into this thread".
 *
 * Run against a throwaway database loaded from db/schema.sql (it refuses to run
 * against anything but localhost):
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-threads.ts
 */
import pool from "../db/index.js";
import { visibleThreadKeys } from "../services/threads.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
  process.exit(2);
}

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? pass++ : fail++;
}

/** Keeps reruns against the same database clear of the unique email index. */
const RUN = Math.random().toString(36).slice(2, 8);

type Person = { id: string; email: string };

async function account(handle: string, appRole: "user" | "admin" = "user"): Promise<Person> {
  const { rows } = await pool.query(
    `INSERT INTO accounts (id, handle, name, email, app_role)
     VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id, email`,
    [`${handle}-${RUN}`, `${handle} name`, `${handle}.${RUN}@example.test`, appRole]);
  return { id: rows[0].id, email: rows[0].email };
}

async function campaign(title: string, status = "In Progress"): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO campaigns (title, status) VALUES ($1, $2) RETURNING id`, [`${title} ${RUN}`, status]);
  return rows[0].id;
}

async function member(campaignId: string, person: Person, status = "Active") {
  await pool.query(
    `INSERT INTO campaign_members (campaign_id, person_id, status) VALUES ($1, $2, $3)`,
    [campaignId, person.id, status]);
}

/** Friendship is symmetric: friendRoutes adds each side to the other's list. */
async function befriend(a: Person, b: Person) {
  await pool.query(`UPDATE accounts SET friends = array_append(friends, $2) WHERE id = $1`, [a.id, b.id]);
  await pool.query(`UPDATE accounts SET friends = array_append(friends, $2) WHERE id = $1`, [b.id, a.id]);
}

const dmKey = (a: Person, b: Person) => [a.id, b.id].sort().join(":");
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && new Set(a).size === a.length && b.every((x) => a.includes(x));

async function main() {
  const gm = await account("gm");
  const player = await account("player");
  const outsider = await account("outsider");
  const admin = await account("admin", "admin");
  const friend = await account("friend");

  const keep = await campaign("Curse of Strahd");
  const done = await campaign("Lost Mine", "Completed");
  for (const c of [keep, done]) {
    await member(c, gm, "Game Master");
    await member(c, player);
  }
  await befriend(player, friend);

  console.log("\nVisible threads\n");

  const playerKeys = await visibleThreadKeys(player);
  const expected = [`campaign:${keep}`, `campaign:${done}`, `dm:${dmKey(player, friend)}`];
  check("a member sees each campaign (whatever its status) and one DM per friend",
    sameSet(playerKeys, expected), `got ${JSON.stringify(playerKeys)}`);

  const outsiderKeys = await visibleThreadKeys(outsider);
  check("a non-member with no friends sees no threads", outsiderKeys.length === 0,
    `got ${JSON.stringify(outsiderKeys)}`);

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
