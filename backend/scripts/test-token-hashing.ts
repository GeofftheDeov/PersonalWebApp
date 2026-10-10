/**
 * Regression test: password-reset and email-verification tokens were stored in
 * plaintext and redeemed by equality.
 *
 * forgot-password (and the /db admin's reset action) wrote the raw token to
 * accounts.reset_password_token, and reset-password found the account with
 * `resetPasswordToken: token`. So any read of an accounts row — the
 * /api/campaign-members populate leak was one — handed over a token that could
 * be redeemed as-is: account takeover. email_verification_token was minted by
 * /api/users/register and /api/leads and redeemed by verify-email the same way.
 *
 * Now only a token's SHA-256 is stored, and the raw value leaves only in the
 * email (and in forgot-password's dev-only mockToken). This checks that the
 * stored column is never the raw token and is not itself redeemable, and that
 * forgot → reset (including the admin-triggered reset, whose writer lives in
 * dbRoutes) and verify-email still work end to end.
 *
 * It also pins the type check on the submitted token. The model layer reads an
 * object filter value as operators, so `{"token": {"$ne": null}}` used to match
 * whichever account had a reset in flight, with no token at all.
 *
 * Mounts the real routers the way server.ts does and drives them over HTTP. No
 * mail leaves the machine: EMAIL_PASS is cleared, which sends emailService down
 * its mock branch. With NODE_ENV=development emailService writes the link it
 * would have mailed to ./reset_link.txt, so the test runs in a temp directory
 * and reads the emailed token from there.
 *
 * Run against a throwaway database loaded from db/schema.sql (it inserts and
 * deletes its own rows, and refuses to run against anything but localhost):
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-token-hashing.ts
 */
import "./use-test-jwt-secret.js";
import express from "express";
import type { AddressInfo } from "net";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pool from "../db/index.js";
import userRoutes from "../routes/userRoutes.js";
import leadRoutes from "../routes/leadRoutes.js";
import dbRoutes from "../routes/dbRoutes.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
  process.exit(2);
}

// emailService only calls nodemailer when EMAIL_PASS is set, and its own
// dotenv.config() may have just loaded one from a real .env. It reads the
// variable per send, so clearing it here keeps every send on the mock branch.
delete process.env.EMAIL_PASS;

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

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** isDevEnv() is read per call, so each request can be sent as dev or as prod. */
const asDev = () => { process.env.NODE_ENV = "development"; };
const asProd = () => { process.env.NODE_ENV = "production"; };

/** The token in the link emailService last "sent". It writes the link to ./reset_link.txt in development only. */
const emailedResetToken = () => {
  if (!fs.existsSync("reset_link.txt")) return null;
  return fs.readFileSync("reset_link.txt", "utf8").match(/[?&]token=([^&\s]+)/)?.[1] ?? null;
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pwa-token-hashing-"));
  process.chdir(tmp);

  const server = buildApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const postJson = async (p: string, body: unknown) => {
    const res = await fetch(`${base}${p}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => ({})) as any };
  };
  const login = (email: string, password: string) => postJson("/api/users/login", { email, password });

  const tag = crypto.randomBytes(4).toString("hex");
  const emails: string[] = [];
  const pw = () => crypto.randomBytes(12).toString("hex");

  /** A verified accounts row with a known password: what a reset's target looks like. */
  const account = async (label: string) => {
    const email = `${label}-${tag}@example.test`, password = pw();
    emails.push(email);
    const { rows: [row] } = await pool.query(
      `INSERT INTO accounts (id, name, email, password, is_verified)
       VALUES (gen_random_uuid(), $1, $2, $3, true) RETURNING id, password`,
      [label, email, await bcrypt.hash(password, 10)]);
    return { id: row.id as string, email, password, hash: row.password as string };
  };
  const row = async (id: string) => (await pool.query(
    `SELECT password, reset_password_token, reset_password_expires, email_verification_token, is_verified
       FROM accounts WHERE id = $1`, [id])).rows[0];

  try {
    // ── forgot-password → reset-password ─────────────────────────────────────
    console.log("\nforgot-password → reset-password\n");
    asDev();

    const alice = await account("alice");
    fs.rmSync("reset_link.txt", { force: true });
    const forgot = await postJson("/api/users/forgot-password", { email: alice.email });
    const raw: string = forgot.json?.mockToken;
    check("forgot-password answers 200 with the dev-only mockToken",
      forgot.status === 200 && typeof raw === "string" && raw.length > 0, `got ${forgot.status} ${JSON.stringify(forgot.json)}`);
    check("the emailed link carries that same raw token", emailedResetToken() === raw,
      `emailed ${emailedResetToken()}, mockToken ${raw}`);

    const stored = await row(alice.id);
    check("reset_password_token is not the raw token", stored.reset_password_token !== raw,
      `stored ${stored.reset_password_token}`);
    check("reset_password_token is the raw token's SHA-256", stored.reset_password_token === sha256(raw),
      `stored ${stored.reset_password_token}, sha256 ${sha256(raw)}`);

    // The takeover this closes: whoever can read the row submits what they read.
    const replay = await postJson("/api/users/reset-password", { token: stored.reset_password_token, newPassword: pw() });
    check("the stored column is not itself a redeemable token",
      replay.status === 400 && (await row(alice.id)).password === alice.hash, `got ${replay.status}`);

    const newPw = pw();
    const reset = await postJson("/api/users/reset-password", { token: raw, newPassword: newPw });
    check("the raw token resets the password", reset.status === 200, `got ${reset.status} ${JSON.stringify(reset.json)}`);
    const cleared = await row(alice.id);
    check("the reset clears both token columns",
      cleared.reset_password_token === null && cleared.reset_password_expires === null,
      `token ${cleared.reset_password_token}, expires ${cleared.reset_password_expires}`);
    const [oldLogin, newLogin] = [await login(alice.email, alice.password), await login(alice.email, newPw)];
    check("login takes the new password and refuses the old one", newLogin.status === 200 && oldLogin.status !== 200,
      `new ${newLogin.status}, old ${oldLogin.status}`);
    const reuse = await postJson("/api/users/reset-password", { token: raw, newPassword: pw() });
    check("a redeemed token cannot be redeemed again", reuse.status === 400, `got ${reuse.status}`);

    const bob = await account("bob");
    const bobForgot = await postJson("/api/users/forgot-password", { email: bob.email });
    await pool.query(`UPDATE accounts SET reset_password_expires = now() - interval '1 minute' WHERE id = $1`, [bob.id]);
    const expired = await postJson("/api/users/reset-password", { token: bobForgot.json?.mockToken, newPassword: pw() });
    check("an expired token is refused", expired.status === 400 && (await row(bob.id)).password === bob.hash,
      `got ${expired.status}`);

    // The model layer reads an object filter value as operators, so this was
    // `reset_password_token IS NOT NULL`: whichever account had a reset in flight.
    const carol = await account("carol");
    await postJson("/api/users/forgot-password", { email: carol.email });
    const injected = await postJson("/api/users/reset-password", { token: { $ne: null }, newPassword: pw() });
    check("an operator object in place of the token resets nobody",
      injected.status === 400 && (await row(carol.id)).password === carol.hash,
      `got ${injected.status} ${JSON.stringify(injected.json)}`);

    asProd();
    const prodForgot = await postJson("/api/users/forgot-password", { email: carol.email });
    check("outside development forgot-password returns no token",
      prodForgot.status === 200 && !("mockToken" in prodForgot.json), `got ${prodForgot.status} ${JSON.stringify(prodForgot.json)}`);

    // ── the /db admin's reset action ─────────────────────────────────────────
    // Its writer lives in dbRoutes but its token is redeemed by userRoutes, so
    // hashing on one side only would break it.
    console.log("\n/db admin: send a reset email\n");
    asDev();

    const admin = await account("admin");
    await pool.query(`UPDATE accounts SET app_role = 'admin', app_role_source = 'manual' WHERE id = $1`, [admin.id]);
    const adminJwt: string = (await login(admin.email, admin.password)).json.token;
    const dave = await account("dave");
    fs.rmSync("reset_link.txt", { force: true });
    const action = await fetch(`${base}/db/accounts/reset-password/${dave.id}?token=${encodeURIComponent(adminJwt)}`,
      { method: "POST", redirect: "manual" });
    const adminRaw = emailedResetToken();
    check("the admin action emails a reset link", action.status === 200 && !!adminRaw,
      `got ${action.status} ${await action.text()}, emailed ${adminRaw}`);

    const daveStored = await row(dave.id);
    check("it stores the SHA-256, not the emailed token",
      !!adminRaw && daveStored.reset_password_token !== adminRaw && daveStored.reset_password_token === sha256(adminRaw),
      `stored ${daveStored.reset_password_token}, emailed ${adminRaw}`);

    const daveNewPw = pw();
    const daveReset = await postJson("/api/users/reset-password", { token: adminRaw, newPassword: daveNewPw });
    check("the emailed token redeems at /api/users/reset-password",
      daveReset.status === 200 && (await login(dave.email, daveNewPw)).status === 200,
      `got ${daveReset.status} ${JSON.stringify(daveReset.json)}`);

    // ── register → verify-email ──────────────────────────────────────────────
    // Outside development both signup routes mint a token and email it. The
    // email is not readable then, so the raw value is not either: what can be
    // checked is the shape (randomBytes(20) is 40 hex characters, a SHA-256 is
    // 64) and that the stored value does not redeem.
    console.log("\nregister → verify-email\n");
    asProd();

    const signups: [string, string, (email: string) => unknown][] = [
      ["register", "/api/users/register", (email) => ({ name: "Erin", email, password: pw() })],
      ["lead", "/api/leads", (email) => ({ firstName: "Erin", lastName: "Lead", email, password: pw() })],
    ];
    for (const [label, route, body] of signups) {
      const email = `${label}-${tag}@example.test`;
      emails.push(email);
      const created = await postJson(route, body(email));
      const { rows: [signup] } = await pool.query(
        `SELECT id, email_verification_token, is_verified FROM accounts WHERE email = $1`, [email]);
      check(`${route} leaves the account unverified with a token on it`,
        created.status === 201 && signup?.is_verified === false && !!signup?.email_verification_token,
        `got ${created.status}, row ${JSON.stringify(signup)}`);
      check(`${route} stores a SHA-256 digest, not a raw token`,
        /^[0-9a-f]{64}$/.test(signup?.email_verification_token ?? ""), `stored ${signup?.email_verification_token}`);
      const replayVerify = await postJson("/api/users/verify-email", { token: signup?.email_verification_token });
      check(`${route}: the stored column is not itself a redeemable token`,
        replayVerify.status === 400 && (await row(signup.id)).is_verified === false, `got ${replayVerify.status}`);
    }

    // The whole loop needs a raw token the test knows: put its SHA-256 on the
    // row, the way register now does.
    const frank = await account("frank");
    const verifyRaw = crypto.randomBytes(20).toString("hex");
    await pool.query(`UPDATE accounts SET is_verified = false, email_verification_token = $2 WHERE id = $1`,
      [frank.id, sha256(verifyRaw)]);
    const verified = await postJson("/api/users/verify-email", { token: verifyRaw });
    const frankAfter = await row(frank.id);
    check("verify-email redeems the raw token and clears the column",
      verified.status === 200 && frankAfter.is_verified === true && frankAfter.email_verification_token === null,
      `got ${verified.status}, row ${JSON.stringify({ v: frankAfter.is_verified, t: frankAfter.email_verification_token })}`);

    const grace = await account("grace");
    await pool.query(`UPDATE accounts SET is_verified = false, email_verification_token = $2 WHERE id = $1`,
      [grace.id, sha256(crypto.randomBytes(20).toString("hex"))]);
    const injectedVerify = await postJson("/api/users/verify-email", { token: { $ne: null } });
    check("an operator object in place of the token verifies nobody",
      injectedVerify.status === 400 && (await row(grace.id)).is_verified === false,
      `got ${injectedVerify.status} ${JSON.stringify(injectedVerify.json)}`);
  } finally {
    await pool.query(`DELETE FROM accounts WHERE email = ANY($1)`, [emails]);
    server.close();
    process.chdir(os.tmpdir());
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
