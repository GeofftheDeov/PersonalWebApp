/**
 * Regression test (#248): forgot-password and login told an email with an
 * account apart from one without.
 *
 * POST /api/users/forgot-password answered 404 "User not found" for an email
 * with no account and 200 for one with, and login answered "Invalid
 * credentials" for an unknown email but "Incorrect Password" for a known one.
 * Anyone could call the API and learn which emails have accounts.
 *
 * Now forgot-password answers the same 200 either way (outside development,
 * where the mockToken would give it away anyway), and login's 401 is the same
 * for an unknown email and a wrong password. A non-string email to
 * forgot-password is also treated as no account: the model layer reads an
 * object filter value as operators, so {"$ne": null} matched some account and
 * mailed it a reset.
 *
 * Mounts the real router the way server.ts does and drives it over HTTP. No
 * mail leaves the machine: EMAIL_PASS is cleared, which sends emailService down
 * its mock branch.
 *
 * Run against a throwaway database loaded from db/schema.sql (it inserts and
 * deletes its own rows, and refuses to run against anything but localhost):
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-account-enumeration.ts
 */
import "./use-test-jwt-secret.js";
import express from "express";
import type { AddressInfo } from "net";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import pool from "../db/index.js";
import userRoutes from "../routes/userRoutes.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
  process.exit(2);
}

delete process.env.EMAIL_PASS;
// Production, so forgot-password carries no dev-only mockToken and writes no reset_link.txt.
process.env.NODE_ENV = "production";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? pass++ : fail++;
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use("/api/users", userRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const postJson = async (p: string, body: unknown) => {
    const res = await fetch(`${base}${p}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => ({})) as any };
  };
  const same = (a: { status: number; json: any }, b: { status: number; json: any }) =>
    a.status === b.status && JSON.stringify(a.json) === JSON.stringify(b.json);
  const show = (r: { status: number; json: any }) => `${r.status} ${JSON.stringify(r.json)}`;

  const tag = crypto.randomBytes(4).toString("hex");
  const email = `known-${tag}@example.test`;
  const password = crypto.randomBytes(12).toString("hex");
  const { rows: [known] } = await pool.query(
    `INSERT INTO accounts (id, name, email, password, is_verified)
     VALUES (gen_random_uuid(), 'known', $1, $2, true) RETURNING id`,
    [email, await bcrypt.hash(password, 10)]);
  const unknown = `nobody-${tag}@example.test`;
  const resetToken = async () =>
    (await pool.query(`SELECT reset_password_token FROM accounts WHERE id = $1`, [known.id])).rows[0].reset_password_token;

  try {
    console.log("\nforgot-password\n");
    const forKnown = await postJson("/api/users/forgot-password", { email });
    check("an email with an account gets a 200", forKnown.status === 200, show(forKnown));
    check("and a reset token is stored for it", (await resetToken()) !== null);

    const forUnknown = await postJson("/api/users/forgot-password", { email: unknown });
    check("an email with no account gets the same answer", same(forKnown, forUnknown),
      `known: ${show(forKnown)}, unknown: ${show(forUnknown)}`);

    await pool.query(`UPDATE accounts SET reset_password_token = NULL WHERE id = $1`, [known.id]);
    const injected = await postJson("/api/users/forgot-password", { email: { $ne: null } });
    check("an operator object for the email gets the same answer", same(forKnown, injected), show(injected));
    check("and starts no reset on any account", (await resetToken()) === null);

    console.log("\nlogin\n");
    const right = await postJson("/api/users/login", { email, password });
    check("the right password still signs in", right.status === 200 && typeof right.json?.token === "string", show(right));

    const wrongPassword = await postJson("/api/users/login", { email, password: "not-the-password" });
    const noAccount = await postJson("/api/users/login", { email: unknown, password: "not-the-password" });
    check("a wrong password gets a 401", wrongPassword.status === 401, show(wrongPassword));
    check("an unknown email gets the same answer as a wrong password", same(wrongPassword, noAccount),
      `wrong password: ${show(wrongPassword)}, no account: ${show(noAccount)}`);
  } finally {
    await pool.query(`DELETE FROM accounts WHERE id = $1`, [known.id]);
    server.close();
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
