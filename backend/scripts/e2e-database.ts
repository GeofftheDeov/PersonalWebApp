/**
 * A database of its own for one end-to-end run (e2e/, #218), on the private
 * test cluster (scripts/pg-test-cluster.ts):
 *
 *   npx tsx scripts/e2e-database.ts create   build pwae2e_<time>_<random> from db/schema.sql, print its URL
 *   npx tsx scripts/e2e-database.ts drop <url-or-name>
 *   npx tsx scripts/e2e-database.ts verify-token <url-or-name> <email>   a verify link's token, as the email would carry it
 *
 * It loads schema.sql straight into the new database rather than cloning
 * run-tests.ts's template, which every `npm test` drops and rebuilds: a
 * parallel run in another worktree could pull that out from under a clone.
 *
 * `create` also drops the pwae2e_ databases more than a day old, which runs
 * that were killed before their teardown left behind. No run lasts that long,
 * not even one held open in Playwright's UI mode overnight.
 */
import crypto from "crypto";
import { connect, ensureCluster, loadSchema, url } from "./pg-test-cluster.js";

const PREFIX = "pwae2e_";
const STALE_S = 24 * 60 * 60;

async function create() {
  await ensureCluster();
  const admin = await connect();
  try {
    const now = Math.floor(Date.now() / 1000);
    const { rows } = await admin.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE 'pwae2e\\_%'");
    for (const { datname } of rows) {
      const made = Number(datname.slice(PREFIX.length).split("_")[0]);
      if (Number.isFinite(made) && now - made > STALE_S) await admin.query(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`);
    }
    const name = `${PREFIX}${now}_${crypto.randomBytes(4).toString("hex")}`;
    await admin.query(`CREATE DATABASE ${name}`);
    await loadSchema(name);
    console.log(url(name));
  } finally {
    await admin.end();
  }
}

async function drop(target: string) {
  const name = target.split("/").pop() ?? "";
  // Only ever one of ours: this runs DROP DATABASE on what it's given.
  if (!/^pwae2e_\d+_[0-9a-f]+$/.test(name)) throw new Error(`Not an end-to-end database: ${target}`);
  const admin = await connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/**
 * The verify link's token for an account that signed up and isn't verified,
 * as the email would carry it (#219): the stack sends no mail, and the
 * database keeps only the token's hash, so this issues a fresh one in its
 * place and prints it.
 */
async function verifyToken(target: string, email: string) {
  const name = target.split("/").pop() ?? "";
  if (!/^pwae2e_\d+_[0-9a-f]+$/.test(name)) throw new Error(`Not an end-to-end database: ${target}`);
  const token = crypto.randomBytes(20).toString("hex");
  const db = await connect(name);
  try {
    const { rowCount } = await db.query(
      `UPDATE accounts SET email_verification_token = $2 WHERE email = $1 AND is_verified = false`,
      [email, crypto.createHash("sha256").update(token).digest("hex")]);
    if (rowCount !== 1) throw new Error(`No unverified account for ${email}`);
    console.log(token);
  } finally {
    await db.end();
  }
}

const [command, arg, arg2] = process.argv.slice(2);
const run = command === "create" ? create()
  : command === "drop" && arg ? drop(arg)
  : command === "verify-token" && arg && arg2 ? verifyToken(arg, arg2)
  : null;
if (!run) {
  console.error("Usage: npx tsx scripts/e2e-database.ts create | drop <url-or-name> | verify-token <url-or-name> <email>");
  process.exit(2);
}
run.catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
