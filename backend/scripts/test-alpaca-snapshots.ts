/**
 * Test for Alpaca snapshots of every wallet, and the admin session banner.
 *
 * The 5-minute snapshot loop used to record only the Cloud-Claw wallet (server
 * env keys); the admin's own paper and live wallets (Profile page vault keys)
 * had no position history at all. This drives the real apiKeyRoutes and
 * adminRoutes against a stand-in Alpaca (ALPACA_MOCK_URL), with keys saved the
 * way the Profile page saves them, and checks that:
 *   - one snapshotAlpacaNow() records cloudclaw, and each admin's paper and
 *     live wallets, tagged with wallet + owner;
 *   - a non-admin's Alpaca keys are not snapshotted;
 *   - one wallet's rejected keys don't stop the others;
 *   - GET /admin/alpaca/api/snapshots?wallet= returns only that wallet, and
 *     for paper/live only the requesting admin's rows.
 * And, for the "Unauthorized: Invalid token" seen saving keys on dev: an
 * expired login is refused by PUT /api/api-keys, and every admin page now
 * carries the banner that says so before it happens.
 *
 * Run against a throwaway database loaded from db/schema.sql (it inserts and
 * deletes its own rows, and refuses to run against anything but localhost):
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-alpaca-snapshots.ts
 */
import "./use-test-jwt-secret.js";
import crypto from "crypto";
import express from "express";
import type { AddressInfo } from "net";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
  process.exit(2);
}
process.env.VAULT_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
process.env.ALPACA_API_KEY = "PK-CLOUDCLAW";
process.env.ALPACA_SECRET_KEY = "cloudclaw-secret";

// Imported after the env above: the routes read it per call, but keep it obvious.
const { default: pool } = await import("../db/index.js");
const { default: apiKeyRoutes } = await import("../routes/apiKeyRoutes.js");
const { default: adminRoutes, snapshotAlpacaNow } = await import("../routes/adminRoutes.js");
const { signJwt } = await import("../utils/jwt.js");

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? pass++ : fail++;
}

// ── stand-in Alpaca: equity is fixed per key id, "BAD" keys are rejected ─────
const EQUITY: Record<string, number> = {
  "PK-CLOUDCLAW": 1000, "PK-ADMIN-PAPER": 1111, "AK-ADMIN-LIVE": 1222, "PK-ADMIN2-PAPER": 2111, "PK-USER-PAPER": 3111,
};
const alpacaCalls: string[] = [];
function startMockAlpaca() {
  const app = express();
  app.get("/:env/v2/:resource", (req, res) => {
    const key = String(req.header("APCA-API-KEY-ID"));
    alpacaCalls.push(`${req.params.env}:${key}`);
    const equity = EQUITY[key];
    if (equity === undefined) return res.status(401).json({ message: "unauthorized." });
    if (req.params.resource === "account") {
      return res.json({ equity: String(equity), last_equity: String(equity - 10), cash: "5", buying_power: "10" });
    }
    if (req.params.resource === "positions") {
      return res.json([{ symbol: "AAPL", qty: "1", market_value: String(equity - 5), unrealized_pl: "1", current_price: "200" }]);
    }
    res.status(404).end();
  });
  return app.listen(0, "127.0.0.1");
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/admin", adminRoutes);
  app.use("/api/api-keys", apiKeyRoutes);
  return app;
}

async function main() {
  const mock = startMockAlpaca();
  const server = buildApp().listen(0, "127.0.0.1");
  await Promise.all([mock, server].map((s) => new Promise((r) => s.once("listening", r))));
  process.env.ALPACA_MOCK_URL = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const tag = crypto.randomBytes(4).toString("hex");
  const started = new Date();
  const accountIds: string[] = [];

  const person = async (name: string, admin: boolean) => {
    const email = `snap-${name}-${tag}@example.test`;
    const { rows: [row] } = await pool.query(
      `INSERT INTO accounts (id, name, email, app_role, app_role_source, is_verified)
       VALUES (gen_random_uuid(), $1, $2, $3, 'manual', true) RETURNING id`,
      [name, email, admin ? "admin" : "user"]);
    accountIds.push(row.id);
    return { id: row.id as string, token: signJwt({ id: row.id, email }, { expiresIn: "1h" }) };
  };
  const saveKeys = async (token: string, provider: string, keyId: string) => {
    const r = await fetch(`${base}/api/api-keys/${provider}`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ keyId, secret: `${keyId}-secret` }),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) as any };
  };
  const snapshots = async (token: string, wallet?: string) => {
    const r = await fetch(`${base}/admin/alpaca/api/snapshots?period=1D${wallet ? `&wallet=${wallet}` : ""}&token=${token}`);
    return { status: r.status, json: await r.json().catch(() => null) as any };
  };

  try {
    const admin = await person("admin", true);
    const admin2 = await person("admin2", true);
    const user = await person("user", false);

    const saved = await Promise.all([
      saveKeys(admin.token, "alpaca_paper", "PK-ADMIN-PAPER"),
      saveKeys(admin.token, "alpaca_live", "AK-ADMIN-LIVE"),
      saveKeys(admin2.token, "alpaca_paper", "PK-ADMIN2-PAPER"),
      saveKeys(admin2.token, "alpaca_live", "BAD-KEY"),
      saveKeys(user.token, "alpaca_paper", "PK-USER-PAPER"),
    ]);
    check("keys save through PUT /api/api-keys with a current login", saved.every((s) => s.status === 200),
      saved.map((s) => s.status).join(","));

    // ── the expired-login failure seen on dev ────────────────────────────────
    const expired = signJwt({ id: admin.id, email: "x" }, { expiresIn: -10 });
    const late = await saveKeys(expired, "alpaca_paper", "PK-ADMIN-PAPER");
    check("an expired login is refused when saving keys (the dev error)",
      late.status === 401 && /invalid token/i.test(late.json.error ?? ""), JSON.stringify(late));

    // ── one pass of the loop ─────────────────────────────────────────────────
    await snapshotAlpacaNow();
    const { rows } = await pool.query(
      `SELECT wallet, user_id, equity::float AS equity, positions FROM alpaca_snapshots WHERE ts >= $1`, [started]);
    const find = (wallet: string, userId: string | null) =>
      rows.filter((r: any) => r.wallet === wallet && r.user_id === userId);

    check("Cloud-Claw is still recorded, with no owner",
      find("cloudclaw", null).length === 1 && find("cloudclaw", null)[0].equity === 1000, JSON.stringify(rows));
    check("the admin's Profile paper wallet is recorded under their id",
      find("paper", admin.id).length === 1 && find("paper", admin.id)[0].equity === 1111
        && find("paper", admin.id)[0].positions?.[0]?.symbol === "AAPL", JSON.stringify(find("paper", admin.id)));
    check("the admin's Profile live wallet is recorded under their id",
      find("live", admin.id).length === 1 && find("live", admin.id)[0].equity === 1222);
    check("a second admin's paper wallet is recorded under theirs",
      find("paper", admin2.id).length === 1 && find("paper", admin2.id)[0].equity === 2111);
    check("rejected keys record nothing, and don't stop the other wallets",
      find("live", admin2.id).length === 0 && alpacaCalls.includes("live:BAD-KEY"));
    check("a non-admin's Alpaca keys are not snapshotted (or even called)",
      rows.every((r: any) => r.user_id !== user.id) && !alpacaCalls.some((c) => c.includes("PK-USER-PAPER")));

    // ── the chart's read ─────────────────────────────────────────────────────
    const paper = await snapshots(admin.token, "paper");
    check("?wallet=paper returns only the requesting admin's paper rows",
      paper.status === 200 && paper.json.length === 1 && Number(paper.json[0].equity) === 1111, JSON.stringify(paper));
    const paper2 = await snapshots(admin2.token, "paper");
    check("...and the other admin gets theirs",
      paper2.status === 200 && paper2.json.length === 1 && Number(paper2.json[0].equity) === 2111);
    const dflt = await snapshots(admin.token);
    check("no ?wallet= still means Cloud-Claw (what the chart used to ask for)",
      dflt.status === 200 && dflt.json.length >= 1 && dflt.json.every((s: any) => s.wallet === "cloudclaw"));
    const bad = await snapshots(admin.token, "nope");
    check("an unknown wallet is a 400", bad.status === 400, JSON.stringify(bad));

    // ── the banner ───────────────────────────────────────────────────────────
    const page = await fetch(`${base}/admin/profile?token=${admin.token}`).then((r) => r.text());
    check("admin pages carry the login-expiry banner, and the Profile save explains a 401",
      page.includes('id="session-banner"') && page.includes("Your login expired at")
        && page.includes("Not saved: your login expired"));
  } finally {
    await pool.query(`DELETE FROM alpaca_snapshots WHERE ts >= $1`, [started]);
    await pool.query(`DELETE FROM api_key_vault WHERE user_id = ANY($1)`, [accountIds]);
    await pool.query(`DELETE FROM accounts WHERE id = ANY($1)`, [accountIds]);
    server.close(); mock.close();
    await pool.end();
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
