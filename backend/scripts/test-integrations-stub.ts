/**
 * External integrations are stubbable (#79, part of #57).
 *
 * Installs the recording fake from testing/fakeIntegrations.ts, mounts the real
 * tabletop, API-key and planning routers, and drives them over HTTP with real
 * JWTs against a throwaway database loaded from db/schema.sql. Checks what's
 * visible from outside: responses, warnings, stored event ids and links, and
 * the exact Discord / Google calls the fake received -- including calls it was
 * told to fail.
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-integrations-stub.ts
 */
import express from "express";
import type { AddressInfo } from "net";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import jwt from "jsonwebtoken";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
    console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
    process.exit(2);
}
// The API Key Vault encrypts with this; a fresh throwaway key for this run.
process.env.VAULT_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

const { default: pool } = await import("../db/index.js");
const { default: tabletopRoutes } = await import("../routes/tabletopRoutes.js");
const { default: apiKeyRoutes } = await import("../routes/apiKeyRoutes.js");
const { buildPlanningRouter } = await import("../routes/planningRoutes.js");
const { createPlanner } = await import("../planning/planner.js");
const { buildGoogleCalendarLink, integrations, realIntegrations } = await import("../utils/integrations.js");
const { createFakeIntegrations } = await import("../testing/fakeIntegrations.js");

const SECRET = process.env.JWT_SECRET || "your-secret-key-change-this";
const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
    const d = typeof detail === "string" ? detail : JSON.stringify(detail);
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !d ? "" : `\n          ${d}`}`);
    ok ? pass++ : fail++;
}

/** Every backend source file that isn't a test script or test support. */
function productionSources(root: string): string[] {
    const out: string[] = [];
    const skip = new Set(["node_modules", "dist", "scripts", "testing"]);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!skip.has(entry.name) && !entry.name.startsWith(".")) out.push(...productionSources(path.join(root, entry.name)));
        } else if (/\.(ts|js|cjs|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
            out.push(path.join(root, entry.name));
        }
    }
    return out;
}

async function main() {
    const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

    console.log("\n#79 — external integrations are stubbable\n");

    // ── production never loads the fake ─────────────────────────────────────
    const sources = productionSources(backendRoot);
    const importers = sources.filter((f) => /(from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*(testing\/|fakeIntegrations)/.test(fs.readFileSync(f, "utf8")))
        .map((f) => path.relative(backendRoot, f));
    check(`no production source (${sources.length} files) imports the fake or anything under testing/`,
        sources.length > 50 && importers.length === 0, importers);
    check("until a test installs one, the integrations module is the real one", integrations() === realIntegrations);
    const direct = sources.filter((f) => !f.endsWith(path.join("utils", "integrations.ts")) &&
        /discord\.com\/api|googleapis\.com\/calendar|createDiscordScheduledEvent|createGoogleCalendarEvent/.test(fs.readFileSync(f, "utf8")))
        .map((f) => path.relative(backendRoot, f));
    check("nothing outside the integrations module calls the Discord or Google Calendar APIs", direct.length === 0, direct);

    const fake = createFakeIntegrations();
    const uninstall = fake.install();
    check("installing the fake swaps the module", integrations() === fake.integrations);

    const app = express();
    app.use(express.json());
    app.use("/api/tabletop", tabletopRoutes);
    app.use("/api/api-keys", apiKeyRoutes);
    app.use("/api/planning", buildPlanningRouter(createPlanner()));   // the real ExternalEvents
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const tag = crypto.randomBytes(4).toString("hex");
    const who: Record<string, { id: string; token: string }> = {};
    let campaignId = "";

    const call = async (method: string, urlPath: string, as?: string, body?: unknown) => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (as) headers.authorization = `Bearer ${who[as].token}`;
        const res = await fetch(`${base}${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        return { status: res.status, json };
    };
    const row = async (id: string) => (await pool.query(`SELECT * FROM game_sessions WHERE id = $1`, [id])).rows[0];

    const t0 = Math.ceil((Date.now() + 7 * DAY) / HOUR) * HOUR;
    const slot = (dayOffset: number, hours = 4) => ({
        start: new Date(t0 + dayOffset * DAY).toISOString(), end: new Date(t0 + dayOffset * DAY + hours * HOUR).toISOString(),
    });
    const create = (as: string, extra: Record<string, unknown> = {}, day = 0) => call("POST", "/api/tabletop/sessions", as, {
        title: "One-shot", campaign: campaignId, date: slot(day).start, endDate: slot(day).end,
        location: "Hearthside Games", agenda: "The Sunken Bell", ...extra,
    });
    const linkFor = (day: number, location = "Hearthside Games") => buildGoogleCalendarLink({
        title: "Ashen Crown: One-shot", description: "The Sunken Bell", location,
        start: new Date(slot(day).start), end: new Date(slot(day).end),
    });

    try {
        for (const name of ["gm", "p1", "outsider"]) {
            const email = `integ-${name}-${tag}@example.test`;
            const { rows: [acct] } = await pool.query(
                `INSERT INTO accounts (id, handle, email, app_role, app_role_source) VALUES (gen_random_uuid(), $1, $2, 'user', 'manual') RETURNING id`,
                [`${name}_${tag}`, email]);
            who[name] = { id: acct.id, token: jwt.sign({ id: acct.id, email }, SECRET, { expiresIn: "1h" }) };
        }
        const { rows: [camp] } = await pool.query(
            `INSERT INTO campaigns (title, owner_id, discord_guild_id) VALUES ('Ashen Crown', $1, '987654321') RETURNING id`, [who.gm.id]);
        campaignId = camp.id;
        for (const [i, [name, status]] of ([["gm", "Game Master"], ["p1", "Player"]] as const).entries()) {
            await pool.query(`INSERT INTO campaign_members (campaign_id, person_id, status, joined_at) VALUES ($1, $2, $3, $4)`,
                [campaignId, who[name].id, status, new Date(Date.UTC(2026, 0, 1 + i))]);
        }

        // ── who may create ──────────────────────────────────────────────────
        const both = { createDiscordEvent: true, createGoogleEvent: true };
        const asPlayer = await create("p1", both);
        check("a player who isn't the Game Master is rejected (403), as before",
            asPlayer.status === 403 && asPlayer.json.error === "Only the Game Master can create sessions for this campaign", asPlayer.json);
        const asOutsider = await create("outsider", both);
        check("someone outside the party is rejected (403)", asOutsider.status === 403 && asOutsider.json.error === "Unauthorized", asOutsider.json);
        check("...and neither reached Discord or Google", fake.calls().length === 0, fake.calls());

        // ── no keys in the vault: nothing leaves the app ────────────────────
        const noKeys = await create("gm", both);
        check("with an empty vault: 201 and the same two warnings as before",
            noKeys.status === 201 && JSON.stringify(noKeys.json.warnings) === JSON.stringify([
                "Discord event skipped: no 'discord' bot token in your API Key Vault.",
                "Google Calendar not connected — shareable link created, but no event was added to your calendar.",
            ]), noKeys.json);
        check("...the shareable Google link is still made, and no event ids",
            noKeys.json.googleCalendarLink === linkFor(0) && !noKeys.json.discordEventId && !noKeys.json.googleEventId, noKeys.json);
        check("...and no outside call was made", fake.calls().length === 0, fake.calls());

        const bot = `bot-token-${tag}`, refresh = `refresh-token-${tag}`;
        const putKey = (provider: string, secret: string) => call("PUT", `/api/api-keys/${provider}`, "gm", { keyId: `${provider}-id`, secret });
        check("the GM stores a Discord bot token and a Google refresh token",
            (await putKey("discord", bot)).status === 200 && (await putKey("google_calendar", refresh)).status === 200);

        // ── Discord only ────────────────────────────────────────────────────
        fake.clear();
        const d = await create("gm", { createDiscordEvent: true }, 1);
        const [dCall] = fake.calls("discord.createScheduledEvent");
        check("Discord only: 201, no warnings, one Discord call and no Google call",
            d.status === 201 && d.json.warnings.length === 0 && fake.calls().length === 1 && dCall !== undefined, { res: d.json, calls: fake.calls() });
        check("...the call carries the GM's bot token, the linked server and the session's details",
            dCall?.args[0].botToken === bot && dCall.args[0].guildId === "987654321" && dCall.args[0].channelId === undefined &&
                dCall.args[0].name === "Ashen Crown: One-shot" && dCall.args[0].description === "The Sunken Bell" &&
                dCall.args[0].location === "Hearthside Games" && dCall.args[0].start.toISOString() === slot(1).start &&
                dCall.args[0].end?.toISOString() === slot(1).end, dCall?.args);
        const dRow = await row(d.json.id);
        check("...the returned event id is in the response and stored; no Google link",
            d.json.discordEventId === dCall?.result?.id && dRow.discord_event_id === dCall?.result?.id &&
                !dRow.google_event_id && !dRow.google_calendar_link, dRow);

        // ── Google only ─────────────────────────────────────────────────────
        fake.clear();
        const g = await create("gm", { createGoogleEvent: true, location: "", isOnline: true }, 2);
        const [gCall] = fake.calls("google.createCalendarEvent");
        check("Google only: 201, no warnings, one Google call and no Discord call",
            g.status === 201 && g.json.warnings.length === 0 && fake.calls().length === 1 && gCall !== undefined, { res: g.json, calls: fake.calls() });
        check("...with the GM's refresh token, and \"Online\" standing in for an online session's location",
            gCall?.args[0] === refresh && gCall.args[1].title === "Ashen Crown: One-shot" && gCall.args[1].location === "Online" &&
                gCall.args[1].start.toISOString() === slot(2).start && gCall.args[1].end.toISOString() === slot(2).end, gCall?.args);
        const gRow = await row(g.json.id);
        check("...the event id and shareable link are in the response and stored",
            g.json.googleEventId === gCall?.result?.id && gRow.google_event_id === gCall?.result?.id &&
                g.json.googleCalendarLink === linkFor(2, "Online") && gRow.google_calendar_link === linkFor(2, "Online") &&
                !gRow.discord_event_id, gRow);

        // ── both ────────────────────────────────────────────────────────────
        fake.clear();
        const b = await create("gm", both, 3);
        const bRow = await row(b.json.id);
        check("both: 201, no warnings, Discord then Google, and both ids stored",
            b.status === 201 && b.json.warnings.length === 0 &&
                fake.calls().map((c) => c.name).join() === "discord.createScheduledEvent,google.createCalendarEvent" &&
                bRow.discord_event_id === fake.calls("discord.createScheduledEvent")[0]?.result?.id &&
                bRow.google_event_id === fake.calls("google.createCalendarEvent")[0]?.result?.id &&
                bRow.google_calendar_link === linkFor(3), { res: b.json, calls: fake.calls().map((c) => c.name) });

        // ── failing calls warn; creation still succeeds ─────────────────────
        fake.clear();
        fake.fail("discord.createScheduledEvent", new Error("Discord API 403: Missing Permissions"));
        const df = await create("gm", both, 4);
        const dfRow = await row(df.json.id);
        check("Discord fails: the session is still created, with the old warning wording",
            df.status === 201 && JSON.stringify(df.json.warnings) === JSON.stringify(["Discord event failed: Discord API 403: Missing Permissions"]), df.json);
        check("...the failed call was recorded, Google still went ahead, and only the Google id is stored",
            fake.calls("discord.createScheduledEvent")[0]?.error?.message === "Discord API 403: Missing Permissions" &&
                !dfRow.discord_event_id && dfRow.google_event_id === fake.calls("google.createCalendarEvent")[0]?.result?.id, dfRow);

        fake.clear();
        fake.fail("google.createCalendarEvent", new Error("Google Calendar API 401: invalid_grant"));
        const gf = await create("gm", both, 5);
        const gfRow = await row(gf.json.id);
        check("Google fails: still created, warned, and the shareable link is kept",
            gf.status === 201 && JSON.stringify(gf.json.warnings) === JSON.stringify(["Google Calendar event failed: Google Calendar API 401: invalid_grant"]) &&
                !gfRow.google_event_id && gfRow.google_calendar_link === linkFor(5) && gfRow.discord_event_id === fake.calls("discord.createScheduledEvent")[0]?.result?.id, gf.json);

        fake.clear();
        fake.fail("discord.createScheduledEvent");
        fake.fail("google.createCalendarEvent");
        const bf = await create("gm", both, 6);
        check("both fail: still created, with one warning each",
            bf.status === 201 && bf.json.warnings.length === 2 && /^Discord event failed: /.test(bf.json.warnings[0]) &&
                /^Google Calendar event failed: /.test(bf.json.warnings[1]), bf.json);

        fake.clear();
        const after = await create("gm", both, 7);
        check("a failure is used up once it fires: the next session's calls succeed",
            after.json.warnings.length === 0 && fake.calls().every((c) => !c.error) && fake.calls().length === 2, after.json);

        fake.clear();
        fake.fail("discord.createScheduledEvent", new Error("down"), { times: Infinity });
        const f1 = await create("gm", { createDiscordEvent: true }, 8);
        const f2 = await create("gm", { createDiscordEvent: true }, 9);
        check("a failure can be made to stick until the fake is reset",
            f1.json.warnings[0] === "Discord event failed: down" && f2.json.warnings[0] === "Discord event failed: down");
        fake.reset();

        // ── nothing to create, or not allowed to ────────────────────────────
        fake.clear();
        const plain = await create("gm", {}, 10);
        check("no external events asked for: no calls, no warnings", plain.status === 201 && plain.json.warnings.length === 0 && fake.calls().length === 0, plain.json);
        const noEnd = await call("POST", "/api/tabletop/sessions", "gm", { title: "x", campaign: campaignId, date: slot(11).start, ...both });
        check("asking for events without an end time is still a 400, with no calls", noEnd.status === 400 && fake.calls().length === 0, noEnd.json);

        // ── the planner reaches Discord and Google through the same module ──
        const P = (sid: string, action = "") => `/api/planning/sessions/${sid}${action ? `/${action}` : ""}`;
        const planNight = async (title: string, day: number) => {
            const k = await call("POST", `/api/planning/campaigns/${campaignId}/kickoff`, "gm", { title, isOnline: true });
            const sid = k.json.session.id;
            const sl = await call("POST", P(sid, "shortlist"), "gm", { options: [slot(day), slot(day + 1)] });
            const first = sl.json.night.options[0].id;
            await call("POST", P(sid, "vote"), "p1", { optionIds: [first] });
            const last = await call("POST", P(sid, "vote"), "gm", { optionIds: [first] });
            return { sid, last };
        };
        fake.clear();
        const online = await planNight("Session 1", 12);
        const onlineRow = await row(online.sid);
        const [pd] = fake.calls("discord.createScheduledEvent"), [pg] = fake.calls("google.createCalendarEvent");
        check("an online night confirmed by the planner: one Discord and one Google call, with the GM's keys",
            online.last.json.session.status === "scheduled" && fake.calls().length === 2 &&
                pd?.args[0].botToken === bot && pd.args[0].guildId === "987654321" && pd.args[0].name === "Ashen Crown: Session 1" &&
                pg?.args[0] === refresh && pg.args[1].start.toISOString() === slot(12).start, fake.calls());
        check("...and the planner stores what they returned",
            onlineRow.discord_event_id === pd?.result?.id && onlineRow.google_event_id === pg?.result?.id && !!onlineRow.google_calendar_link, onlineRow);

        fake.clear();
        fake.fail("google.createCalendarEvent", new Error("Google Calendar API 500: backend error"));
        const shaky = await planNight("Session 2", 14);
        const bell = await pool.query(
            `SELECT body FROM notifications WHERE user_id = $1 AND title LIKE '%with a problem' AND meta->>'sessionId' = $2`, [who.gm.id, shaky.sid]);
        check("a planner call that fails still schedules the night, and the GM's bell gets the warning",
            shaky.last.json.session.status === "scheduled" && bell.rows[0]?.body?.includes("Google Calendar event failed: Google Calendar API 500"), bell.rows);

        // ── the uploads seam banners will use ───────────────────────────────
        fake.clear();
        const put = await integrations().uploads.presignPut({ key: `banners/${campaignId}/a.webp`, contentType: "image/webp", contentLength: 1234 });
        check("a presigned upload goes through the module: recorded, with a URL, headers and expiry",
            fake.calls("uploads.presignPut")[0]?.args[0].key === `banners/${campaignId}/a.webp` && put.method === "PUT" &&
                put.key === `banners/${campaignId}/a.webp` && /^https:\/\//.test(put.url) && put.headers["Content-Type"] === "image/webp" &&
                put.expiresAt > new Date(), put);
        fake.respond("uploads.presignPut", async (input) => ({
            url: "https://bucket.example/custom", method: "PUT", key: input.key, headers: {}, expiresAt: new Date(Date.now() + 60_000),
        }));
        check("a test can script what a call returns",
            (await integrations().uploads.presignPut({ key: "k", contentType: "image/png", contentLength: 1 })).url === "https://bucket.example/custom");
        let realError = "";
        try { await realIntegrations.uploads.presignPut({ key: "k", contentType: "image/png", contentLength: 1 }); }
        catch (err: any) { realError = err.message; }
        check("the real presigner refuses clearly until S3 is configured", /not configured/i.test(realError), realError);

        uninstall();
        check("uninstalling puts the real module back", integrations() === realIntegrations);
    } finally {
        uninstall();
        const ids = Object.values(who).map((p) => p.id);
        if (campaignId) await pool.query(`DELETE FROM campaigns WHERE id = $1`, [campaignId]);
        if (ids.length) {
            await pool.query(`DELETE FROM api_key_vault WHERE user_id = ANY($1)`, [ids]);
            await pool.query(`DELETE FROM notifications WHERE user_id = ANY($1)`, [ids]);
            await pool.query(`DELETE FROM accounts WHERE id = ANY($1)`, [ids]);
        }
        server.close();
    }

    console.log(`\n  ${pass} passed, ${fail} failed\n`);
    await pool.end();
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
