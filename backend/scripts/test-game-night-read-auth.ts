/**
 * Regression test (#238): Game Night read endpoints that needed no login, or
 * handed every signed-in account everything.
 *
 * - GET /api/tabletop/dungeons and /encounters answered anyone, logged in or
 *   not. They now need a login, and a non-admin sees only what touches their
 *   campaigns.
 * - GET /api/events and /api/events/:id returned every event to every
 *   signed-in account, and "prepare session" events carried the GM's agenda.
 *   An event is now its creator's; admins see all, and the owner-less rows
 *   from before #238 are admin-only.
 *
 * Mounts the real routers the way server.ts does and drives them over HTTP.
 *
 * Run against a throwaway database loaded from db/schema.sql (it refuses to run
 * against anything but localhost):
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-game-night-read-auth.ts
 */
import "./use-test-jwt-secret.js";
import express from "express";
import type { AddressInfo } from "net";
import pool from "../db/index.js";
import eventRoutes from "../routes/eventRoutes.js";
import tabletopRoutes from "../routes/tabletopRoutes.js";
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

const RUN = Math.random().toString(36).slice(2, 8);
type Who = { id: string; email: string };

async function account(handle: string, appRole = "user"): Promise<Who> {
  const { rows } = await pool.query(
    `INSERT INTO accounts (id, handle, name, email, app_role)
     VALUES (gen_random_uuid(), $1, $1, $2, $3) RETURNING id, email`,
    [`${handle}-${RUN}`, `${handle}.${RUN}@example.test`, appRole]);
  return { id: rows[0].id, email: rows[0].email };
}

const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];

async function main() {
  const app = express();
  app.use(express.json());
  app.use("/api/events", eventRoutes);
  app.use("/api/tabletop", tabletopRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call = async (method: string, path: string, who: Who | null, body?: unknown) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (who) headers.authorization = `Bearer ${signJwt({ id: who.id, email: who.email })}`;
    const res = await fetch(`${base}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) as any };
  };
  const ids = (rows: any) => new Set((Array.isArray(rows) ? rows : []).map((r: any) => String(r._id ?? r.id)));

  try {
    const admin = await account("admin", "admin");
    const gm = await account("gm");
    const player = await account("player");
    const outsider = await account("outsider");

    const ours = (await one(`INSERT INTO campaigns (title) VALUES ('Ours') RETURNING id`)).id;
    const theirs = (await one(`INSERT INTO campaigns (title) VALUES ('Theirs') RETURNING id`)).id;
    await pool.query(
      `INSERT INTO campaign_members (campaign_id, person_id, status) VALUES ($1, $2, 'Game Master'), ($1, $3, 'Active')`,
      [ours, gm.id, player.id]);

    const ourSession = (await one(
      `INSERT INTO game_sessions (title, campaign_id) VALUES ('Night one', $1) RETURNING id`, [ours])).id;
    const theirSession = (await one(
      `INSERT INTO game_sessions (title, campaign_id) VALUES ('Elsewhere', $1) RETURNING id`, [theirs])).id;
    const ourDungeon = (await one(`INSERT INTO dungeons (name) VALUES ('Our crypt') RETURNING id`)).id;
    const charDungeon = (await one(`INSERT INTO dungeons (name) VALUES ('Our cave') RETURNING id`)).id;
    const theirDungeon = (await one(`INSERT INTO dungeons (name) VALUES ('Their tower') RETURNING id`)).id;
    const ourEncounter = (await one(
      `INSERT INTO encounters (name, session_id, dungeon_id) VALUES ('Skeletons', $1, $2) RETURNING id`,
      [ourSession, ourDungeon])).id;
    const theirEncounter = (await one(
      `INSERT INTO encounters (name, session_id, dungeon_id) VALUES ('Wizard', $1, $2) RETURNING id`,
      [theirSession, theirDungeon])).id;
    await pool.query(
      `INSERT INTO characters (name, player_id, campaign_id, dungeon_id) VALUES ('Brin', $1, $2, $3)`,
      [player.id, ours, charDungeon]);

    console.log("\nDungeons and encounters need a login\n");
    for (const path of ["/api/tabletop/dungeons", "/api/tabletop/encounters"]) {
      const r = await call("GET", path, null);
      check(`GET ${path} without a token is 401`, r.status === 401, `got ${r.status}`);
    }

    console.log("\nA player sees only their campaign's\n");
    const enc = await call("GET", "/api/tabletop/encounters", player);
    const encIds = ids(enc.json);
    check("the player sees their session's encounter", enc.status === 200 && encIds.has(ourEncounter),
      `got ${enc.status} ${JSON.stringify(enc.json)}`);
    check("but not another campaign's", !encIds.has(theirEncounter));

    const dun = await call("GET", "/api/tabletop/dungeons", player);
    const dunIds = ids(dun.json);
    check("the player sees the dungeon of their encounter", dun.status === 200 && dunIds.has(ourDungeon),
      `got ${dun.status} ${JSON.stringify(dun.json)}`);
    check("and the one their campaign's character is in", dunIds.has(charDungeon));
    check("but not another campaign's dungeon", !dunIds.has(theirDungeon));

    const outEnc = await call("GET", "/api/tabletop/encounters", outsider);
    const outDun = await call("GET", "/api/tabletop/dungeons", outsider);
    check("someone in no campaign gets no encounters", outEnc.status === 200 && ids(outEnc.json).size === 0,
      `got ${outEnc.status} ${JSON.stringify(outEnc.json)}`);
    check("and no dungeons", outDun.status === 200 && ids(outDun.json).size === 0,
      `got ${outDun.status} ${JSON.stringify(outDun.json)}`);

    const adminEnc = ids((await call("GET", "/api/tabletop/encounters", admin)).json);
    const adminDun = ids((await call("GET", "/api/tabletop/dungeons", admin)).json);
    check("an admin sees every encounter", adminEnc.has(ourEncounter) && adminEnc.has(theirEncounter));
    check("and every dungeon", adminDun.has(ourDungeon) && adminDun.has(theirDungeon) && adminDun.has(charDungeon));

    console.log("\nEvents are their creator's\n");
    const legacy = (await one(
      `INSERT INTO events (title, description, start_date, end_date) VALUES ('Old one', 'old agenda', now(), now()) RETURNING id`)).id;

    const made = await call("POST", "/api/events", player,
      { title: "Player's night", status: "Not Started", startDate: new Date(), endDate: new Date() });
    const playerEvent = String(made.json?.event?.id ?? "");
    check("a player can create an event", made.status === 201 && !!playerEvent, `got ${made.status}`);
    const owner = playerEvent && (await one(`SELECT owner_id FROM events WHERE id = $1`, [playerEvent]))?.owner_id;
    check("it is stored as theirs", owner === player.id, `owner_id ${owner}`);

    const prepared = await call("POST", "/api/tabletop/prepare-session", gm,
      { title: "Night two", campaignId: ours, date: new Date(Date.now() + 86_400_000), agenda: "the twist" });
    const gmEvent = String(prepared.json?.event?._id ?? "");
    check("the GM can prepare a session", prepared.status === 201 && !!gmEvent,
      `got ${prepared.status} ${JSON.stringify(prepared.json)}`);
    const gmOwner = gmEvent && (await one(`SELECT owner_id FROM events WHERE id = $1`, [gmEvent]))?.owner_id;
    check("its event is the GM's", gmOwner === gm.id, `owner_id ${gmOwner}`);

    const playerList = await call("GET", "/api/events", player);
    const pl = ids(playerList.json);
    check("the player lists their own event", playerList.status === 200 && pl.has(playerEvent),
      `got ${playerList.status}`);
    check("but not the GM's prepared one", !pl.has(gmEvent));
    check("nor an owner-less one from before", !pl.has(legacy));
    check("no event the player lists carries the GM's agenda",
      !JSON.stringify(playerList.json ?? null).includes("the twist"));

    const peek = await call("GET", `/api/events/${gmEvent}`, player);
    check("reading the GM's event by id is 404 for the player", peek.status === 404, `got ${peek.status}`);
    const peekLegacy = await call("GET", `/api/events/${legacy}`, outsider);
    check("and an owner-less one is 404 for a non-admin", peekLegacy.status === 404, `got ${peekLegacy.status}`);
    const own = await call("GET", `/api/events/${playerEvent}`, player);
    check("the player can read their own by id", own.status === 200 && own.json?.title === "Player's night",
      `got ${own.status}`);
    const junk = await call("GET", "/api/events/not-a-uuid", player);
    check("a malformed id is 404, not 500", junk.status === 404, `got ${junk.status}`);

    const adminList = ids((await call("GET", "/api/events", admin)).json);
    check("an admin lists every event, owner-less included",
      adminList.has(playerEvent) && adminList.has(gmEvent) && adminList.has(legacy));
    const adminRead = await call("GET", `/api/events/${legacy}`, admin);
    check("and reads an owner-less one by id", adminRead.status === 200, `got ${adminRead.status}`);

    const anon = await call("GET", "/api/events", null);
    check("GET /api/events without a token is still 401", anon.status === 401, `got ${anon.status}`);
  } finally {
    server.close();
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
