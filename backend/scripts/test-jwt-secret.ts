/**
 * Test for one JWT secret, no fallback (GitHub #95).
 *
 * Every route that signed or verified a JWT used to read
 * `process.env.JWT_SECRET || "<the old default>"` for itself, and the boot
 * check only refused to start in production. So a dev box or a task with the
 * variable missing quietly accepted any token signed with a string that is
 * published in this repo. Now utils/jwt.ts is the only place that reads the
 * secret, it has no default, and the backend will not start without one.
 *
 * This checks:
 *   - the backend process exits with a clear error when JWT_SECRET is unset or
 *     still the old default, in development as well as production;
 *   - a token signed with any other secret (the old default included) gets a
 *     401 from a REST route and the SSE stream, a redirect to login from both
 *     admin portals, and a refused Google Calendar OAuth state;
 *   - with the secret set, a real login's token still opens a REST route and,
 *     for the admin, both admin portals;
 *   - with the secret removed at runtime nothing falls back: verification fails
 *     closed and login mints no token;
 *   - no other source file reads JWT_SECRET or carries the old default.
 *
 * Run against a throwaway database loaded from db/schema.sql (it inserts and
 * deletes its own rows, and refuses to run against anything but localhost).
 * It sets its own random JWT_SECRET, so none is needed on the command line:
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-jwt-secret.ts
 */
import express from "express";
import type { AddressInfo } from "net";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import jwt from "jsonwebtoken";
import pool from "../db/index.js";
import userRoutes from "../routes/userRoutes.js";
import adminRoutes from "../routes/adminRoutes.js";
import dbRoutes from "../routes/dbRoutes.js";
import messageRoutes from "../routes/messageRoutes.js";
import googleCalendarRoutes from "../routes/googleCalendarRoutes.js";
import { jwtSecretProblem, signJwt, verifyJwt } from "../utils/jwt.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
  process.exit(2);
}

// Spelled out in pieces so the source scan below can hold this file, too, to
// "never names the old default".
const OLD_DEFAULT = ["your", "secret", "key", "change", "this"].join("-");
const SECRET = `t95-${crypto.randomBytes(32).toString("hex")}`;
process.env.JWT_SECRET = SECRET;

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? pass++ : fail++;
}

/**
 * Start the real server.ts in a child process and report how it ended. It runs
 * from an empty temp directory so dotenv finds no .env to fill the gap, and on
 * ports of its own in case it does (wrongly) come up; the timeout then kills it.
 */
function boot(env: Record<string, string | undefined>) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "t95-boot-"));
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) childEnv[k] = v;
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete childEnv[k]; else childEnv[k] = v;
  childEnv.HTTP_PORT = "5995";
  childEnv.HTTPS_PORT = "5996";
  delete childEnv.REDIS_URL;
  const loader = pathToFileURL(path.join(backendDir, "node_modules", "tsx", "dist", "loader.mjs")).href;
  const r = spawnSync(process.execPath, ["--import", loader, path.join(backendDir, "server.ts")],
    { cwd, env: childEnv, encoding: "utf8", timeout: 45_000 });
  fs.rmSync(cwd, { recursive: true, force: true });
  return { code: r.status, timedOut: r.signal !== null, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

async function main() {
  // ── the rule itself ─────────────────────────────────────────────────────────
  check("an unset, empty or blank secret is a problem",
    !!jwtSecretProblem(undefined) && !!jwtSecretProblem("") && !!jwtSecretProblem("   "));
  check("the old default, and the example file's old placeholder, are problems",
    !!jwtSecretProblem(OLD_DEFAULT) && !!jwtSecretProblem("your-super-secret-jwt-key"));
  check("a real secret is not a problem", jwtSecretProblem(SECRET) === null, String(jwtSecretProblem(SECRET)));

  // ── boot refusal, in every environment ──────────────────────────────────────
  for (const NODE_ENV of ["development", "production"]) {
    for (const [label, value] of [["unset", undefined], ["the old default", OLD_DEFAULT]] as const) {
      const r = boot({ NODE_ENV, JWT_SECRET: value });
      check(`NODE_ENV=${NODE_ENV}: the backend exits with a clear error when JWT_SECRET is ${label}`,
        !r.timedOut && r.code !== 0 && /FATAL: JWT_SECRET/.test(r.out) && !/listening/i.test(r.out),
        `code=${r.code} timedOut=${r.timedOut}\n          ${r.out.trim().split("\n").slice(-4).join("\n          ")}`);
    }
  }

  // ── wrong-secret rejection on the live routers ──────────────────────────────
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use("/db", dbRoutes);
  app.use("/admin", adminRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/messages", messageRoutes);
  app.use("/api/google-calendar", googleCalendarRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (p: string, bearer?: string) => {
    const res = await fetch(`${base}${p}`, {
      redirect: "manual", headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
    const status = res.status, location = res.headers.get("location");
    await res.body?.cancel();
    return { status, location };
  };
  const login = async (email: string, password: string) => {
    const res = await fetch(`${base}/api/users/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    return { status: res.status, json: await res.json().catch(() => ({})) as any };
  };

  const tag = crypto.randomBytes(4).toString("hex");
  const email = `t95-admin-${tag}@example.test`, password = crypto.randomBytes(12).toString("hex");
  const created: string[] = [];
  try {
    const { rows: [admin] } = await pool.query(
      `INSERT INTO accounts (id, name, email, password, app_role, app_role_source, is_verified)
       VALUES (gen_random_uuid(), 'T95 Admin', $1, $2, 'admin', 'manual', true) RETURNING id`,
      [email, await bcrypt.hash(password, 10)]);
    created.push(admin.id);

    const li = await login(email, password);
    const token = li.json.token as string;
    const subject = (() => { try { return verifyJwt(token).id; } catch { return null; } })();
    check("with the secret set, login returns a token signed with it",
      li.status === 200 && subject === admin.id, `login ${li.status}, subject ${subject}`);

    const ok = await get("/api/users/profile", token);
    const portal = await get(`/admin?token=${encodeURIComponent(token)}`);
    const table = await get(`/db?token=${encodeURIComponent(token)}`);
    check("the login token opens a REST route and, for the admin, both admin portals",
      ok.status === 200 && portal.status === 200 && table.status === 200,
      `profile=${ok.status} /admin=${portal.status} /db=${table.status}`);

    const claims = { id: admin.id, email };
    for (const [label, key] of [["a different secret", `not-${SECRET}`], ["the old default", OLD_DEFAULT]] as const) {
      const forged = jwt.sign(claims, key, { expiresIn: "5m" });
      const rest = await get("/api/users/profile", forged);
      check(`a token signed with ${label} gets 401 on a REST route`, rest.status === 401, `got ${rest.status}`);

      const portals = await Promise.all(["/admin", "/db"].map((p) => get(`${p}?token=${encodeURIComponent(forged)}`)));
      check(`a token signed with ${label} is refused by both admin portals`,
        portals.every((r) => r.status === 302 && /login/.test(r.location ?? "")),
        portals.map((r) => `${r.status} ${r.location}`).join(", "));

      const sse = await get(`/api/messages/dm/${admin.id}/stream?token=${encodeURIComponent(forged)}`);
      check(`a token signed with ${label} gets 401 from the SSE stream`, sse.status === 401, `got ${sse.status}`);

      const state = jwt.sign({ id: admin.id, purpose: "gcal-connect" }, key, { expiresIn: "5m" });
      const cb = await get(`/api/google-calendar/callback?code=x&state=${encodeURIComponent(state)}`);
      check(`a Google Calendar OAuth state signed with ${label} is refused`,
        cb.status === 302 && /gcal=error/.test(cb.location ?? ""), `${cb.status} ${cb.location}`);
    }

    const state = jwt.verify(signJwt({ purpose: "gcal-connect" }, { expiresIn: "5m" }), SECRET) as any;
    check("signJwt signs with the configured secret", state.purpose === "gcal-connect");

    // ── no fallback when the secret goes missing at runtime ───────────────────
    for (const [label, value] of [["unset", undefined], ["the old default", OLD_DEFAULT]] as const) {
      if (value === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = value;
      const viaDefault = jwt.sign(claims, OLD_DEFAULT, { expiresIn: "5m" });
      const rest = await get("/api/users/profile", viaDefault);
      const portal2 = await get(`/admin?token=${encodeURIComponent(viaDefault)}`);
      const li2 = await login(email, password);
      let signed = true;
      try { signJwt({ id: admin.id }); } catch { signed = false; }
      check(`with JWT_SECRET ${label}, nothing signs or verifies with a fallback`,
        rest.status === 401 && portal2.status === 302 && !li2.json.token && !signed,
        `profile=${rest.status} /admin=${portal2.status} login=${li2.status} token=${!!li2.json.token} signJwt=${signed}`);
    }
    process.env.JWT_SECRET = SECRET;
  } finally {
    for (const id of created) await pool.query(`DELETE FROM accounts WHERE id = $1`, [id]);
    server.close();
  }

  // ── one module ──────────────────────────────────────────────────────────────
  const theModule = path.join(backendDir, "utils", "jwt.ts");
  // Files allowed to *set* JWT_SECRET: this test, and the test scripts' helper.
  const setters = ["test-jwt-secret.ts", "use-test-jwt-secret.ts"].map((f) => path.join(backendDir, "scripts", f));
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!["node_modules", "dist", ".git"].includes(e.name)) walk(p); continue; }
      if (!/\.(ts|js|cjs|mjs)$/.test(e.name)) continue;
      const src = fs.readFileSync(p, "utf8");
      const readsEnv = /process\.env\.JWT_SECRET|process\.env\[["']JWT_SECRET["']\]/.test(src);
      if (p === theModule) continue; // it reads the secret, and names the default to refuse it
      if (src.includes(OLD_DEFAULT) || (readsEnv && !setters.includes(p)))
        offenders.push(path.relative(backendDir, p));
    }
  };
  walk(backendDir);
  check("no file but utils/jwt.ts reads JWT_SECRET or names the old default",
    offenders.length === 0, offenders.join(", "));

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
