/**
 * The private Postgres cluster the tests run on: the backend suites
 * (scripts/run-tests.ts) and the end-to-end browser tests (scripts/e2e-database.ts,
 * for e2e/).
 *
 *   - It lives in %LOCALAPPDATA%/pwa-test-pg (~/.pwa-test-pg off Windows): trust
 *     auth, 127.0.0.1 only, port 5439, fsync off. It is created with initdb on
 *     first use and started with pg_ctl whenever it is down, and it lives outside
 *     the repo and Temp so no worktree or Temp sweep can delete its files while it
 *     runs. Port 5439 keeps it clear of the ad-hoc clusters agents start on 5433.
 *
 * Env: PWA_TEST_PG_PORT (5439), PWA_TEST_PG_DIR (the cluster's home), PG_BIN
 * (the directory holding initdb and pg_ctl; otherwise PATH, then the newest
 * C:/Program Files/PostgreSQL/<n>/bin).
 */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

export const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PORT = Number(process.env.PWA_TEST_PG_PORT ?? 5439);
const HOME = process.env.PWA_TEST_PG_DIR
  ?? (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "pwa-test-pg") : path.join(os.homedir(), ".pwa-test-pg"));
const DATA = path.join(HOME, "data");

/** A database's URL on the cluster. */
export const url = (db: string) => `postgresql://postgres@127.0.0.1:${PORT}/${db}`;

export function pgBin(): string {
  const exe = process.platform === "win32" ? ".exe" : "";
  const dirs = [process.env.PG_BIN, ...(process.env.PATH ?? "").split(path.delimiter)].filter(Boolean) as string[];
  const root = "C:/Program Files/PostgreSQL";
  if (process.platform === "win32" && fs.existsSync(root)) {
    const versions = fs.readdirSync(root).filter(v => /^\d+$/.test(v)).sort((a, b) => Number(b) - Number(a));
    dirs.push(...versions.map(v => path.join(root, v, "bin")));
  }
  const hit = dirs.find(d => fs.existsSync(path.join(d, `initdb${exe}`)) && fs.existsSync(path.join(d, `pg_ctl${exe}`)));
  if (!hit) throw new Error("Can't find initdb/pg_ctl. Install PostgreSQL or set PG_BIN to its bin directory.");
  return hit;
}

export async function connect(db = "postgres"): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url(db), connectionTimeoutMillis: 3000 });
  await c.connect();
  return c;
}

const samePath = (a: string, b: string) =>
  path.resolve(a).replace(/\\/g, "/").toLowerCase() === path.resolve(b).replace(/\\/g, "/").toLowerCase();

/** Resolves when the cluster answers on PORT; throws if something else holds the port. False when nothing does. */
async function clusterUp(): Promise<boolean> {
  try {
    const c = await connect();
    const dir = (await c.query("SHOW data_directory")).rows[0].data_directory as string;
    await c.end();
    if (!samePath(dir, DATA)) {
      throw new Error(`Port ${PORT} is held by another Postgres (data_directory ${dir}). Stop it or set PWA_TEST_PG_PORT.`);
    }
    return true;
  } catch (e: any) {
    if (e.code === "ECONNREFUSED") return false;
    throw e.message?.startsWith("Port ") ? e : new Error(`Port ${PORT} answers but not as the test cluster: ${e.message}`);
  }
}

/** Leaves the private cluster running on PORT, creating or starting it as needed. */
export async function ensureCluster(): Promise<void> {
  if (await clusterUp()) return;
  const bin = pgBin();
  if (!fs.existsSync(path.join(DATA, "PG_VERSION"))) {
    console.log(`  initdb ${DATA}`);
    fs.mkdirSync(HOME, { recursive: true });
    const r = spawnSync(path.join(bin, "initdb"), ["-D", DATA, "-U", "postgres", "-A", "trust", "-E", "UTF8", "--locale=C", "--no-instructions"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`initdb failed:\n${r.stdout}${r.stderr}`);
  }
  console.log(`  starting the test cluster on 127.0.0.1:${PORT}`);
  // stdio must not be piped: the server inherits it and outlives pg_ctl, which
  // would keep a pipe open forever. Its output goes to server.log instead.
  // Off Windows the socket goes in the cluster's home: Debian's and Ubuntu's
  // builds default to /var/run/postgresql, which only their postgres user may
  // write (the CI runner's case, .github/workflows/e2e.yml).
  const socket = process.platform === "win32" ? "" : ` -c unix_socket_directories=${HOME}`;
  const opts = `-p ${PORT} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off${socket}`;
  const r = spawnSync(path.join(bin, "pg_ctl"), ["start", "-w", "-D", DATA, "-l", path.join(HOME, "server.log"), "-o", opts], { stdio: "ignore" });
  // Another run (a parallel worktree's) may have started it a moment before us.
  if (r.status !== 0 && !(await clusterUp())) throw new Error(`pg_ctl start failed; see ${path.join(HOME, "server.log")}`);
}

export function stopCluster(): number {
  const r = spawnSync(path.join(pgBin(), "pg_ctl"), ["stop", "-D", DATA, "-m", "fast"], { stdio: "inherit" });
  return r.status ?? 1;
}

/** Drops and recreates a database, empty or as a copy of a template. */
export async function recreate(admin: pg.Client, db: string, template?: string) {
  await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${db}${template ? ` TEMPLATE ${template}` : ""}`);
}

/** Loads the current db/schema.sql into a database. */
export async function loadSchema(db: string) {
  const c = await connect(db);
  try {
    await c.query(fs.readFileSync(path.join(BACKEND, "db", "schema.sql"), "utf8"));
  } finally {
    await c.end();
  }
}
