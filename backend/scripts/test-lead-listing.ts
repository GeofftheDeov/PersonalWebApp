/**
 * Regression test: GET /api/leads and GET /api/leads/:id served the sf_leads
 * landing table to anyone (#262).
 *
 * server.ts mounts /api/leads with no auth, because POST / is signup. The two
 * listing handlers beside it had none either, so anybody on the internet got
 * every sf_leads row whole: names, emails and phones, and also password,
 * reset_password_token and email_verification_token, which rows from before
 * the #35 cutover may still hold. Nothing called them, and admins browse
 * sf_leads through /db, so they were deleted rather than gated.
 *
 * This seeds an sf_leads row with values in the secret columns, then asks for
 * it every way: no token, a public signup's token, and the admin's. None of
 * them may get a row back. Signup itself (POST /api/leads) must still work, and
 * the admin must still see the row in /db/sf_leads.
 *
 * Mounts the real routers the way server.ts does and drives them over HTTP.
 *
 * Run against a throwaway database loaded from db/schema.sql (it inserts and
 * deletes its own rows, and refuses to run against anything but localhost):
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-lead-listing.ts
 */
import "./use-test-jwt-secret.js";
import express from "express";
import type { AddressInfo } from "net";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import pool from "../db/index.js";
import userRoutes from "../routes/userRoutes.js";
import leadRoutes from "../routes/leadRoutes.js";
import dbRoutes from "../routes/dbRoutes.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
  process.exit(2);
}

// Signup mails a verification link outside development; keep every send on
// emailService's mock branch, and sign up as dev so the account is verified.
delete process.env.EMAIL_PASS;
process.env.NODE_ENV = "development";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? pass++ : fail++;
}

/** The same middleware stack server.ts puts in front of these routers. */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use("/db", dbRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/leads", leadRoutes);
  return app;
}

async function main() {
  const server = buildApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const get = async (path: string, token?: string) => {
    const res = await fetch(`${base}${path}`, {
      redirect: "manual", headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: await res.text() };
  };
  const postJson = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => ({})) as any };
  };
  const login = async (email: string, password: string) => {
    const r = await postJson("/api/users/login", { email, password });
    if (r.status !== 200 || !r.json.token) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json.token as string;
  };

  const tag = crypto.randomBytes(4).toString("hex");
  const pw = () => crypto.randomBytes(12).toString("hex");
  const accountEmails: string[] = [];
  let leadId: string | undefined;

  try {
    // ── the row that used to leak ────────────────────────────────────────────
    // A pre-cutover sf_leads row: contact details plus the three secret columns.
    const leadEmail = `listing-lead-${tag}@example.test`;
    const secrets = {
      password: await bcrypt.hash(pw(), 10),
      reset: `reset-${tag}-${pw()}`,
      verify: `verify-${tag}-${pw()}`,
    };
    const { rows: [lead] } = await pool.query(
      `INSERT INTO sf_leads (first_name, last_name, email, phone, company,
                             password, reset_password_token, email_verification_token)
       VALUES ('Listing', 'Lead', $1, '555-0100', 'Leak Co', $2, $3, $4) RETURNING id`,
      [leadEmail, secrets.password, secrets.reset, secrets.verify]);
    leadId = lead.id as string;
    /** Whether a response body carries anything of that row. */
    const leaks = (body: string) =>
      [leadEmail, secrets.password, secrets.reset, secrets.verify].some((s) => body.includes(s));

    // ── personas ─────────────────────────────────────────────────────────────
    // A stranger, through the public signup the route still serves.
    const signupEmail = `listing-signup-${tag}@example.test`, signupPw = pw();
    accountEmails.push(signupEmail);
    const signup = await postJson("/api/leads",
      { firstName: "Listing", lastName: "Signup", email: signupEmail, password: signupPw });
    check("POST /api/leads (signup) still creates an account, unauthenticated",
      signup.status === 201 && signup.json.lead?.email === signupEmail,
      `${signup.status} ${JSON.stringify(signup.json)}`);
    const signupToken = await login(signupEmail, signupPw);

    // The admin.
    const adminEmail = `listing-admin-${tag}@example.test`, adminPw = pw();
    accountEmails.push(adminEmail);
    await pool.query(
      `INSERT INTO accounts (id, name, email, password, app_role, app_role_source, is_verified)
       VALUES (gen_random_uuid(), 'Listing Admin', $1, $2, 'admin', 'manual', true)`,
      [adminEmail, await bcrypt.hash(adminPw, 10)]);
    const adminToken = await login(adminEmail, adminPw);

    // ── the listing handlers are gone ────────────────────────────────────────
    const callers: [string, string | undefined][] = [
      ["no token", undefined], ["a signup's token", signupToken], ["the admin's token", adminToken]];
    for (const path of ["/api/leads", `/api/leads/${leadId}`]) {
      for (const [who, token] of callers) {
        const r = await get(path, token);
        check(`GET ${path.replace(leadId, ":id")} with ${who}: 404, no row`,
          r.status === 404 && !leaks(r.body), `${r.status} ${r.body.slice(0, 200)}`);
      }
    }

    // ── what admins use instead ──────────────────────────────────────────────
    const db = await get(`/db/sf_leads?token=${encodeURIComponent(adminToken)}`);
    check("the admin still finds the row in /db/sf_leads",
      db.status === 200 && db.body.includes(leadEmail), `${db.status}`);
    const dbAsSignup = await get(`/db/sf_leads?token=${encodeURIComponent(signupToken)}`);
    check("a signup does not get /db/sf_leads",
      dbAsSignup.status !== 200 && !leaks(dbAsSignup.body), `${dbAsSignup.status}`);
  } finally {
    if (leadId) await pool.query(`DELETE FROM sf_leads WHERE id = $1`, [leadId]);
    if (accountEmails.length) await pool.query(`DELETE FROM accounts WHERE email = ANY($1)`, [accountEmails]);
    server.close();
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
