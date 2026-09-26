/**
 * Test for the /admin and /db admin gate on main (GitHub #43).
 *
 * Mounts the real userRoutes, adminRoutes and dbRoutes the way server.ts does,
 * then drives them over HTTP with tokens minted by the real /api/users/register
 * and /api/users/login — the path anybody on the internet can take. Before the
 * gate, a fresh signup's token opened both portals, including a write to its
 * own sf_users.role; after it, only an sf_users row with role = 'admin' does.
 *
 * Run against a throwaway database loaded from db/schema.sql (it inserts and
 * deletes its own rows, and refuses to run against anything but localhost):
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-admin-gate.ts
 */
import express from "express";
import type { AddressInfo } from "net";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import pool from "../db/index.js";
import userRoutes from "../routes/userRoutes.js";
import adminRoutes from "../routes/adminRoutes.js";
import dbRoutes from "../routes/dbRoutes.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
  process.exit(2);
}

const SECRET = process.env.JWT_SECRET || "your-secret-key-change-this";

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
  app.use("/admin", adminRoutes);
  app.use("/api/users", userRoutes);
  return app;
}

async function main() {
  const server = buildApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const hit = async (method: string, path: string, token?: string, form?: Record<string, string>) => {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${base}${path}${token ? `${sep}token=${encodeURIComponent(token)}` : ""}`, {
      method, redirect: "manual",
      ...(form ? { body: new URLSearchParams(form), headers: { "content-type": "application/x-www-form-urlencoded" } } : {}),
    });
    return { status: res.status, location: res.headers.get("location"), body: await res.text() };
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
  const created: { table: string; id: string }[] = [];

  try {
    // ── personas ─────────────────────────────────────────────────────────────
    // The admin: the one sf_users row production has, role = 'admin'.
    const adminEmail = `gate-admin-${tag}@example.test`, adminPw = pw();
    const { rows: [admin] } = await pool.query(
      `INSERT INTO sf_users (name, email, password, role, is_verified)
       VALUES ('Gate Admin', $1, $2, 'admin', true) RETURNING id, password`,
      [adminEmail, await bcrypt.hash(adminPw, 10)]);
    created.push({ table: "sf_users", id: admin.id });
    const adminToken = await login(adminEmail, adminPw);

    // A stranger who signs up through the public form. In production that
    // leaves them unverified — and /login does not check.
    const signupEmail = `gate-signup-${tag}@example.test`, signupPw = pw();
    const reg = await postJson("/api/users/register", { name: "Gate Signup", email: signupEmail, password: signupPw });
    const { rows: [signup] } = await pool.query(
      `SELECT id, role, is_verified FROM sf_users WHERE email = $1`, [signupEmail]);
    if (signup) created.push({ table: "sf_users", id: signup.id });
    check("a public signup creates an ordinary sf_users row",
      reg.status === 201 && signup?.role === "user",
      `register ${reg.status}, role=${signup?.role}`);
    const signupToken = await login(signupEmail, signupPw);
    const signupClaims = jwt.decode(signupToken) as any;
    check("the signup's JWT is the ordinary login JWT (same secret, id claim)",
      jwt.verify(signupToken, SECRET) !== null && signupClaims.id === signup.id && signupClaims.type === "User",
      JSON.stringify(signupClaims));

    // A Lead — what Google sign-in auto-creates for any Google account.
    const leadEmail = `gate-lead-${tag}@example.test`, leadPw = pw();
    const { rows: [lead] } = await pool.query(
      `INSERT INTO sf_leads (first_name, last_name, email, password)
       VALUES ('Gate', 'Lead', $1, $2) RETURNING id`,
      [leadEmail, await bcrypt.hash(leadPw, 10)]);
    created.push({ table: "sf_leads", id: lead.id });
    const leadToken = await login(leadEmail, leadPw);

    // Correctly signed, but its subject no longer exists (a deleted user).
    const ghostToken = jwt.sign({ id: crypto.randomUUID(), type: "User", email: "ghost@example.test" }, SECRET);
    // Right claims, wrong key.
    const forgedToken = jwt.sign({ id: admin.id, type: "User", email: adminEmail }, `not-${SECRET}`);

    // ── identification (unchanged) ───────────────────────────────────────────
    for (const p of ["/admin", "/db"]) {
      const none = await hit("GET", p);
      const forged = await hit("GET", p, forgedToken);
      check(`${p}: no token or a forged token still redirects to login`,
        none.status === 302 && forged.status === 302, `none=${none.status}, forged=${forged.status}`);
    }

    // ── the gate ─────────────────────────────────────────────────────────────
    // #43's verification: the admin still gets the table...
    const adminPaths = ["/admin", "/db", "/db/users"];
    const asAdmin = await Promise.all(adminPaths.map((p) => hit("GET", p, adminToken)));
    check("the admin still reaches /admin, /db and /db/users",
      asAdmin.every((r) => r.status === 200) && asAdmin[2].body.includes(adminEmail),
      adminPaths.map((p, i) => `${p}=${asAdmin[i].status}`).join(", "));

    // ...and everybody else is refused, on every surface #43 listed.
    const gated = [
      ["GET", "/admin"], ["GET", "/admin/obsidian/api/tree"], ["GET", "/admin/alpaca/api/wallets"],
      ["GET", "/admin/paperclip/api/overview"], ["GET", "/admin/cloud-claw"],
      ["GET", "/db"], ["GET", "/db/users"], ["GET", "/db/api_key_vault"], ["GET", "/db/users/export"],
    ] as const;
    for (const [who, token] of [["a public signup", signupToken], ["a Lead", leadToken], ["a deleted user", ghostToken]] as const) {
      const got = await Promise.all(gated.map(([m, p]) => hit(m, p, token)));
      check(`${who} gets 403 from /admin and /db`, got.every((r) => r.status === 403),
        gated.map(([, p], i) => `${p}=${got[i].status}`).join(", "));
    }

    // ── the writes that made this more than a read leak ──────────────────────
    const escalate = await hit("POST", `/db/users/update/${signup.id}`, signupToken, { json: JSON.stringify({ role: "admin" }) });
    const { rows: [after] } = await pool.query(`SELECT role FROM sf_users WHERE id = $1`, [signup.id]);
    check("a signup cannot write role = 'admin' onto its own row through /db",
      escalate.status === 403 && after.role === "user", `POST ${escalate.status}, role now ${after.role}`);

    const takeover = await hit("POST", `/db/users/update/${admin.id}`, signupToken, { json: JSON.stringify({ password: "pwned" }) });
    const { rows: [adminAfter] } = await pool.query(`SELECT password FROM sf_users WHERE id = $1`, [admin.id]);
    check("a signup cannot reset the admin's password through /db",
      takeover.status === 403 && adminAfter.password === admin.password, `POST ${takeover.status}`);

    // ── role is read per request, not baked into the token ───────────────────
    await pool.query(`UPDATE sf_users SET role = 'user' WHERE id = $1`, [admin.id]);
    const demoted = await hit("GET", "/admin", adminToken);
    await pool.query(`UPDATE sf_users SET role = 'admin' WHERE id = $1`, [admin.id]);
    const restored = await hit("GET", "/admin", adminToken);
    check("demoting the admin closes the door on the very next request, with the same token",
      demoted.status === 403 && restored.status === 200, `demoted=${demoted.status}, restored=${restored.status}`);

    // ── the interface dev's routes (#56/#59/#60) are written against ─────────
    const { requireAdmin } = await import("../middleware/auth.js") as any;
    if (typeof requireAdmin !== "function") {
      check("middleware/auth.ts exports requireAdmin(redirect)", false, "not exported");
    } else {
      const run = (req: any, redirect: boolean) => new Promise<{ code: number; kind: string }>((resolve) => {
        const res: any = {
          status(code: number) { this.__code = code; return this; },
          json() { resolve({ code: this.__code, kind: "json" }); return this; },
          send() { resolve({ code: this.__code, kind: "html" }); return this; },
        };
        requireAdmin(redirect)({ ...req, originalUrl: "/test" }, res, () => resolve({ code: 200, kind: "next" }));
      });
      const viaAdminUser = await run({ adminUser: { id: admin.id } }, true);
      const viaUser = await run({ user: { id: admin.id } }, false);       // behind `auth`, as a JSON API
      const userJson = await run({ user: { id: signup.id } }, false);
      const userHtml = await run({ adminUser: { id: signup.id } }, true);
      const noId = await run({}, false);
      const badId = await run({ user: { id: "not-a-uuid" } }, false);
      check("requireAdmin(redirect) reads req.adminUser or req.user, 403s as HTML or JSON, and fails closed",
        viaAdminUser.code === 200 && viaUser.code === 200
          && userJson.code === 403 && userJson.kind === "json"
          && userHtml.code === 403 && userHtml.kind === "html"
          && noId.code === 403 && badId.code === 403,
        JSON.stringify({ viaAdminUser, viaUser, userJson, userHtml, noId, badId }));
    }
  } finally {
    for (const { table, id } of created.reverse()) await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    server.close();
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
