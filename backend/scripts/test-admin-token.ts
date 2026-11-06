/**
 * Test for the admin portal's token (GitHub #210, spec #69).
 *
 * The browser no longer holds a JWT: the session cookie is HttpOnly and
 * nothing is kept in localStorage. The admin portal is server-rendered and
 * still takes `?token=` in its URL, and its pages call the API with that token
 * as a bearer. So the nav asks for one as the admin link is opened:
 * POST /api/users/me/admin-token.
 *
 * This checks, over HTTP against the real userRoutes and auth middleware:
 *   - an admin signed in by the cookie, with the CSRF header, gets a token
 *     that works as a bearer and names them;
 *   - without the CSRF header the cookie gets a 403 (another page on the
 *     parent domain can't mint one);
 *   - a signed-in person who isn't an admin gets a 403 and no token;
 *   - nobody signed in gets a 401.
 *
 * Run against a throwaway database loaded from db/schema.sql (it inserts and
 * deletes its own rows, and refuses to run against anything but localhost):
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-admin-token.ts
 */
import "./use-test-jwt-secret.js";
import express from "express";
import type { AddressInfo } from "net";
import crypto from "crypto";
import pool from "../db/index.js";
import userRoutes from "../routes/userRoutes.js";
import { COOKIE_TOKEN_CLAIM, signJwt, verifyJwt } from "../utils/jwt.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
  process.exit(2);
}

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? pass++ : fail++;
}

const NAME = "gtd_session_t210";

async function main() {
  process.env.SESSION_COOKIE_NAME = NAME;
  const app = express();
  app.use(express.json());
  app.use("/api/users", userRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call = async (method: string, path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers });
    return { status: res.status, json: await res.json().catch(() => ({})) as any };
  };

  const tag = crypto.randomBytes(4).toString("hex");
  const { rows: [admin] } = await pool.query(
    `INSERT INTO accounts (id, name, email, app_role, is_verified)
     VALUES (gen_random_uuid(), 'T210 Admin', $1, 'admin', true) RETURNING id, email`, [`t210-admin-${tag}@example.test`]);
  const { rows: [player] } = await pool.query(
    `INSERT INTO accounts (id, name, email, is_verified)
     VALUES (gen_random_uuid(), 'T210 Player', $1, true) RETURNING id, email`, [`t210-player-${tag}@example.test`]);
  // As login issues it since #212: marked as a cookie token, so it is refused as a bearer.
  const cookieFor = (p: { id: string; email: string }) =>
    `${NAME}=${signJwt({ id: p.id, email: p.email, [COOKIE_TOKEN_CLAIM]: true }, { expiresIn: "1h" })}`;

  try {
    const minted = await call("POST", "/api/users/me/admin-token", { cookie: cookieFor(admin), "x-requested-with": "gtd" });
    check("an admin signed in by the cookie gets a token", minted.status === 200 && typeof minted.json.token === "string",
      `${minted.status} ${JSON.stringify(minted.json)}`);
    if (typeof minted.json.token === "string") {
      const claims = verifyJwt(minted.json.token);
      check("the token names the admin", String(claims.id) === admin.id);
      check("the token is unmarked, so it works as a bearer (#212)", !(COOKIE_TOKEN_CLAIM in claims));
      const asBearer = await call("GET", "/api/users/profile", { authorization: `Bearer ${minted.json.token}` });
      check("the token works as a bearer", asBearer.status === 200 && asBearer.json.email === admin.email, `${asBearer.status}`);
    }

    const noCsrf = await call("POST", "/api/users/me/admin-token", { cookie: cookieFor(admin) });
    check("without the CSRF header the cookie gets a 403 and no token", noCsrf.status === 403 && !noCsrf.json.token, `${noCsrf.status}`);

    const notAdmin = await call("POST", "/api/users/me/admin-token", { cookie: cookieFor(player), "x-requested-with": "gtd" });
    check("someone who isn't an admin gets a 403 and no token", notAdmin.status === 403 && !notAdmin.json.token, `${notAdmin.status}`);

    const nobody = await call("POST", "/api/users/me/admin-token", { "x-requested-with": "gtd" });
    check("nobody signed in gets a 401", nobody.status === 401, `${nobody.status}`);
  } finally {
    await pool.query(`DELETE FROM accounts WHERE id = ANY($1)`, [[admin.id, player.id]]);
    // Closed before exiting: exiting mid-close trips a libuv assertion on Windows.
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
