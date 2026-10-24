/**
 * Test for the session cookie (GitHub #69, cross-site login, backend slice).
 *
 * Login now also puts its JWT in an HttpOnly cookie, so the portfolio and
 * Hearthside (sibling subdomains proxying /api to this one backend) share one
 * login. Each environment reads only its own cookie name. A write
 * authenticated by the cookie must carry the CSRF header, and bearer requests
 * are unchanged.
 *
 * This checks, over HTTP against the real userRoutes and auth middleware:
 *   - with SESSION_COOKIE_NAME unset the cookie is off: login sets nothing and
 *     a cookie in the request authenticates nobody;
 *   - login issues the cookie with the right name, value and attributes;
 *   - the cookie alone authenticates a read;
 *   - the other environment's cookie name alone is unauthenticated;
 *   - a cookie-authenticated write without the CSRF header gets 403, and with
 *     it goes through; a bearer write needs no header;
 *   - an invalid cookie on a write is a 401 (log in again), not a 403;
 *   - logout clears the cookie on the same name, domain and path.
 *
 * Run against a throwaway database loaded from db/schema.sql (it inserts and
 * deletes its own rows, and refuses to run against anything but localhost):
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-session-cookie.ts
 */
import "./use-test-jwt-secret.js";
import express from "express";
import type { AddressInfo } from "net";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import pool from "../db/index.js";
import userRoutes from "../routes/userRoutes.js";
import { auth } from "../middleware/auth.js";
import { signJwt } from "../utils/jwt.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
  process.exit(2);
}

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? pass++ : fail++;
}

const NAME = "gtd_session_t69";
const OTHER_ENV_NAME = "gtd_session_t69_other";
const DOMAIN = ".example.test";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/users", userRoutes);
  // A stand-in write route behind the real middleware: what's under test is
  // which requests reach it.
  app.post("/api/probe", auth, (req: any, res) => res.json({ id: req.user.id }));
  return app;
}

async function main() {
  const server = buildApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call = async (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, setCookie: res.headers.getSetCookie(), json: await res.json().catch(() => ({})) as any };
  };

  const tag = crypto.randomBytes(4).toString("hex");
  const email = `t69-${tag}@example.test`, password = crypto.randomBytes(12).toString("hex");
  const { rows: [person] } = await pool.query(
    `INSERT INTO accounts (id, name, email, password, is_verified)
     VALUES (gen_random_uuid(), 'Cookie Tester', $1, $2, true) RETURNING id`,
    [email, await bcrypt.hash(password, 10)]);

  try {
    // ── cookie off ───────────────────────────────────────────────────────────
    delete process.env.SESSION_COOKIE_NAME;
    delete process.env.SESSION_COOKIE_DOMAIN;
    const offLogin = await call("POST", "/api/users/login", {}, { email, password });
    check("cookie off: login still returns a token, and sets no cookie",
      offLogin.status === 200 && !!offLogin.json.token && offLogin.setCookie.length === 0,
      `${offLogin.status} set-cookie=${JSON.stringify(offLogin.setCookie)}`);
    const offRead = await call("GET", "/api/users/profile", { cookie: `${NAME}=${offLogin.json.token}` });
    check("cookie off: a cookie in the request authenticates nobody", offRead.status === 401, `${offRead.status}`);

    // ── cookie on ────────────────────────────────────────────────────────────
    process.env.SESSION_COOKIE_NAME = NAME;
    process.env.SESSION_COOKIE_DOMAIN = DOMAIN;
    const login = await call("POST", "/api/users/login", {}, { email, password });
    const issued = login.setCookie.find((c) => c.startsWith(`${NAME}=`)) ?? "";
    const attrs = issued.split(";").map((s) => s.trim().toLowerCase());
    check("login sets the session cookie holding the same token as the body",
      login.status === 200 && issued.startsWith(`${NAME}=${login.json.token};`), issued || "(none)");
    check("the cookie is HttpOnly, Secure, SameSite=Lax, Path=/, on the parent domain, for 1h",
      ["httponly", "secure", "samesite=lax", "path=/", `domain=${DOMAIN}`, "max-age=3600"].every((a) => attrs.includes(a)),
      issued);

    const token = login.json.token as string;
    const cookie = `other=1; ${NAME}=${token}`;

    const read = await call("GET", "/api/users/profile", { cookie });
    check("the cookie alone authenticates a read", read.status === 200 && read.json.email === email,
      `${read.status} ${JSON.stringify(read.json).slice(0, 120)}`);

    const crossEnv = await call("GET", "/api/users/profile", { cookie: `${OTHER_ENV_NAME}=${token}` });
    check("only the other environment's cookie name is unauthenticated", crossEnv.status === 401, `${crossEnv.status}`);

    const noCsrf = await call("POST", "/api/probe", { cookie });
    check("a cookie-authenticated write without the CSRF header gets 403", noCsrf.status === 403, `${noCsrf.status}`);

    const wrongCsrf = await call("POST", "/api/probe", { cookie, "x-requested-with": "XMLHttpRequest" });
    check("the CSRF header must carry the expected value", wrongCsrf.status === 403, `${wrongCsrf.status}`);

    const withCsrf = await call("POST", "/api/probe", { cookie, "x-requested-with": "gtd" });
    check("with the CSRF header it goes through as the cookie's person",
      withCsrf.status === 200 && withCsrf.json.id === person.id, `${withCsrf.status} ${JSON.stringify(withCsrf.json)}`);

    const bearer = await call("POST", "/api/probe", { authorization: `Bearer ${token}` });
    check("a bearer write needs no CSRF header", bearer.status === 200 && bearer.json.id === person.id, `${bearer.status}`);

    const bearerFirst = await call("POST", "/api/probe", { authorization: "Bearer not-a-token", cookie, "x-requested-with": "gtd" });
    check("a bearer header is used when present, even beside a valid cookie", bearerFirst.status === 401, `${bearerFirst.status}`);

    const expired = signJwt({ id: person.id, email }, { expiresIn: -10 });
    const stale = await call("POST", "/api/probe", { cookie: `${NAME}=${expired}` });
    check("an expired cookie on a write is a 401, not a 403", stale.status === 401, `${stale.status}`);

    // ── logout ───────────────────────────────────────────────────────────────
    const out = await call("POST", "/api/users/logout", { cookie });
    const cleared = out.setCookie.find((c) => c.startsWith(`${NAME}=`)) ?? "";
    const clearedAttrs = cleared.split(";").map((s) => s.trim().toLowerCase());
    const expires = clearedAttrs.find((a) => a.startsWith("expires="));
    check("logout clears the cookie on the same name, domain and path",
      out.status === 204 && cleared.startsWith(`${NAME}=;`)
        && clearedAttrs.includes(`domain=${DOMAIN}`) && clearedAttrs.includes("path=/")
        && !!expires && new Date(expires.slice(8)).getTime() < Date.now(),
      `${out.status} ${cleared || "(none)"}`);
  } finally {
    await pool.query(`DELETE FROM accounts WHERE id = $1`, [person.id]);
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
