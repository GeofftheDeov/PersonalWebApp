/**
 * Test for the session-cookie token marker (GitHub #212, spec #69 story 10).
 *
 * The session cookie reaches every host on the parent domain, Paperclip
 * included. If its JWT also worked as `Authorization: Bearer`, anything that
 * saw the cookie could replay it and skip the CSRF check. So a token written
 * into the cookie carries a marker claim, and every path that takes a token
 * from anywhere but the cookie refuses a marked one. The token in the response
 * body, for bearer clients, stays unmarked and keeps working.
 *
 * This checks, against the real userRoutes, auth middleware, admin portal and
 * live channel:
 *   - login and verify-email put a marked token in the cookie and an unmarked
 *     one in the body, both naming the person (Google login goes through the
 *     same issueSession, but needs a real Google ID token, so isn't driven here);
 *   - the marked token as `Authorization: Bearer` is a 401, on a read and a write;
 *   - the marked token in the cookie still authenticates, CSRF rules unchanged;
 *   - the unmarked body token works as a bearer token, as before;
 *   - the marked token in the admin portal's `?token=` is refused (redirect to login);
 *   - live channel: the marked token in the first-frame auth, or in `?token=`,
 *     is closed 4001; the same token in the cookie on the upgrade gets `ready`;
 *     the unmarked token in the first frame still gets `ready`.
 *
 * Run against a throwaway database loaded from db/schema.sql (it inserts and
 * deletes its own rows, and refuses to run against anything but localhost):
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-cookie-token.ts
 */
import "./use-test-jwt-secret.js";
import express from "express";
import http from "http";
import type { AddressInfo } from "net";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import WebSocket from "ws";
import pool from "../db/index.js";
import userRoutes from "../routes/userRoutes.js";
import adminRoutes from "../routes/adminRoutes.js";
import { auth } from "../middleware/auth.js";
import { hashToken } from "../utils/tokenHash.js";
import { COOKIE_TOKEN_CLAIM } from "../utils/jwt.js";
import { signupCookieName, signupCookieValue } from "../utils/signupCookie.js";
import { attachLiveChannel, LIVE_PATH, CLOSE_UNAUTHORIZED, PROTOCOL_VERSION } from "../live/liveChannel.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
  process.exit(2);
}

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? pass++ : fail++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
  return cond();
}

const NAME = "gtd_session_t212";
const ORIGIN = "https://deov.t212.example.test";
const AUTH_TIMEOUT_MS = 600;

/** The claims of a JWT, read without verifying (the server verifies; this only looks). */
const claims = (token: string): Record<string, unknown> => {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return {};
  }
};
const marked = (token: string) => COOKIE_TOKEN_CLAIM in claims(token);

/** The value of this environment's session cookie in a response's Set-Cookie headers. */
const cookieToken = (setCookie: string[]) => {
  const raw = setCookie.find((c) => c.startsWith(`${NAME}=`))?.slice(NAME.length + 1).split(";")[0] ?? "";
  return decodeURIComponent(raw);
};

function wsClient(url: string, opts: { cookie?: string; origin?: string; first?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.origin) headers.origin = opts.origin;
  const ws = new WebSocket(url, { headers });
  const frames: { type: string; [k: string]: any }[] = [];
  let closeCode: number | null = null, closeReason = "";
  ws.on("close", (code, reason) => { closeCode = code; closeReason = String(reason); });
  ws.on("error", () => { /* surfaces as close */ });
  ws.on("open", () => { if (opts.first !== undefined) ws.send(JSON.stringify(opts.first)); });
  ws.on("message", (data) => { try { frames.push(JSON.parse(String(data))); } catch { /* not ours */ } });
  return {
    ws,
    get closeCode() { return closeCode; },
    get closeReason() { return closeReason; },
    ready: () => until(() => frames.some((f) => f.type === "ready") || closeCode !== null)
      .then(() => frames.some((f) => f.type === "ready")),
    closed: () => until(() => closeCode !== null),
  };
}

async function main() {
  process.env.SESSION_COOKIE_NAME = NAME;
  process.env.SESSION_COOKIE_ORIGINS = ORIGIN;

  const app = express();
  app.use(express.json());
  app.use("/api/users", userRoutes);
  app.use("/admin", adminRoutes);
  app.post("/api/probe", auth, (req: any, res) => res.json({ id: req.user.id }));
  const server = http.createServer(app);
  const live = await attachLiveChannel(server, { authTimeoutMs: AUTH_TIMEOUT_MS });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}${LIVE_PATH}`;
  const sockets: ReturnType<typeof wsClient>[] = [];
  const openWs = (opts: Parameters<typeof wsClient>[1] = {}, url = wsUrl) => {
    const c = wsClient(url, opts); sockets.push(c); return c;
  };

  const call = async (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      redirect: "manual",
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, location: res.headers.get("location"), setCookie: res.headers.getSetCookie(),
      json: await res.json().catch(() => ({})) as any };
  };

  const tag = crypto.randomBytes(4).toString("hex");
  const email = `t212-${tag}@example.test`, password = crypto.randomBytes(12).toString("hex");
  const verifyToken = crypto.randomBytes(16).toString("hex");
  const created: string[] = [];
  const { rows: [person] } = await pool.query(
    `INSERT INTO accounts (id, name, email, password, is_verified, app_role)
     VALUES (gen_random_uuid(), 'T212 Admin', $1, $2, true, 'admin') RETURNING id`,
    [email, await bcrypt.hash(password, 10)]);
  created.push(person.id);
  const { rows: [newcomer] } = await pool.query(
    `INSERT INTO accounts (id, name, email, is_verified, email_verification_token)
     VALUES (gen_random_uuid(), 'T212 Newcomer', $1, false, $2) RETURNING id`,
    [`t212-new-${tag}@example.test`, hashToken(verifyToken)]);
  created.push(newcomer.id);

  try {
    // ── issuers: the cookie gets a marked token, the body an unmarked one ────
    console.log("\n  issuers");
    const login = await call("POST", "/api/users/login", {}, { email, password });
    const cookieTok = cookieToken(login.setCookie);
    const bodyTok = String(login.json.token ?? "");
    check("login: the cookie's token carries the marker", login.status === 200 && !!cookieTok && marked(cookieTok),
      `${login.status} ${JSON.stringify(claims(cookieTok))}`);
    check("login: the body's token does not", !!bodyTok && !marked(bodyTok), JSON.stringify(claims(bodyTok)));
    check("login: both name the same person",
      claims(cookieTok).id === person.id && claims(bodyTok).id === person.id);

    // From the browser that signed up, which verify-email requires to sign in (#219).
    const signedUpHere = `${signupCookieName()}=${encodeURIComponent(signupCookieValue(newcomer.id, Date.now() + 60_000))}`;
    const verified = await call("POST", "/api/users/verify-email", { cookie: signedUpHere }, { token: verifyToken });
    const vCookie = cookieToken(verified.setCookie), vBody = String(verified.json.token ?? "");
    check("verify-email: the cookie's token carries the marker, the body's does not",
      verified.status === 200 && marked(vCookie) && !!vBody && !marked(vBody) && claims(vCookie).id === newcomer.id,
      `${verified.status} cookie=${JSON.stringify(claims(vCookie))} body=${JSON.stringify(claims(vBody))}`);

    // ── the bearer path refuses a marked token ───────────────────────────────
    console.log("\n  bearer");
    const markedRead = await call("GET", "/api/users/profile", { authorization: `Bearer ${cookieTok}` });
    check("the cookie's token as a bearer token: 401 on a read", markedRead.status === 401, `${markedRead.status}`);
    const markedWrite = await call("POST", "/api/probe", { authorization: `Bearer ${cookieTok}` });
    check("the cookie's token as a bearer token: 401 on a write (no CSRF bypass)", markedWrite.status === 401,
      `${markedWrite.status}`);
    const markedBeside = await call("POST", "/api/probe",
      { authorization: `Bearer ${cookieTok}`, cookie: `${NAME}=${cookieTok}`, "x-requested-with": "gtd" });
    check("a marked bearer token beside a valid cookie is still a 401 (bearer is used when present)",
      markedBeside.status === 401, `${markedBeside.status}`);

    const bodyRead = await call("GET", "/api/users/profile", { authorization: `Bearer ${bodyTok}` });
    check("the body's token works as a bearer token, as before", bodyRead.status === 200 && bodyRead.json.email === email,
      `${bodyRead.status}`);
    const bodyWrite = await call("POST", "/api/probe", { authorization: `Bearer ${bodyTok}` });
    check("  and on a write, with no CSRF header", bodyWrite.status === 200 && bodyWrite.json.id === person.id,
      `${bodyWrite.status}`);

    // ── the cookie path still takes it ───────────────────────────────────────
    console.log("\n  cookie");
    const cookieRead = await call("GET", "/api/users/profile", { cookie: `${NAME}=${cookieTok}` });
    check("the cookie's token in the cookie authenticates a read", cookieRead.status === 200 && cookieRead.json.email === email,
      `${cookieRead.status}`);
    const cookieNoCsrf = await call("POST", "/api/probe", { cookie: `${NAME}=${cookieTok}` });
    check("  a write without the CSRF header is still a 403", cookieNoCsrf.status === 403, `${cookieNoCsrf.status}`);
    const cookieWrite = await call("POST", "/api/probe", { cookie: `${NAME}=${cookieTok}`, "x-requested-with": "gtd" });
    check("  and with it goes through", cookieWrite.status === 200 && cookieWrite.json.id === person.id,
      `${cookieWrite.status}`);

    // ── the admin portal's ?token= is a bearer path too ──────────────────────
    console.log("\n  admin portal ?token=");
    const portalMarked = await call("GET", `/admin?token=${encodeURIComponent(cookieTok)}`);
    check("the cookie's token in /admin?token= is refused (redirect to login)",
      portalMarked.status === 302 && /\/login$/.test(portalMarked.location ?? ""), `${portalMarked.status} ${portalMarked.location}`);
    const portalBody = await call("GET", `/admin?token=${encodeURIComponent(bodyTok)}`);
    check("  the body's token there still opens the portal", portalBody.status === 200,
      `${portalBody.status} ${portalBody.location ?? ""}`);

    // ── the live channel ─────────────────────────────────────────────────────
    console.log("\n  live channel");
    const frame = (token: string) => ({ type: "auth", v: PROTOCOL_VERSION, token });
    const firstFrame = openWs({ first: frame(cookieTok) });
    await firstFrame.closed();
    check("the cookie's token in the first-frame auth: closed 4001",
      firstFrame.closeCode === CLOSE_UNAUTHORIZED && firstFrame.closeReason === "unauthorized",
      `code ${firstFrame.closeCode} "${firstFrame.closeReason}"`);

    const query = openWs({}, `${wsUrl}?token=${encodeURIComponent(cookieTok)}`);
    await query.closed();
    check("the cookie's token in the upgrade's ?token=: closed 4001",
      query.closeCode === CLOSE_UNAUTHORIZED && query.closeReason === "unauthorized",
      `code ${query.closeCode} "${query.closeReason}"`);

    const viaCookie = openWs({ cookie: `${NAME}=${encodeURIComponent(cookieTok)}`, origin: ORIGIN });
    check("the cookie's token in the cookie on the upgrade: ready", await viaCookie.ready(),
      `code ${viaCookie.closeCode} "${viaCookie.closeReason}"`);

    const bodyFrame = openWs({ first: frame(bodyTok) });
    check("the body's token in the first-frame auth: ready, as before", await bodyFrame.ready(),
      `code ${bodyFrame.closeCode} "${bodyFrame.closeReason}"`);
  } finally {
    for (const s of sockets) s.ws.terminate();
    await live.close();
    await pool.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [created]);
    server.close();
    await pool.end();
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
