/**
 * Test for "a token is only good for what it was issued for" (GitHub #240).
 *
 * Every token is signed with the one JWT secret, and verifyJwt used to check
 * nothing but the signature. So the Google Calendar OAuth `state`
 * ({ id, purpose: 'gcal-connect' }, 10 minutes, carried through Google's
 * redirect URL) worked as a login: as a bearer token, at /admin?token= and
 * /db?token=, and on the live channel. Now a login token is one with no
 * `purpose` claim, every other kind names its own, and each verifier asks for
 * the kind it expects.
 *
 * This checks:
 *   - a gcal state is refused as a bearer token, in the session cookie, at
 *     /admin?token= and /db?token=, on the live channel, and at /api/accounts;
 *   - the Salesforce account-sync token is refused everywhere a login is
 *     wanted, and still opens /api/accounts;
 *   - a login token still opens a REST route, both admin portals, the live
 *     channel and /api/accounts, and is refused as a gcal state;
 *   - a real gcal state still gets through the callback's check.
 *
 * Run against a throwaway database loaded from db/schema.sql (it inserts and
 * deletes its own rows, and refuses to run against anything but localhost):
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-token-purpose.ts
 */
import "./use-test-jwt-secret.js";
import express from "express";
import type { AddressInfo } from "net";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import WebSocket from "ws";
import pool from "../db/index.js";
import userRoutes from "../routes/userRoutes.js";
import adminRoutes from "../routes/adminRoutes.js";
import dbRoutes from "../routes/dbRoutes.js";
import accountRoutes from "../routes/accountRoutes.js";
import googleCalendarRoutes from "../routes/googleCalendarRoutes.js";
import { attachLiveChannel, CLOSE_UNAUTHORIZED, LIVE_PATH, PROTOCOL_VERSION } from "../live/liveChannel.js";
import { signJwt, verifyJwt } from "../utils/jwt.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
  process.exit(2);
}

const COOKIE = "gtd_session_t240";
process.env.SESSION_COOKIE_NAME = COOKIE;

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? pass++ : fail++;
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use("/db", dbRoutes);
  app.use("/admin", adminRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/accounts", accountRoutes);
  app.use("/api/google-calendar", googleCalendarRoutes);
  const server = app.listen(0, "127.0.0.1");
  const live = await attachLiveChannel(server);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  /** Authenticates on the live channel; null when it stayed open (accepted), else the close code. */
  const liveCloseCode = (token: string) => new Promise<number | null>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${LIVE_PATH}`);
    const timer = setTimeout(() => { ws.terminate(); resolve(null); }, 1_500);
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", v: PROTOCOL_VERSION, token })));
    ws.on("error", () => { /* surfaces as close */ });
    ws.on("close", (code) => { clearTimeout(timer); resolve(code); });
  });
  const get = async (p: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${p}`, { redirect: "manual", headers });
    const status = res.status, location = res.headers.get("location");
    await res.body?.cancel();
    return { status, location };
  };
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const portalOpens = async (p: string, t: string) => (await get(`${p}?token=${encodeURIComponent(t)}`)).status === 200;
  /** What the gcal callback does with `state` when Google reports a denial: past the check it says "denied". */
  const callback = async (state: string) =>
    (await get(`/api/google-calendar/callback?error=access_denied&state=${encodeURIComponent(state)}`)).location ?? "";

  const tag = crypto.randomBytes(4).toString("hex");
  const email = `t240-admin-${tag}@example.test`, password = crypto.randomBytes(12).toString("hex");
  const created: string[] = [];
  try {
    const { rows: [admin] } = await pool.query(
      `INSERT INTO accounts (id, name, email, password, app_role, app_role_source, is_verified)
       VALUES (gen_random_uuid(), 'T240 Admin', $1, $2, 'admin', 'manual', true) RETURNING id`,
      [email, await bcrypt.hash(password, 10)]);
    created.push(admin.id);

    const li = await fetch(`${base}/api/users/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    const session = ((await li.json().catch(() => ({}))) as any).token as string;
    check("login returns a token", li.status === 200 && !!session, `login ${li.status}`);

    // The same shapes the app signs (googleCalendarRoutes /auth-url, scripts/generateJWT.ts).
    const gcal = signJwt({ id: admin.id, purpose: "gcal-connect", back: "availability" }, { expiresIn: "10m" });
    const sync = signJwt({ service: "salesforce", purpose: "account-sync" }, { expiresIn: "5m" });
    // A sync-shaped token that also names a subject, so a refusal can't be put down to "no id".
    const syncWithId = signJwt({ id: admin.id, purpose: "account-sync" }, { expiresIn: "5m" });

    // ── a login token: everything it opened before ────────────────────────────
    check("a login token opens a REST route as a bearer",
      (await get("/api/users/profile", bearer(session))).status === 200);
    check("a login token opens a REST route from the session cookie",
      (await get("/api/users/profile", { cookie: `${COOKIE}=${session}` })).status === 200);
    check("a login token opens /admin and /db for the admin",
      (await portalOpens("/admin", session)) && (await portalOpens("/db", session)));
    check("a login token stays connected on the live channel", (await liveCloseCode(session)) === null);
    check("a login token opens /api/accounts", (await get("/api/accounts", bearer(session))).status === 200);
    check("a login token is refused as a Google Calendar OAuth state", /gcal=error/.test(await callback(session)));

    // ── the gcal state: the callback, and nothing else ────────────────────────
    check("a gcal state still passes the callback's check", /gcal=denied/.test(await callback(gcal)),
      await callback(gcal));
    for (const [label, t] of [["a gcal state", gcal], ["an account-sync token", syncWithId]] as const) {
      const asBearer = await get("/api/users/profile", bearer(t));
      check(`${label} gets 401 as a bearer token`, asBearer.status === 401, `got ${asBearer.status}`);
      const asCookie = await get("/api/users/profile", { cookie: `${COOKIE}=${t}` });
      check(`${label} gets 401 from the session cookie`, asCookie.status === 401, `got ${asCookie.status}`);
      const portals = await Promise.all(["/admin", "/db"].map((p) => get(`${p}?token=${encodeURIComponent(t)}`)));
      check(`${label} is refused at /admin?token= and /db?token=`,
        portals.every((r) => r.status === 302 && /login/.test(r.location ?? "")),
        portals.map((r) => `${r.status} ${r.location}`).join(", "));
      const code = await liveCloseCode(t);
      check(`${label} is closed on the live channel (${CLOSE_UNAUTHORIZED})`, code === CLOSE_UNAUTHORIZED, `close ${code}`);
    }
    const gcalAccounts = await get("/api/accounts", bearer(gcal));
    check("a gcal state is refused at /api/accounts", gcalAccounts.status === 403, `got ${gcalAccounts.status}`);

    // ── the Salesforce token: /api/accounts only ──────────────────────────────
    const syncAccounts = await get("/api/accounts", bearer(sync));
    check("the account-sync token still opens /api/accounts", syncAccounts.status === 200, `got ${syncAccounts.status}`);
    check("the account-sync token is refused as a gcal state", /gcal=error/.test(await callback(syncWithId)));

    // ── the rule, directly ────────────────────────────────────────────────────
    const throws = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
    check("verifyJwt with no purpose takes a session token and refuses the others",
      !throws(() => verifyJwt(session)) && throws(() => verifyJwt(gcal)) && throws(() => verifyJwt(sync)));
    check("verifyJwt with a purpose takes only that kind",
      !throws(() => verifyJwt(gcal, { purpose: "gcal-connect" })) && throws(() => verifyJwt(session, { purpose: "gcal-connect" }))
      && throws(() => verifyJwt(sync, { purpose: "gcal-connect" })));
    check("an unknown purpose is refused everywhere",
      throws(() => verifyJwt(signJwt({ id: admin.id, purpose: "something-new" }), { purpose: ["session", "gcal-connect", "account-sync"] })));
  } finally {
    for (const id of created) await pool.query(`DELETE FROM accounts WHERE id = $1`, [id]);
    await live.close();
    server.close();
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
