/**
 * Runs the scripts/test-*.ts suites, each against its own throwaway database.
 *
 * Every database suite wants a fresh database built from db/schema.sql on a
 * local Postgres, and until now each session worked out how to get one: a
 * docker postgres:16 (when Docker Desktop would start), the installed
 * PostgreSQL 18, or a cluster initdb'd into a scratchpad that Temp cleanup
 * later pulled files out from under. This script owns all of that:
 *
 *   - a private cluster in %LOCALAPPDATA%/pwa-test-pg (~/.pwa-test-pg off
 *     Windows): trust auth, 127.0.0.1 only, port 5439, fsync off. It is created
 *     with initdb on first use and started with pg_ctl whenever it is down, and
 *     it lives outside the repo and Temp so no worktree or Temp sweep can
 *     delete its files while it runs. Port 5439 keeps it clear of the ad-hoc
 *     clusters agents start on 5433.
 *   - a template database built from the current schema.sql once per run,
 *     cloned into pwatest_<suite> for each suite and dropped afterwards.
 *
 * Which suites run is read from each suite's own header: the documented
 * `npx tsx scripts/test-<name>.ts` line. A suite whose line sets nothing but
 * DATABASE_URL (or nothing at all) runs unattended. One that also needs a
 * Redis, CSV arguments or several databases is reported as manual, with the
 * command from its header.
 *
 *   npm test                            every unattended suite
 *   npm test -- person-refs threads     just these (the test- prefix is optional)
 *   npm test -- --list                  which suites run, which are manual and why
 *   npm test -- --url                   rebuild database `pwatest`, print its URL
 *   npm test -- -j 4                    four suites at a time
 *   npm test -- --keep person-refs      keep the suite's database for inspection
 *   npm test -- --stop                  stop the cluster
 *
 * Env: PWA_TEST_PG_PORT (5439), PWA_TEST_PG_DIR (the cluster's home), PG_BIN
 * (the directory holding initdb and pg_ctl; otherwise PATH, then the newest
 * C:/Program Files/PostgreSQL/<n>/bin).
 */
import { spawn, spawnSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(BACKEND, "scripts");
const PORT = Number(process.env.PWA_TEST_PG_PORT ?? 5439);
const HOME = process.env.PWA_TEST_PG_DIR
  ?? (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "pwa-test-pg") : path.join(os.homedir(), ".pwa-test-pg"));
const DATA = path.join(HOME, "data");
const TEMPLATE = "pwatest_tpl";
const url = (db: string) => `postgresql://postgres@127.0.0.1:${PORT}/${db}`;

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
const option = (name: string) => { const i = argv.indexOf(name); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const LIST = flag("--list"), URL_ONLY = flag("--url"), KEEP = flag("--keep"), STOP = flag("--stop");
const JOBS = Math.max(1, Number(option("-j") ?? 1));
const TIMEOUT_S = Number(option("--timeout") ?? 180);
const unknown = argv.find(a => a.startsWith("-"));
if (unknown) { console.error(`Unknown option ${unknown}. See the header of scripts/run-tests.ts.`); process.exit(2); }
const wanted = argv.map(a => a.replace(/^test-/, "").replace(/\.ts$/, ""));

// ---------------------------------------------------------------- suites

type Suite = { name: string; file: string; kind: "db" | "pure" | "manual"; why?: string; command?: string };

/** Reads the suite's header for its run line and decides whether it runs unattended. */
function classify(file: string): Suite {
  const name = path.basename(file, ".ts").replace(/^test-/, "");
  const header = fs.readFileSync(file, "utf8").match(/^\/\*\*([\s\S]*?)\*\//)?.[1] ?? "";
  const lines = header.split("\n").map(l => l.replace(/^\s*\*\s?/, "").trim());
  const joined: string[] = [];
  for (const l of lines) {
    const prev = joined.at(-1);
    if (prev?.endsWith("\\")) joined[joined.length - 1] = prev.slice(0, -1).trim() + " " + l;
    else joined.push(l);
  }
  const self = `scripts/${path.basename(file)}`;
  const run = joined.find(l => l.includes(`npx tsx ${self}`));
  if (!run) return { name, file, kind: "manual", why: "no `npx tsx` run line in its header" };
  const command = run.slice(run.search(/[A-Z][A-Z0-9_]*=|npx/)).trim();
  const [before, after = ""] = command.split(self);
  const env = [...before.matchAll(/([A-Z][A-Z0-9_]*)=/g)].map(m => m[1]);
  const extra = env.filter(k => k !== "DATABASE_URL");
  if (extra.length) return { name, file, kind: "manual", why: `needs ${extra.join(", ")}`, command };
  if (after.trim()) return { name, file, kind: "manual", why: `takes arguments (${after.trim()})`, command };
  return { name, file, kind: env.includes("DATABASE_URL") ? "db" : "pure", command };
}

const suites = fs.readdirSync(SCRIPTS)
  .filter(f => /^test-.*\.ts$/.test(f))
  .sort()
  .map(f => classify(path.join(SCRIPTS, f)));

if (LIST) {
  for (const s of suites) console.log(`  ${s.kind.padEnd(6)} ${s.name}${s.why ? `  -- ${s.why}` : ""}`);
  process.exit(0);
}

let selected: Suite[];
if (wanted.length) {
  const missing = wanted.filter(w => !suites.some(s => s.name === w));
  if (missing.length) { console.error(`No suite named ${missing.join(", ")}. Try --list.`); process.exit(2); }
  // Named suites run even when their header says manual: the caller asked for them.
  selected = suites.filter(s => wanted.includes(s.name));
} else {
  selected = suites.filter(s => s.kind !== "manual");
}

// ---------------------------------------------------------------- cluster

function pgBin(): string {
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

async function connect(db = "postgres"): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url(db), connectionTimeoutMillis: 3000 });
  await c.connect();
  return c;
}

const samePath = (a: string, b: string) =>
  path.resolve(a).replace(/\\/g, "/").toLowerCase() === path.resolve(b).replace(/\\/g, "/").toLowerCase();

/** Leaves the private cluster running on PORT, creating or starting it as needed. */
async function ensureCluster(): Promise<void> {
  try {
    const c = await connect();
    const dir = (await c.query("SHOW data_directory")).rows[0].data_directory as string;
    await c.end();
    if (!samePath(dir, DATA)) {
      throw new Error(`Port ${PORT} is held by another Postgres (data_directory ${dir}). Stop it or set PWA_TEST_PG_PORT.`);
    }
    return;
  } catch (e: any) {
    if (e.code !== "ECONNREFUSED") throw e.message?.startsWith("Port ") ? e : new Error(`Port ${PORT} answers but not as the test cluster: ${e.message}`);
  }
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
  const opts = `-p ${PORT} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off`;
  const r = spawnSync(path.join(bin, "pg_ctl"), ["start", "-w", "-D", DATA, "-l", path.join(HOME, "server.log"), "-o", opts], { stdio: "ignore" });
  if (r.status !== 0) throw new Error(`pg_ctl start failed; see ${path.join(HOME, "server.log")}`);
}

async function recreate(admin: pg.Client, db: string, template?: string) {
  await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${db}${template ? ` TEMPLATE ${template}` : ""}`);
}

async function buildTemplate(admin: pg.Client) {
  await recreate(admin, TEMPLATE);
  const c = await connect(TEMPLATE);
  try {
    await c.query(fs.readFileSync(path.join(BACKEND, "db", "schema.sql"), "utf8"));
  } finally {
    await c.end();
  }
}

// ---------------------------------------------------------------- running

type Result = { suite: Suite; ok: boolean; seconds: number; output: string };

function runSuite(suite: Suite, databaseUrl?: string): Promise<Result> {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: "1" };
  // A Redis or database from the caller's shell must not leak into a suite
  // that is meant to run on its own throwaway database and the in-memory bus.
  delete env.REDIS_URL;
  delete env.EVENT_BUS_NAMESPACE;
  delete env.DATABASE_URL;
  if (databaseUrl) env.DATABASE_URL = databaseUrl;
  // What scripts/use-test-jwt-secret.ts does, for the suites that don't import
  // it: a worktree has no backend/.env, and utils/jwt.ts has no default.
  env.JWT_SECRET ||= `test-${crypto.randomBytes(32).toString("hex")}`;
  const tsx = path.join(BACKEND, "node_modules", "tsx", "dist", "cli.mjs");
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn(process.execPath, [tsx, path.relative(BACKEND, suite.file)], { cwd: BACKEND, env });
    let output = "";
    child.stdout.on("data", d => (output += d));
    child.stderr.on("data", d => (output += d));
    const timer = setTimeout(() => { output += `\n  (killed after ${TIMEOUT_S}s)`; child.kill(); }, TIMEOUT_S * 1000);
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ suite, ok: code === 0, seconds: (Date.now() - started) / 1000, output });
    });
  });
}

const dbName = (s: Suite) => `pwatest_${s.name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;

async function main() {
  if (STOP) {
    const r = spawnSync(path.join(pgBin(), "pg_ctl"), ["stop", "-D", DATA, "-m", "fast"], { stdio: "inherit" });
    process.exit(r.status ?? 1);
  }

  const needsDb = URL_ONLY || selected.some(s => s.kind !== "pure");
  let admin: pg.Client | undefined;
  if (needsDb) {
    await ensureCluster();
    admin = await connect();
    await buildTemplate(admin);
  }

  if (URL_ONLY) {
    await recreate(admin!, "pwatest", TEMPLATE);
    await admin!.end();
    console.log(url("pwatest"));
    return;
  }

  const results: Result[] = [];
  const queue = [...selected];
  async function worker() {
    for (let s = queue.shift(); s; s = queue.shift()) {
      let databaseUrl: string | undefined;
      if (s.kind !== "pure") {
        await recreate(admin!, dbName(s), TEMPLATE);
        databaseUrl = url(dbName(s));
      }
      const r = await runSuite(s, databaseUrl);
      if (databaseUrl && !KEEP) await admin!.query(`DROP DATABASE IF EXISTS ${dbName(s)} WITH (FORCE)`);
      results.push(r);
      console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${s.name.padEnd(32)} ${r.seconds.toFixed(1)}s${KEEP && databaseUrl ? `  ${databaseUrl}` : ""}`);
      if (!r.ok) console.log(r.output.trimEnd().split("\n").slice(-25).map(l => `        ${l}`).join("\n"));
    }
  }
  await Promise.all(Array.from({ length: Math.min(JOBS, selected.length) }, worker));
  await admin?.end();

  const failed = results.filter(r => !r.ok);
  console.log(`\n  ${results.length - failed.length} passed, ${failed.length} failed`);
  if (!wanted.length) {
    const manual = suites.filter(s => s.kind === "manual");
    if (manual.length) {
      console.log(`\n  Not run (need more than a database; run by name to try anyway):`);
      for (const s of manual) console.log(`    ${s.name.padEnd(28)} ${s.why}`);
    }
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error(`\n  ${e.message ?? e}\n`); process.exit(2); });
