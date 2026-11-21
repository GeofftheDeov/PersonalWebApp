/**
 * Cloud-Claw is admin only (GitHub #263).
 *
 * The agent behind /api/cloud-claw spends the server's Anthropic key, places
 * orders on the shared Alpaca paper account and reads the Obsidian vault. Its
 * routes used to ask only for a login, so any account (every Hearthside
 * player) could use them.
 *
 * Mounts the real cloudClawRoutes the way server.ts does and checks, over HTTP:
 *   - nobody signed in gets a 401 on all four routes;
 *   - a signed-in account that isn't an admin gets a 403 on all four;
 *   - an admin still gets through. The chat routes are sent an empty message,
 *     so the admin reaches their validation (400) without calling Anthropic.
 *
 * Run against a throwaway database loaded from db/schema.sql (it inserts and
 * deletes its own rows, and refuses to run against anything but localhost):
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-cloudclaw-admin.ts
 */
import "./use-test-jwt-secret.js";
import express from "express";
import type { AddressInfo } from "net";
import crypto from "crypto";
import pool from "../db/index.js";
import cloudClawRoutes from "../routes/cloudClawRoutes.js";
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

const ROUTES: [string, string][] = [
  ["POST", "/api/cloud-claw/chat"],
  ["POST", "/api/cloud-claw/chat/stream"],
  ["DELETE", "/api/cloud-claw/chat"],
  ["GET", "/api/cloud-claw/history"],
];

async function main() {
  const app = express();
  app.use(express.json());
  app.use("/api/cloud-claw", cloudClawRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call = async (method: string, path: string, token?: string) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify({ message: "" }) } : {}),
    });
    return { status: res.status, body: await res.text() };
  };
  const statuses = (rs: { status: number }[]) => ROUTES.map(([m, p], i) => `${m} ${p}=${rs[i].status}`).join(", ");

  const tag = crypto.randomBytes(4).toString("hex");
  const ids: string[] = [];
  try {
    const { rows: [admin] } = await pool.query(
      `INSERT INTO accounts (id, name, email, app_role, is_verified)
       VALUES (gen_random_uuid(), 'T263 Admin', $1, 'admin', true) RETURNING id, email`,
      [`t263-admin-${tag}@example.test`]);
    ids.push(admin.id);
    const { rows: [user] } = await pool.query(
      `INSERT INTO accounts (id, name, email, app_role, is_verified)
       VALUES (gen_random_uuid(), 'T263 Player', $1, 'user', true) RETURNING id, email`,
      [`t263-user-${tag}@example.test`]);
    ids.push(user.id);
    const adminToken = signJwt({ id: admin.id, type: "User", email: admin.email });
    const userToken = signJwt({ id: user.id, type: "User", email: user.email });

    const anon = await Promise.all(ROUTES.map(([m, p]) => call(m, p)));
    check("nobody signed in gets a 401 on every route", anon.every((r) => r.status === 401), statuses(anon));

    const asUser = await Promise.all(ROUTES.map(([m, p]) => call(m, p, userToken)));
    check("a signed-in account that isn't an admin gets a 403 on every route",
      asUser.every((r) => r.status === 403), statuses(asUser));

    const asAdmin = await Promise.all(ROUTES.map(([m, p]) => call(m, p, adminToken)));
    check("an admin gets through: the chat routes reach validation (400)",
      asAdmin[0].status === 400 && asAdmin[1].status === 400, statuses(asAdmin));
    check("an admin can clear and read their history (200)",
      asAdmin[2].status === 200 && asAdmin[3].status === 200, statuses(asAdmin));
  } finally {
    if (ids.length) {
      await pool.query(`DELETE FROM cloud_claw_sessions WHERE user_id = ANY($1::uuid[])`, [ids]);
      await pool.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [ids]);
    }
    server.close();
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
