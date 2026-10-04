/**
 * Threads module (#97): thread keys and the one access check.
 *
 * A thread is `campaign:<id>` (a campaign's Table Talk) or `dm:<dm_key>` (a
 * friend DM, dm_key being the sorted id pair). The module answers "which
 * threads can this person see" and "may this person into this thread", and the
 * existing campaign and DM message endpoints authorize through it.
 *
 * Covers, at the module and over HTTP (the real router, mounted the way
 * server.ts mounts it):
 *   - a member vs. a non-member of a campaign;
 *   - a friend vs. a non-friend for DMs;
 *   - an admin who isn't a member: REST access yes, visible thread no;
 *   - malformed thread keys refused.
 *
 * Run against a throwaway database loaded from db/schema.sql (it refuses to run
 * against anything but localhost). It deletes every row it creates.
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-threads.ts
 */
import "./use-test-jwt-secret.js";
import express from "express";
import type { AddressInfo } from "net";
import pool from "../db/index.js";
import { signJwt } from "../utils/jwt.js";
import {
  visibleThreadKeys, canAccessThread, campaignThreadKey, dmThreadKey, parseThreadKey,
} from "../services/threads.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
  process.exit(2);
}

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? pass++ : fail++;
}

/** Keeps reruns against the same database clear of the unique email index. */
const RUN = Math.random().toString(36).slice(2, 8);

type Person = { id: string; email: string };

const created = { accounts: [] as string[], campaigns: [] as string[] };

async function account(handle: string, appRole: "user" | "admin" = "user"): Promise<Person> {
  const { rows } = await pool.query(
    `INSERT INTO accounts (id, handle, name, email, app_role)
     VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id, email`,
    [`t97-${handle}-${RUN}`, `${handle} name`, `t97.${handle}.${RUN}@example.test`, appRole]);
  created.accounts.push(rows[0].id);
  return { id: rows[0].id, email: rows[0].email };
}

async function campaign(title: string, status = "In Progress"): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO campaigns (title, status) VALUES ($1, $2) RETURNING id`, [`t97 ${title} ${RUN}`, status]);
  created.campaigns.push(rows[0].id);
  return rows[0].id;
}

async function member(campaignId: string, person: Person, status = "Active") {
  await pool.query(
    `INSERT INTO campaign_members (campaign_id, person_id, status) VALUES ($1, $2, $3)`,
    [campaignId, person.id, status]);
}

/** Friendship is symmetric: friendRoutes adds each side to the other's list. */
async function befriend(a: Person, b: Person) {
  await pool.query(`UPDATE accounts SET friends = array_append(friends, $2) WHERE id = $1`, [a.id, b.id]);
  await pool.query(`UPDATE accounts SET friends = array_append(friends, $2) WHERE id = $1`, [b.id, a.id]);
}

const pairKey = (a: Person, b: Person) => [a.id, b.id].sort().join(":");
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && new Set(a).size === a.length && b.every((x) => a.includes(x));

async function cleanup() {
  const { accounts, campaigns } = created;
  if (!accounts.length && !campaigns.length) return;
  // DM rows carry no FK to either side; campaign rows cascade with the campaign.
  await pool.query(`DELETE FROM messages WHERE campaign_id = ANY($1::uuid[]) OR sender_id = ANY($2::text[])`,
    [campaigns, accounts]);
  await pool.query(`DELETE FROM notifications WHERE user_id = ANY($1::uuid[])`, [accounts]);
  await pool.query(`DELETE FROM campaigns WHERE id = ANY($1::uuid[])`, [campaigns]);
  await pool.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [accounts]);
}

async function main() {
  const { default: messageRoutes } = await import("../routes/messageRoutes.js");
  const app = express();
  app.use(express.json());
  app.use("/api/messages", messageRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const tokenFor = (p: Person) => signJwt({ id: p.id, email: p.email });
  const call = async (method: string, path: string, who: Person, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${tokenFor(who)}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) as any };
  };

  try {
    const gm = await account("gm");
    const player = await account("player");
    const outsider = await account("outsider");
    const admin = await account("admin", "admin");
    const friend = await account("friend");
    const stranger = await account("stranger");

    const keep = await campaign("Curse of Strahd");
    const done = await campaign("Lost Mine", "Completed");
    for (const c of [keep, done]) {
      await member(c, gm, "Game Master");
      await member(c, player);
    }
    await befriend(player, friend);

    console.log("\nThread keys\n");

    check("campaign thread key is campaign:<id>", campaignThreadKey(keep) === `campaign:${keep}`);
    check("DM thread key is dm:<sorted pair>, whichever side asks",
      dmThreadKey(player.id, friend.id) === `dm:${pairKey(player, friend)}`
        && dmThreadKey(friend.id, player.id) === `dm:${pairKey(player, friend)}`);
    const parsedDm = parseThreadKey(`dm:${pairKey(player, friend)}`);
    check("a DM key parses to its dm_key and both people",
      parsedDm?.kind === "dm" && parsedDm.dmKey === pairKey(player, friend)
        && sameSet([...parsedDm.people], [player.id, friend.id]),
      `got ${JSON.stringify(parsedDm)}`);
    const parsedCampaign = parseThreadKey(`campaign:${keep}`);
    check("a campaign key parses to its campaign id",
      parsedCampaign?.kind === "campaign" && parsedCampaign.campaignId === keep,
      `got ${JSON.stringify(parsedCampaign)}`);

    console.log("\nVisible threads\n");

    const playerKeys = await visibleThreadKeys(player);
    check("a member sees each campaign (whatever its status) and one DM per friend",
      sameSet(playerKeys, [`campaign:${keep}`, `campaign:${done}`, `dm:${pairKey(player, friend)}`]),
      `got ${JSON.stringify(playerKeys)}`);

    const friendKeys = await visibleThreadKeys(friend);
    check("the friend sees the same DM thread", sameSet(friendKeys, [`dm:${pairKey(player, friend)}`]),
      `got ${JSON.stringify(friendKeys)}`);

    const outsiderKeys = await visibleThreadKeys(outsider);
    check("a non-member with no friends sees no threads", outsiderKeys.length === 0,
      `got ${JSON.stringify(outsiderKeys)}`);

    const adminKeys = await visibleThreadKeys(admin);
    check("an admin who isn't a member sees no campaign threads", adminKeys.length === 0,
      `got ${JSON.stringify(adminKeys)}`);

    console.log("\nThe access check\n");

    check("a member may access the campaign thread", await canAccessThread(player, `campaign:${keep}`));
    check("a member may access a Completed campaign's thread", await canAccessThread(player, `campaign:${done}`));
    check("a non-member may not access the campaign thread",
      !(await canAccessThread(outsider, `campaign:${keep}`)));
    check("an admin who isn't a member may access the campaign thread (REST access)",
      await canAccessThread(admin, `campaign:${keep}`));
    check("a friend may access the DM thread", await canAccessThread(player, `dm:${pairKey(player, friend)}`)
      && await canAccessThread(friend, `dm:${pairKey(player, friend)}`));
    check("a non-friend may not access a DM thread with them",
      !(await canAccessThread(stranger, dmThreadKey(stranger.id, player.id))));
    check("a third party may not access someone else's DM thread",
      !(await canAccessThread(gm, `dm:${pairKey(player, friend)}`)));
    await befriend(gm, player);
    check("...not even once they're friends with one side",
      !(await canAccessThread(gm, `dm:${pairKey(player, friend)}`)));
    check("an admin may not access a DM thread they're not in",
      !(await canAccessThread(admin, `dm:${pairKey(player, friend)}`)));

    const [lo, hi] = [player.id, friend.id].sort();
    const malformed: Record<string, string> = {
      "empty": "",
      "no kind": keep,
      "unknown kind": `group:${keep}`,
      "campaign without id": "campaign:",
      "campaign id not a uuid": "campaign:not-a-uuid",
      "campaign id with trailing junk": `campaign:${keep}:x`,
      "DM with one id": `dm:${player.id}`,
      "DM with three ids": `dm:${lo}:${hi}:${lo}`,
      "DM pair unsorted": `dm:${hi}:${lo}`,
      "DM with yourself": `dm:${player.id}:${player.id}`,
      "DM id not a uuid": `dm:${lo}:nope`,
      "uppercase kind": `CAMPAIGN:${keep}`,
    };
    for (const [label, key] of Object.entries(malformed)) {
      check(`refuses a malformed key (${label})`,
        parseThreadKey(key) === null && !(await canAccessThread(player, key)) && !(await canAccessThread(admin, key)));
    }
    check("refuses a key that isn't a string", parseThreadKey(undefined as any) === null
      && !(await canAccessThread(player, 42 as any)));

    console.log("\nCampaign endpoints\n");

    const path = `/api/messages/campaign/${keep}`;
    const sent = await call("POST", path, player, { body: "t97 hello table" });
    check("a member can send (201)", sent.status === 201 && sent.json?.body === "t97 hello table",
      `got ${sent.status} ${JSON.stringify(sent.json)}`);
    const history = await call("GET", path, player);
    check("a member can read history (200)", history.status === 200 && Array.isArray(history.json)
      && history.json.some((m: any) => m.body === "t97 hello table"), `got ${history.status}`);

    const notMember = { error: "Not a member of this campaign" };
    for (const [label, res] of [
      ["history", await call("GET", path, outsider)],
      ["send", await call("POST", path, outsider, { body: "t97 let me in" })],
      ["history (campaign id not a uuid)", await call("GET", "/api/messages/campaign/not-a-uuid", player)],
    ] as const) {
      check(`a non-member is refused ${label} with 403`,
        res.status === 403 && JSON.stringify(res.json) === JSON.stringify(notMember),
        `got ${res.status} ${JSON.stringify(res.json)}`);
    }

    const adminHistory = await call("GET", path, admin);
    check("an admin who isn't a member can still read any campaign's history",
      adminHistory.status === 200 && adminHistory.json?.some((m: any) => m.body === "t97 hello table"),
      `got ${adminHistory.status}`);

    console.log("\nDM endpoints\n");

    const dmPath = `/api/messages/dm/${friend.id}`;
    const dmSent = await call("POST", dmPath, player, { body: "t97 hi friend" });
    check("a friend can send a DM (201)",
      dmSent.status === 201 && dmSent.json?.dmKey === pairKey(player, friend),
      `got ${dmSent.status} ${JSON.stringify(dmSent.json)}`);
    const dmHistory = await call("GET", `/api/messages/dm/${player.id}`, friend);
    check("the other side reads the same DM history (200)", dmHistory.status === 200
      && dmHistory.json?.some((m: any) => m.body === "t97 hi friend"), `got ${dmHistory.status}`);

    const friendsOnly = { error: "You can only message friends" };
    for (const [label, res] of [
      ["history", await call("GET", `/api/messages/dm/${player.id}`, stranger)],
      ["send", await call("POST", `/api/messages/dm/${player.id}`, stranger, { body: "t97 psst" })],
      ["history (admin)", await call("GET", `/api/messages/dm/${player.id}`, admin)],
      ["history (yourself)", await call("GET", `/api/messages/dm/${player.id}`, player)],
      ["history (not a uuid)", await call("GET", `/api/messages/dm/not-a-uuid`, player)],
    ] as const) {
      check(`a non-friend is refused DM ${label} with 403`,
        res.status === 403 && JSON.stringify(res.json) === JSON.stringify(friendsOnly),
        `got ${res.status} ${JSON.stringify(res.json)}`);
    }
  } finally {
    server.closeAllConnections?.();
    server.close();
    await cleanup().catch((e) => console.error("cleanup failed:", e));
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => {});
  process.exit(1);
});
