/**
 * Regression test: /api/campaign-members handed every member every other
 * member's account secrets.
 *
 * `person` refs accounts, and the model layer serializes every column of a
 * populated document. GET / and GET /:id populated it whole, so any member of a
 * campaign received each co-member's password hash, email verification token,
 * and reset token with its expiry. The reset token is stored in plaintext and
 * redeemed by equality at POST /api/users/reset-password, so reading it there
 * is an account takeover. Same leak as GET /api/campaigns/:id/members (#108).
 *
 * Mounts the real router the way server.ts does and drives it over HTTP as an
 * ordinary player, then checks every handler's response: PUT, POST and DELETE
 * return unpopulated members today, and this keeps them that way.
 *
 * Run against a throwaway database loaded from db/schema.sql (it refuses to run
 * against anything but localhost):
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-campaign-member-leak.ts
 */
import express from "express";
import type { AddressInfo } from "net";
import jwt from "jsonwebtoken";
import pool from "../db/index.js";
import campaignMemberRoutes from "../routes/campaignMemberRoutes.js";

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

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/campaign-members", campaignMemberRoutes);
  return app;
}

/** Keeps reruns against the same database clear of the unique email index. */
const RUN = Math.random().toString(36).slice(2, 8);

/** The accounts columns no other member may ever see. */
const SECRET_KEYS = ["password", "emailVerificationToken", "resetPasswordToken", "resetPasswordExpires"];
/** What a member may see of another member's account. populate's select always keeps _id, id and createdAt. */
const PUBLIC_KEYS = new Set(["_id", "id", "createdAt", "handle", "name", "firstName", "lastName"]);

/** Every secret value written below, so a response can be scanned for them whatever its shape. */
const secretValues: string[] = [];

/**
 * An accounts row with a password set and a reset in flight — the state
 * forgot-password leaves behind. ids carry no database default, so mint one.
 */
async function account(handle: string) {
  const secrets = [`hash-${handle}-${RUN}`, `verify-${handle}-${RUN}`, `reset-${handle}-${RUN}`];
  secretValues.push(...secrets);
  const { rows } = await pool.query(
    `INSERT INTO accounts (id, handle, name, email, password, email_verification_token,
                           reset_password_token, reset_password_expires)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, now() + interval '1 hour')
     RETURNING id, email`,
    [handle, `${handle} name`, `${handle}.${RUN}@example.test`, ...secrets]);
  return { id: rows[0].id as string, email: rows[0].email as string };
}

async function member(campaignId: string, personId: string, status: string) {
  const { rows } = await pool.query(
    `INSERT INTO campaign_members (campaign_id, person_id, status) VALUES ($1, $2, $3) RETURNING id`,
    [campaignId, personId, status]);
  return rows[0].id as string;
}

/** Secret values that appear anywhere in a response body. */
const leakedValues = (body: unknown) => {
  const text = JSON.stringify(body ?? null);
  return secretValues.filter((s) => text.includes(s));
};

/** Secret keys, and any non-public key, on a populated `person`. */
const leakedKeys = (person: any) =>
  person && typeof person === "object" ? Object.keys(person).filter((k) => !PUBLIC_KEYS.has(k)) : [];

async function main() {
  const server = buildApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const tokenFor = (p: { id: string; email: string }) => jwt.sign({ id: p.id, email: p.email }, SECRET);
  const call = async (method: string, path: string, who: { id: string; email: string }, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${tokenFor(who)}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) as any };
  };

  try {
    const { rows: [campaign] } = await pool.query(
      `INSERT INTO campaigns (title) VALUES ('Lost Mine of the Reset Token') RETURNING id`);
    const campaignId: string = campaign.id;

    const gm = await account("gm");
    await member(campaignId, gm.id, "Game Master");
    const victim = await account("victim");
    const victimMemberId = await member(campaignId, victim.id, "Active");
    const player = await account("player");
    const playerMemberId = await member(campaignId, player.id, "Active");
    const newcomer = await account("newcomer");

    console.log("\nGET /api/campaign-members — as an ordinary player\n");

    const list = await call("GET", "/api/campaign-members", player);
    const rows: any[] = Array.isArray(list.json) ? list.json : [];
    check("the player sees their campaign's three members", list.status === 200 && rows.length === 3,
      `got ${list.status}, ${rows.length} rows`);

    const victimRow = rows.find((m) => m._id === victimMemberId);
    check("a co-member's entry still names them on `person`", victimRow?.person?.handle === "victim",
      `got ${JSON.stringify(victimRow?.person)}`);

    const listSecretKeys = [...new Set(rows.flatMap((m) => leakedKeys(m.person)))].filter((k) => SECRET_KEYS.includes(k));
    check("no member's `person` carries a password hash or token", listSecretKeys.length === 0,
      `leaked: ${listSecretKeys.join(", ")}`);

    const listExtraKeys = [...new Set(rows.flatMap((m) => leakedKeys(m.person)))];
    check("`person` carries only public profile fields", listExtraKeys.length === 0,
      `also carries: ${listExtraKeys.join(", ")}`);

    const listValues = leakedValues(list.json);
    check("no secret value appears anywhere in the list", listValues.length === 0,
      `found: ${listValues.join(", ")}`);

    console.log("\nGET /api/campaign-members/:id — a co-member's row, as an ordinary player\n");

    const one = await call("GET", `/api/campaign-members/${victimMemberId}`, player);
    check("the player can read a co-member's row", one.status === 200 && one.json?.person?.handle === "victim",
      `got ${one.status} ${JSON.stringify(one.json?.person)}`);

    const oneSecretKeys = leakedKeys(one.json?.person).filter((k) => SECRET_KEYS.includes(k));
    check("it carries no password hash or token", oneSecretKeys.length === 0,
      `leaked: ${oneSecretKeys.join(", ")}`);

    const oneExtraKeys = leakedKeys(one.json?.person);
    check("`person` carries only public profile fields", oneExtraKeys.length === 0,
      `also carries: ${oneExtraKeys.join(", ")}`);

    // The account-takeover half: this is the value POST /api/users/reset-password redeems.
    check("the victim's live reset token is not in the response",
      !JSON.stringify(one.json ?? null).includes(`reset-victim-${RUN}`));

    console.log("\nWrites return no account secrets either\n");

    const put = await call("PUT", `/api/campaign-members/${victimMemberId}`, gm, { status: "Inactive" });
    check("the GM can edit a membership", put.status === 200, `got ${put.status} ${JSON.stringify(put.json)}`);
    check("PUT returns no secret value", leakedValues(put.json).length === 0,
      `found: ${leakedValues(put.json).join(", ")}`);

    const post = await call("POST", "/api/campaign-members", gm,
      { campaign: campaignId, person: newcomer.id, status: "Active" });
    check("the GM can add a member", post.status === 201, `got ${post.status} ${JSON.stringify(post.json)}`);
    check("POST returns no secret value", leakedValues(post.json).length === 0,
      `found: ${leakedValues(post.json).join(", ")}`);

    // DELETE decides "is this you?" from the populated person's _id, so narrowing
    // the populate must not cost a player the ability to leave.
    const del = await call("DELETE", `/api/campaign-members/${playerMemberId}`, player);
    check("a player can still remove themselves", del.status === 200, `got ${del.status} ${JSON.stringify(del.json)}`);
    check("DELETE returns no secret value", leakedValues(del.json).length === 0,
      `found: ${leakedValues(del.json).join(", ")}`);
  } finally {
    server.close();
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
