/**
 * Prep notes are the GM's (#213, spec #69): a session's `agenda` is read and
 * written only by the campaign's Game Master, the session's stand-in
 * (`gm_override_id`) and admins.
 *
 * Installs the integrations fake (testing/fakeIntegrations.ts), mounts the
 * real tabletop, campaign, API-key and planning routers (the planner using the
 * real ExternalEvents), and drives them over HTTP with real JWTs against a
 * throwaway database loaded from db/schema.sql. Checks what's visible from
 * outside: who gets `agenda` back from the session read, the session lists
 * and the planning reads; who may write it; and that no Discord or Google
 * Calendar event (or the shareable link) carries it, with an event published
 * before this change losing it when it is next updated.
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-prep-notes.ts
 */
import "./use-test-jwt-secret.js";
import express from "express";
import type { AddressInfo } from "net";
import crypto from "crypto";
import { signJwt } from "../utils/jwt.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
    console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
    process.exit(2);
}
// The API Key Vault encrypts with this; a fresh throwaway key for this run.
process.env.VAULT_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

const { default: pool } = await import("../db/index.js");
const { default: tabletopRoutes } = await import("../routes/tabletopRoutes.js");
const { default: campaignRoutes } = await import("../routes/campaignRoutes.js");
const { default: apiKeyRoutes } = await import("../routes/apiKeyRoutes.js");
const { buildPlanningRouter } = await import("../routes/planningRoutes.js");
const { createPlanner } = await import("../planning/planner.js");
const { realExternalEvents } = await import("../planning/externalEvents.js");
const { buildGoogleCalendarLink, realIntegrations } = await import("../utils/integrations.js");
const { createFakeIntegrations } = await import("../testing/fakeIntegrations.js");

const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
    const d = typeof detail === "string" ? detail : JSON.stringify(detail);
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !d ? "" : `\n          ${d}`}`);
    ok ? pass++ : fail++;
}

async function main() {
    const fake = createFakeIntegrations();
    const uninstall = fake.install();

    const app = express();
    app.use(express.json());
    app.use("/api/tabletop", tabletopRoutes);
    app.use("/api/campaigns", campaignRoutes);
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
    const P = (sid: string, action = "") => `/api/planning/sessions/${sid}${action ? `/${action}` : ""}`;

    const t0 = Math.ceil((Date.now() + 7 * DAY) / HOUR) * HOUR;
    const slot = (dayOffset: number, hours = 4) => ({
        start: new Date(t0 + dayOffset * DAY).toISOString(), end: new Date(t0 + dayOffset * DAY + hours * HOUR).toISOString(),
    });

    const NOTES = "The lich is the innkeeper";
    /** Who may read and write Prep notes, and who may not. */
    const readers = ["gm", "standin", "admin"], others = ["p1"];
    const hasNotes = (s: any) => s !== null && typeof s === "object" && "agenda" in s;

    try {
        for (const name of ["gm", "standin", "p1", "admin", "outsider"]) {
            const email = `t213-${name}-${tag}@example.test`;
            const { rows: [acct] } = await pool.query(
                `INSERT INTO accounts (id, handle, email, app_role, app_role_source) VALUES (gen_random_uuid(), $1, $2, $3, 'manual') RETURNING id`,
                [`t213_${name}_${tag}`, email, name === "admin" ? "admin" : "user"]);
            who[name] = { id: acct.id, token: signJwt({ id: acct.id, email }, { expiresIn: "1h" }) };
        }
        const { rows: [camp] } = await pool.query(
            `INSERT INTO campaigns (title, owner_id, discord_guild_id, quorum, table_link)
             VALUES ('Ashen Crown', $1, '555000213', 3, 'https://foundry.example/game') RETURNING id`, [who.gm.id]);
        campaignId = camp.id;
        for (const [i, [name, status]] of ([["gm", "Game Master"], ["standin", "Player"], ["p1", "Player"]] as const).entries()) {
            await pool.query(`INSERT INTO campaign_members (campaign_id, person_id, status, joined_at) VALUES ($1, $2, $3, $4)`,
                [campaignId, who[name].id, status, new Date(Date.UTC(2026, 0, 1 + i))]);
        }
        const bot = `bot-token-${tag}`, refresh = `refresh-token-${tag}`;
        for (const [provider, secret] of [["discord", bot], ["google_calendar", refresh]]) {
            await call("PUT", `/api/api-keys/${provider}`, "gm", { keyId: `${provider}-id`, secret });
        }

        console.log("\n#213 — Prep notes are the GM's\n");

        // A session from before this change: its Google link was built with the agenda as the details.
        const oldLink = buildGoogleCalendarLink({
            title: "Ashen Crown: Old night", description: NOTES, location: "Online",
            start: new Date(slot(0).start), end: new Date(slot(0).end),
        });
        const { rows: [old] } = await pool.query(
            `INSERT INTO game_sessions (title, campaign_id, date, end_date, is_online, agenda, google_calendar_link, gm_override_id)
             VALUES ('Old night', $1, $2, $3, true, $4, $5, $6) RETURNING id`,
            [campaignId, slot(0).start, slot(0).end, NOTES, oldLink, who.standin.id]);
        const sid = old.id as string;

        // ── reading ─────────────────────────────────────────────────────────
        console.log("  reading");
        for (const as of readers) {
            const r = await call("GET", `/api/tabletop/sessions/${sid}`, as);
            check(`the session read gives ${as} the Prep notes`, r.status === 200 && r.json.agenda === NOTES, r.json);
        }
        for (const as of others) {
            const r = await call("GET", `/api/tabletop/sessions/${sid}`, as);
            check(`the session read leaves them out for ${as} (no agenda key at all)`, r.status === 200 && !hasNotes(r.json), r.json);
            check("...and the Google link it gets doesn't carry them either",
                typeof r.json.googleCalendarLink === "string" && !r.json.googleCalendarLink.includes("details=") &&
                    !decodeURIComponent(r.json.googleCalendarLink.replace(/\+/g, " ")).includes(NOTES), r.json.googleCalendarLink);
        }
        check("the outsider still can't read the session at all (403)", (await call("GET", `/api/tabletop/sessions/${sid}`, "outsider")).status === 403);

        const { rows: [noNotes] } = await pool.query(
            `INSERT INTO game_sessions (title, campaign_id, date, is_online) VALUES ('No notes yet', $1, $2, true) RETURNING id`,
            [campaignId, slot(1).start]);
        const gmBlank = (await call("GET", `/api/tabletop/sessions/${noNotes.id}`, "gm")).json;
        const p1Blank = (await call("GET", `/api/tabletop/sessions/${noNotes.id}`, "p1")).json;
        check("a session without notes: the GM gets agenda: null (present), a player gets no key",
            hasNotes(gmBlank) && gmBlank.agenda === null && !hasNotes(p1Blank), { gmBlank, p1Blank });

        const listed = async (as: string, url: string) => {
            const r = await call("GET", url, as);
            return { status: r.status, s: Array.isArray(r.json) ? r.json.find((x: any) => String(x._id ?? x.id) === sid) : null };
        };
        for (const url of ["/api/tabletop/sessions", `/api/campaigns/${campaignId}/sessions`]) {
            for (const as of readers) {
                const { status, s } = await listed(as, url);
                check(`${url}: ${as} gets the Prep notes`, status === 200 && s?.agenda === NOTES, s);
            }
            for (const as of others) {
                const { status, s } = await listed(as, url);
                check(`${url}: ${as} doesn't`, status === 200 && s !== undefined && s !== null && !hasNotes(s) &&
                    !String(s.googleCalendarLink ?? "").includes("details="), s);
            }
        }

        // The planning read and the Notice Board (which the live channel tells clients to reload).
        const kicked = await call("POST", `/api/planning/campaigns/${campaignId}/kickoff`, "gm", { title: "Planned night", isOnline: true, agenda: NOTES });
        const pid = kicked.json?.session?.id as string;
        check("the GM starts planning with Prep notes, and sees them in the state kickoff returns",
            kicked.status === 200 && kicked.json.session.agenda === NOTES, kicked.json);
        await pool.query(`UPDATE game_sessions SET gm_override_id = $2 WHERE id = $1`, [pid, who.standin.id]);
        for (const as of readers) {
            const st = await call("GET", P(pid), as);
            check(`the planning read gives ${as} the Prep notes`, st.status === 200 && st.json.session.agenda === NOTES, st.json?.session);
            const board = await call("GET", `/api/planning/campaigns/${campaignId}`, as);
            const onBoard = board.json?.planning?.find((x: any) => x.session.id === pid);
            check(`...and so does the Notice Board`, board.status === 200 && onBoard?.session.agenda === NOTES, onBoard?.session);
        }
        for (const as of others) {
            const st = await call("GET", P(pid), as);
            check(`the planning read leaves them out for ${as}`, st.status === 200 && !hasNotes(st.json.session), st.json?.session);
            const board = await call("GET", `/api/planning/campaigns/${campaignId}`, as);
            const onBoard = board.json?.planning?.find((x: any) => x.session.id === pid);
            check(`...and so does the Notice Board`, board.status === 200 && onBoard && !hasNotes(onBoard.session), onBoard?.session);
        }

        // The encounter list is open to anyone, so its sessions never carry the notes.
        const { rows: [enc] } = await pool.query(
            `INSERT INTO encounters (name, session_id) VALUES ('t213 ambush', $1) RETURNING id`, [sid]);
        const encs = await fetch(`${base}/api/tabletop/encounters`).then((r) => r.json());
        const mine = Array.isArray(encs) ? encs.find((e: any) => String(e._id) === enc.id) : null;
        check("the (unauthenticated) encounter list leaves the Prep notes out of its sessions",
            mine?.session?.title === "Old night" && !hasNotes(mine.session) && !String(mine.session.googleCalendarLink).includes("details="), mine);
        await pool.query(`DELETE FROM encounters WHERE id = $1`, [enc.id]);

        // ── writing ─────────────────────────────────────────────────────────
        console.log("  writing");
        const put = (as: string, agenda: string) => call("PUT", `/api/tabletop/sessions/${sid}`, as, { agenda });
        const asPlayer = await put("p1", "Spoiled!");
        check("a player writing the Prep notes is refused (403), and they're unchanged",
            asPlayer.status === 403 && (await row(sid)).agenda === NOTES, asPlayer.json);
        check("so is someone outside the party (403)", (await put("outsider", "Spoiled!")).status === 403 && (await row(sid)).agenda === NOTES);
        check("a player can't start planning with Prep notes (403)",
            (await call("POST", `/api/planning/campaigns/${campaignId}/kickoff`, "p1", { title: "Mine", isOnline: true, agenda: "x" })).status === 403);
        check("a player can't create a session with Prep notes (403)",
            (await call("POST", "/api/tabletop/sessions", "p1", { title: "Mine", campaign: campaignId, agenda: "x" })).status === 403);
        for (const as of readers) {
            const r = await put(as, `${NOTES} (${as})`);
            check(`${as} can write them`, r.status === 200 && r.json.agenda === `${NOTES} (${as})` && (await row(sid)).agenda === `${NOTES} (${as})`, r.json);
        }
        const afterEdit = (await call("GET", `/api/tabletop/sessions/${sid}`, "p1")).json;
        check("with the notes since edited, the old link a player gets still leaves out the old ones",
            !hasNotes(afterEdit) && !String(afterEdit.googleCalendarLink).includes("details="), afterEdit.googleCalendarLink);
        await put("gm", NOTES);

        // ── event descriptions ──────────────────────────────────────────────
        console.log("  event descriptions");
        fake.clear();
        const created = await call("POST", "/api/tabletop/sessions", "gm", {
            title: "One-shot", campaign: campaignId, date: slot(2).start, endDate: slot(2).end, isOnline: true, agenda: NOTES,
            createDiscordEvent: true, createGoogleEvent: true,
        });
        const [dNew] = fake.calls("discord.createScheduledEvent"), [gNew] = fake.calls("google.createCalendarEvent");
        check("adding a session with events: both are made", created.status === 201 && dNew !== undefined && gNew !== undefined, { res: created.json, calls: fake.calls() });
        check("...the Discord event has no description", dNew?.args[0].description === undefined, dNew?.args[0]);
        check("...nor does the Google event", gNew?.args[1].description === undefined, gNew?.args[1]);
        check("...nor the shareable Google link",
            created.json.googleCalendarLink === buildGoogleCalendarLink({
                title: "Ashen Crown: One-shot", location: "Online", start: new Date(slot(2).start), end: new Date(slot(2).end),
            }), created.json.googleCalendarLink);
        check("...while the GM still gets the Prep notes back", created.json.agenda === NOTES, created.json);

        // The older "prepare session" form also makes an app event, which anyone can list.
        const prepared = await call("POST", "/api/tabletop/prepare-session", "gm", {
            title: "t213 Prepared", campaignId, date: slot(2).start, isOnline: true, agenda: NOTES, ownerId: who.gm.id, ownerName: "GM",
        });
        const preparedEvent = prepared.json?.event?._id
            ? (await pool.query(`SELECT description FROM events WHERE id = $1`, [prepared.json.event._id])).rows[0] : null;
        check("preparing a session makes its app event without the Prep notes",
            prepared.status === 201 && preparedEvent !== null && preparedEvent.description === null, { res: prepared.json, preparedEvent });
        check("...while the GM's own prep task keeps them", String(prepared.json?.task?.description ?? "").includes(NOTES), prepared.json?.task);
        if (prepared.json?.event?._id) await pool.query(`DELETE FROM events WHERE id = $1`, [prepared.json.event._id]);
        if (prepared.json?.task?._id) await pool.query(`DELETE FROM tasks WHERE id = $1`, [prepared.json.task._id]);

        // The planner publishes when the night is confirmed.
        fake.clear();
        const A = slot(3), B = slot(4);
        const sl = await call("POST", P(pid, "shortlist"), "gm", { options: [A, B] });
        const optA = sl.json?.night?.options?.find((o: any) => o.start === A.start)?.id;
        for (const as of ["gm", "standin", "p1"]) await call("POST", P(pid, "vote"), as, { optionIds: [optA] });
        const confirmed = await row(pid);
        // The effects run after the response; wait for the stored event ids.
        for (let i = 0; i < 50 && !(await row(pid)).google_event_id; i++) await new Promise((r) => setTimeout(r, 50));
        const pRow = await row(pid);
        const [dPub] = fake.calls("discord.createScheduledEvent"), [gPub] = fake.calls("google.createCalendarEvent");
        check("confirming the night publishes both events", confirmed.status === "scheduled" && dPub !== undefined && gPub !== undefined,
            { status: confirmed.status, calls: fake.calls().map((c) => c.name) });
        check("...with no description on either", dPub?.args[0].description === undefined && gPub?.args[1].description === undefined,
            { discord: dPub?.args[0], google: gPub?.args[1] });
        check("...and a shareable link without it", typeof pRow.google_calendar_link === "string" && !pRow.google_calendar_link.includes("details="),
            pRow.google_calendar_link);

        // An event published before this change carries the agenda; moving it clears that.
        fake.clear();
        const moved = await realExternalEvents.rescheduleSession({
            gmIds: [who.gm.id], name: "Ashen Crown: Old night", location: "Online",
            start: new Date(slot(5).start), end: new Date(slot(5).end),
            discord: { guildId: "555000213" },
            existing: { discordEventId: "old-discord-event", googleEventId: "old-google-event" },
            createMissing: false,
        });
        const [dUpd] = fake.calls("discord.updateScheduledEvent"), [gUpd] = fake.calls("google.updateCalendarEvent");
        check("moving an already-published session updates both events", moved.warnings.length === 0 && dUpd !== undefined && gUpd !== undefined,
            { moved, calls: fake.calls() });
        check("...and clears the description each one had", dUpd?.args[0].description === "" && gUpd?.args[2].description === "",
            { discord: dUpd?.args[0], google: gUpd?.args[2] });

        // What the real clients send for that clear.
        const sent: { url: string; body: any }[] = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = (async (url: any, init: any) => {
            sent.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
            return new Response(JSON.stringify({ id: "old-discord-event" }), { status: 200, headers: { "content-type": "application/json" } });
        }) as typeof fetch;
        try {
            await realIntegrations.discord.updateScheduledEvent({
                botToken: bot, guildId: "555000213", eventId: "old-discord-event", description: "",
            });
        } finally {
            globalThis.fetch = realFetch;
        }
        check("...which Discord is sent as description: null (it takes no empty string)",
            sent.length === 1 && "description" in sent[0].body && sent[0].body.description === null, sent);
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
