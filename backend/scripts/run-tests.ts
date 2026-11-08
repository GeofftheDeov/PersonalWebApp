/**
 * Runs the scripts/test-*.ts suites, each against its own throwaway database.
 *
 * Every database suite wants a fresh database built from db/schema.sql on a
 * local Postgres, and until now each session worked out how to get one: a
 * docker postgres:16 (when Docker Desktop would start), the installed
 * PostgreSQL 18, or a cluster initdb'd into a scratchpad that Temp cleanup
 * later pulled files out from under. This script owns all of that:
 *
 *   - a private cluster on 127.0.0.1:5439, created and started on demand
 *     (scripts/pg-test-cluster.ts, which the end-to-end tests share).
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
 * Env: PWA_TEST_PG_PORT, PWA_TEST_PG_DIR, PG_BIN (see scripts/pg-test-cluster.ts).
 */
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import type pg from "pg";
import { BACKEND, connect, ensureCluster, loadSchema, recreate, stopCluster, url } from "./pg-test-cluster.js";

const SCRIPTS = path.join(BACKEND, "scripts");
const TEMPLATE = "pwatest_tpl";

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

// ---------------------------------------------------------------- template

async function buildTemplate(admin: pg.Client) {
  await recreate(admin, TEMPLATE);
  await loadSchema(TEMPLATE);
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
  if (STOP) process.exit(stopCluster());

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
