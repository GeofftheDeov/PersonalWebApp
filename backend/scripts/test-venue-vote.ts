/**
 * Planning an in-person session (#92, part of #57): kickoff with online or in
 * person and a food mode, then night -> venue -> food -> scheduled.
 *
 * Covers the venue vote (pre-filled from the campaign's recent venues, the GM
 * adding any venue, players suggesting one, single choice, close when everyone
 * has voted, GM force-advance and tie-break, re-shortlisting), what confirming
 * a venue does (the session's venue, location and host, the venue's last-used
 * time, the host's prep quest, a Google event at the venue and no Discord
 * event), the GM confirming the food stage, address privacy, non-GM
 * rejections, and what a later change of night does to the venue.
 *
 * Installs the integrations fake (testing/fakeIntegrations.ts) and mounts the
 * real planning, quest, API-key routers, with the planner using the real
 * ExternalEvents. Drives them over HTTP with real JWTs against a throwaway
 * database loaded from db/schema.sql; the party's bells and Table Talk posts
 * come from planning/announcements.ts reacting to the bus, as in server.ts.
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-venue-vote.ts
 */
import express from "express";
import type { AddressInfo } from "net";
import crypto from "crypto";
import jwt from "jsonwebtoken";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
    console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
    process.exit(2);
}
process.env.VAULT_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

const { default: pool } = await import("../db/index.js");
const { bus } = await import("../events/index.js");
const { default: apiKeyRoutes } = await import("../routes/apiKeyRoutes.js");
const { buildPlanningRouter } = await import("../routes/planningRoutes.js");
const { buildQuestRouter } = await import("../routes/questRoutes.js");
const { createPlanner } = await import("../planning/planner.js");
const { createQuests } = await import("../planning/quests.js");
const { startPlanningAnnouncements } = await import("../planning/announcements.js");
const { createFakeIntegrations } = await import("../testing/fakeIntegrations.js");

const SECRET = process.env.JWT_SECRET || "your-secret-key-change-this";
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
    app.use("/api/api-keys", apiKeyRoutes);
    app.use("/api/planning", buildPlanningRouter(createPlanner()));   // the real ExternalEvents
    app.use("/api/quests", buildQuestRouter(createQuests()));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const events: { name: string; payload: any }[] = [];
    for (const name of ["planning.stage_changed", "planning.poll_opened", "planning.vote_cast", "planning.poll_closed",
        "planning.night_moved", "planning.venue_suggested", "quest.assigned"] as const) {
        bus.subscribe(name, (payload: any) => { events.push({ name, payload }); });
    }
    const busFor = (sid: string, from = 0) => events.slice(from).filter((e) => e.payload.sessionId === sid).map((e) => {
        const p = e.payload, n = e.name.replace("planning.", "");
        if (n === "poll_closed") return `${n}:${p.kind}:${p.result}/${p.reason}`;
        if (n === "stage_changed") return `${n}:${p.status}/${p.stage}`;
        if (n === "poll_opened") return `${n}:${p.kind}:${p.round}`;
        return n;
    });
    const busEvent = (sid: string, name: string, from = 0) =>
        events.slice(from).find((e) => e.name === name && e.payload.sessionId === sid)?.payload;
    const announcer = startPlanningAnnouncements();

    const tag = crypto.randomBytes(4).toString("hex");
    const who: Record<string, { id: string; token: string }> = {};
    let campaignId = "", otherCampaignId = "";

    const call = async (method: string, path: string, as?: string, body?: unknown) => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (as) headers.authorization = `Bearer ${who[as].token}`;
        const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        return { status: res.status, json, text };
    };
    const P = (sid: string, action = "") => `/api/planning/sessions/${sid}${action ? `/${action}` : ""}`;
    const row = async (id: string) => (await pool.query(`SELECT * FROM game_sessions WHERE id = $1`, [id])).rows[0];
    const talk = async () => (await announcer.idle(), await pool.query(
        `SELECT body FROM messages WHERE campaign_id = $1 AND sender_id = 'system' ORDER BY created_at`, [campaignId])).rows.map((r) => r.body);
    const bell = async (person: string, like: string) => (await announcer.idle(), await pool.query(
        `SELECT title, body, link FROM notifications WHERE user_id = $1 AND title LIKE $2`, [who[person].id, like])).rows;

    const t0 = Math.ceil((Date.now() + 7 * DAY) / HOUR) * HOUR;
    const slot = (dayOffset: number, hours = 4) => ({
        start: new Date(t0 + dayOffset * DAY).toISOString(), end: new Date(t0 + dayOffset * DAY + hours * HOUR).toISOString(),
    });
    const nightOpt = (state: any, s: { start: string }) => state.night.options.find((o: any) => o.start === s.start)?.id;
    /** The venue option on the current venue vote whose venue has this name. */
    const venueOpt = (state: any, name: string) => state.venue?.options.find((o: any) => o.venue?.name === name)?.id;
    const party = ["gm", "p1", "p2", "p3"];

    const kick = (as: string, body: Record<string, unknown>) =>
        call("POST", `/api/planning/campaigns/${campaignId}/kickoff`, as, { title: "Untitled", ...body });
    /** Kicks off an in-person session and confirms its night (everyone can make `night`). Returns the state on the venue step. */
    const toVenueStep = async (title: string, night: { start: string; end: string }, extra: Record<string, unknown> = {}) => {
        const k = await kick("gm", { title, isOnline: false, ...extra });
        const sid = k.json.session.id as string;
        const sl = (await call("POST", P(sid, "shortlist"), "gm", { options: [night, slot(20)] })).json;
        let last: any = null;
        for (const p of party) last = await call("POST", P(sid, "vote"), p, { optionIds: [nightOpt(sl, night)] });
        return { sid, state: last.json };
    };

    try {
        for (const name of ["gm", "p1", "p2", "p3", "outsider", "admin"]) {
            const email = `venue-${name}-${tag}@example.test`;
            const { rows: [acct] } = await pool.query(
                `INSERT INTO accounts (id, handle, email, app_role, app_role_source) VALUES (gen_random_uuid(), $1, $2, $3, 'manual') RETURNING id`,
                [`${name}_${tag}`, email, name === "admin" ? "admin" : "user"]);
            who[name] = { id: acct.id, token: jwt.sign({ id: acct.id, email }, SECRET, { expiresIn: "1h" }) };
        }
        // Linked to a Discord server, so "no Discord event in person" means something.
        const { rows: [camp] } = await pool.query(
            `INSERT INTO campaigns (title, owner_id, discord_guild_id, quorum, table_link, gm_title)
             VALUES ('Hollow Vale', $1, '777000777', 3, 'https://foundry.example/vale', 'Keeper') RETURNING id`, [who.gm.id]);
        campaignId = camp.id;
        for (const [i, [name, status]] of ([["gm", "Game Master"], ["p1", "Player"], ["p2", "Player"], ["p3", "Player"]] as const).entries()) {
            await pool.query(`INSERT INTO campaign_members (campaign_id, person_id, status, joined_at) VALUES ($1, $2, $3, $4)`,
                [campaignId, who[name].id, status, new Date(Date.UTC(2026, 0, 1 + i))]);
        }
        const { rows: [other] } = await pool.query(`INSERT INTO campaigns (title) VALUES ('Elsewhere') RETURNING id`);
        otherCampaignId = other.id;
        const bot = `bot-token-${tag}`, refresh = `refresh-token-${tag}`;
        for (const [provider, secret] of [["discord", bot], ["google_calendar", refresh]]) {
            await call("PUT", `/api/api-keys/${provider}`, "gm", { keyId: `${provider}-id`, secret });
        }

        // The campaign's saved venues, as earlier sessions left them.
        const venue = async (campaign: string, name: string, kind: string, address: string | null, daysAgo: number | null, host?: string) =>
            (await pool.query(
                `INSERT INTO venues (campaign_id, name, kind, address, host_id, last_used_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                [campaign, name, kind, address, host ? who[host].id : null, daysAgo === null ? null : new Date(Date.now() - daysAgo * DAY)])).rows[0].id as string;
        const hearthside = await venue(campaignId, "Hearthside Games", "store", "12 Market St", 10);
        const den = await venue(campaignId, "The Keeper's Den", "home", "1 Oak Lane", 30, "gm");
        await venue(campaignId, "Old Tavern", "other", "3 Quay Rd", 200);
        const library = await venue(campaignId, "Town Library", "store", "40 Shelf Ave", 100);
        const hidden = await venue(campaignId, "Hidden Grotto", "other", "77 Hidden Way", null);
        const foreign = await venue(otherCampaignId, "Not Ours", "store", "5 Far St", 1);

        console.log("\n#92 — planning an in-person session: the venue vote\n");

        // ── kickoff ─────────────────────────────────────────────────────────
        console.log("  kickoff");
        check("a food mode that isn't potluck or provided is a 400",
            (await kick("gm", { isOnline: false, foodMode: "buffet" })).status === 400);
        check("food provided needs a food owner (400)",
            (await kick("gm", { isOnline: false, foodMode: "provided" })).status === 400);
        check("...from the party (someone outside it is a 400)",
            (await kick("gm", { isOnline: false, foodMode: "provided", foodOwnerId: who.outsider.id })).status === 400);
        check("an online session has no food step (400)",
            (await kick("gm", { isOnline: true, foodMode: "potluck" })).status === 400);
        check("a player can't start planning in person either (403)",
            (await kick("p1", { isOnline: false, foodMode: "potluck" })).status === 403);
        const sessionsBefore = Number((await pool.query(`SELECT count(*) FROM game_sessions WHERE campaign_id = $1`, [campaignId])).rows[0].count);
        check("...none of those made a session", sessionsBefore === 0, sessionsBefore);

        // ── the main path: night -> venue (a player's home wins) -> food -> scheduled ──
        console.log("\n  night -> venue -> food -> scheduled (potluck)");
        const A = slot(0);
        const k1 = await kick("gm", { title: "Feast of Lanterns", isOnline: false, foodMode: "potluck", agenda: "Bring dice" });
        check("in person is offered: kicked off on the night step, with the food mode kept",
            k1.status === 200 && k1.json.session.isOnline === false && k1.json.session.stage === "night" &&
                k1.json.session.foodMode === "potluck" && k1.json.venue === null, k1.json?.session ?? k1.json);
        const sid1 = k1.json.session.id as string;
        const sl1 = (await call("POST", P(sid1, "shortlist"), "gm", { options: [A, slot(1)] })).json;
        fake.clear();
        let mark = events.length;
        const talkBefore = (await talk()).length;
        let st: any = null;
        for (const p of party) st = (await call("POST", P(sid1, "vote"), p, { optionIds: [nightOpt(sl1, A)] })).json;
        check("the night is confirmed: the session moves to the venue step with its date set",
            st.session.status === "planning" && st.session.stage === "venue" && st.session.date === A.start, st.session);
        check("...no Discord or Google event yet (in person, they wait for the venue)", fake.calls().length === 0, fake.calls());
        check("...published: the night closed, the venue step, and the venue vote opening",
            busFor(sid1, mark).filter((n) => n !== "vote_cast").join() ===
                "poll_closed:night:winner/all_voted,stage_changed:planning/venue,poll_opened:venue:1", busFor(sid1, mark));
        check("...the venue vote opened with the stage change, so it isn't announced twice",
            busEvent(sid1, "planning.poll_opened", mark)?.withStage === true);
        const t1 = (await talk()).slice(talkBefore);
        check("...the party hears once: the night is set, vote on the venue", t1.length === 1 && /night is set.*venue/i.test(t1[0]), t1);

        check("the venue shortlist is pre-filled with the campaign's recent venues, most recent first",
            st.venue?.status === "open" && st.venue.round === 1 &&
                st.venue.options.map((o: any) => o.venue.name).join() === "Hearthside Games,The Keeper's Den,Town Library,Old Tavern",
            st.venue?.options?.map((o: any) => o.venue?.name));
        check("...each option references its venue; pre-filled ones weren't suggested by anyone",
            st.venue.options.every((o: any) => o.venueId === o.venue.id && o.suggestedBy === null) &&
                st.venue.options[0].venueId === hearthside);
        check("...a venue never used, and another campaign's venue, aren't on it",
            !st.venue.options.some((o: any) => o.venueId === hidden || o.venueId === foreign));
        check("...the party sees every saved venue to choose from (not other campaigns')",
            st.venues.map((v: any) => v.id).includes(hidden) && !st.venues.some((v: any) => v.id === foreign), st.venues);

        // Address privacy.
        const p3View = await call("GET", P(sid1), "p3");
        const denOpt = p3View.json.venue.options.find((o: any) => o.venueId === den);
        check("a party member sees a shortlisted home venue's address, and its host",
            denOpt.venue.address === "1 Oak Lane" && denOpt.venue.kind === "home" && denOpt.venue.hostId === who.gm.id, denOpt);
        check("...but not the address of a saved venue that isn't shortlisted",
            p3View.json.venues.find((v: any) => v.id === hidden)?.address === null && !p3View.text.includes("77 Hidden Way"),
            p3View.json.venues.find((v: any) => v.id === hidden));
        const outView = await call("GET", P(sid1), "outsider");
        check("someone outside the party gets no planning state, so no address (403)",
            outView.status === 403 && !outView.text.includes("1 Oak Lane"));
        const outBoard = await call("GET", `/api/planning/campaigns/${campaignId}`, "outsider");
        check("...nor the Notice Board (403)", outBoard.status === 403 && !outBoard.text.includes("1 Oak Lane"));

        // Suggestions.
        mark = events.length;
        const sug = await call("POST", P(sid1, "suggest-venue"), "p2", { name: "Sam's Flat", address: "9 Elm Road", kind: "home" });
        const samOpt = sug.json?.venue?.options.find((o: any) => o.venue.name === "Sam's Flat");
        check("a player suggests their home: it joins the vote, suggested by them, with them as host",
            sug.status === 200 && samOpt?.suggestedBy === who.p2.id && samOpt.venue.hostId === who.p2.id &&
                samOpt.venue.kind === "home" && samOpt.venue.address === "9 Elm Road", sug.json?.venue ?? sug.json);
        check("...it's saved to the campaign's venue list",
            (await pool.query(`SELECT created_by, host_id, last_used_at FROM venues WHERE id = $1 AND campaign_id = $2`,
                [samOpt?.venueId, campaignId])).rows[0]?.created_by === who.p2.id);
        check("...and published", busFor(sid1, mark).join() === "venue_suggested" &&
            busEvent(sid1, "planning.venue_suggested", mark)?.suggestedBy === who.p2.id);
        check("a player can't offer someone else's home (400)",
            (await call("POST", P(sid1, "suggest-venue"), "p1", { name: "P3's", kind: "home", hostId: who.p3.id })).status === 400);
        check("a venue needs a name (400)", (await call("POST", P(sid1, "suggest-venue"), "p1", { name: "  " })).status === 400);
        check("someone outside the party can't suggest (403)",
            (await call("POST", P(sid1, "suggest-venue"), "outsider", { name: "My shed" })).status === 403);
        check("a venue already on the vote can't be added again (409)",
            (await call("POST", P(sid1, "suggest-venue"), "p1", { venueId: hearthside })).status === 409);
        check("another campaign's venue can't be added (400)",
            (await call("POST", P(sid1, "suggest-venue"), "gm", { venueId: foreign })).status === 400);
        const gmAdd = await call("POST", P(sid1, "suggest-venue"), "gm", { venueId: hidden });
        check("the GM adds any venue, from the saved list: now shortlisted, its address shows",
            gmAdd.status === 200 && gmAdd.json.venue.options.find((o: any) => o.venueId === hidden)?.suggestedBy === who.gm.id &&
                gmAdd.json.venue.options.find((o: any) => o.venueId === hidden)?.venue.address === "77 Hidden Way", gmAdd.json?.venue);
        const gmNew = await call("POST", P(sid1, "suggest-venue"), "gm", { name: "The Old Mill", address: "2 River Walk", kind: "other" });
        check("...or a brand-new one", gmNew.status === 200 && Boolean(venueOpt(gmNew.json, "The Old Mill")));

        // Voting.
        const v1 = gmNew.json;
        check("venue voting is single choice: two picks is a 400",
            (await call("POST", P(sid1, "vote"), "p1", { optionIds: [venueOpt(v1, "Sam's Flat"), venueOpt(v1, "Hearthside Games")] })).status === 400);
        check("...and so is none", (await call("POST", P(sid1, "vote"), "p1", { optionIds: [] })).status === 400);
        check("someone outside the party can't vote (403)",
            (await call("POST", P(sid1, "vote"), "outsider", { optionIds: [venueOpt(v1, "Sam's Flat")] })).status === 403);
        check("a player can't confirm the food stage (403)", (await call("POST", P(sid1, "confirm-food"), "p1")).status === 403);
        check("nor can the GM while the venue is being decided (409)", (await call("POST", P(sid1, "confirm-food"), "gm")).status === 409);
        check("the night can't be changed during the venue step (409)",
            (await call("POST", P(sid1, "reopen"), "gm", { options: [slot(2), slot(3)] })).status === 409);

        await call("POST", P(sid1, "vote"), "p1", { optionIds: [venueOpt(v1, "Hearthside Games")] });
        await call("POST", P(sid1, "vote"), "p1", { optionIds: [venueOpt(v1, "Sam's Flat")] });   // changed their mind
        await call("POST", P(sid1, "vote"), "p2", { optionIds: [venueOpt(v1, "Sam's Flat")] });
        await call("POST", P(sid1, "vote"), "p3", { optionIds: [venueOpt(v1, "Hearthside Games")] });
        check("the vote stays open until everyone has voted", (await call("GET", P(sid1), "gm")).json.venue.status === "open");
        fake.clear();
        mark = events.length;
        const talkBeforeVenue = (await talk()).length;
        const tb = await call("POST", P(sid1, "vote"), "gm", { optionIds: [venueOpt(v1, "Sam's Flat")] });
        const c1 = await row(sid1);
        const samId = samOpt?.venueId;
        check("the last vote closes it: the player-suggested home wins, 3 votes to 1",
            tb.status === 200 && tb.json.venue.status === "closed" && tb.json.venue.closedReason === "all_voted" &&
                tb.json.venue.result === "winner" && tb.json.venue.winningOptionId === venueOpt(v1, "Sam's Flat"), tb.json.venue);
        check("...and the session moves to the food step (potluck)", c1.status === "planning" && c1.planning_stage === "food", c1);
        check("...the session's venue, location and host are set",
            c1.venue_id === samId && c1.location === "Sam's Flat" && c1.host_id === who.p2.id, c1);
        const samRow = (await pool.query(`SELECT last_used_at FROM venues WHERE id = $1`, [samId])).rows[0];
        check("...the venue's last-used time is now", samRow.last_used_at && Date.now() - +samRow.last_used_at < 60_000, samRow);
        const quests = (await pool.query(`SELECT * FROM session_tasks WHERE session_id = $1`, [sid1])).rows;
        check("...the host gets a host_prep quest, due at the session's start, made by the app",
            quests.length === 1 && quests[0].kind === "host_prep" && quests[0].assignee_id === who.p2.id &&
                +quests[0].due_at === +new Date(A.start) && quests[0].created_by === null && quests[0].status === "open", quests);
        check("...it's in the host's Quest Log",
            (await call("GET", "/api/quests/mine", "p2")).json.quests.some((q: any) => q.id === quests[0]?.id && q.kind === "host_prep"));
        check("...announced as assigned by the app, and the host is belled",
            busEvent(sid1, "quest.assigned", mark)?.assigneeId === who.p2.id && busEvent(sid1, "quest.assigned", mark)?.assignedBy === null &&
                (await bell("p2", "New quest:%")).length === 1);
        const gCalls = fake.calls("google.createCalendarEvent");
        check("...a Google Calendar event is created with the venue as its location, with the Keeper's keys",
            gCalls.length === 1 && gCalls[0].args[0] === refresh && gCalls[0].args[1].location === "Sam's Flat, 9 Elm Road" &&
                gCalls[0].args[1].start.toISOString() === A.start && gCalls[0].args[1].title === "Hollow Vale: Feast of Lanterns" &&
                c1.google_event_id === gCalls[0].result?.id, { calls: fake.calls(), c1 });
        check("...and no Discord event, though the campaign is linked to a server",
            fake.calls().every((c) => !c.name.startsWith("discord.")), fake.calls().map((c) => c.name));
        check("...published: the vote closing, the food step and the quest",
            busFor(sid1, mark).join() === "vote_cast,poll_closed:venue:winner/all_voted,stage_changed:planning/food,quest.assigned",
            busFor(sid1, mark));
        const t2 = (await talk()).slice(talkBeforeVenue);
        check("...the party hears the venue is set and the food is next", t2.some((b) => /venue is set.*Feast of Lanterns.*Sam's Flat.*food/i.test(b)), t2);

        const after = await call("GET", P(sid1), "p3");
        check("a party member sees the confirmed venue and its address",
            after.json.session.venue?.id === samId && after.json.session.venue.address === "9 Elm Road", after.json.session);
        check("...but a venue that lost is no longer shortlisted, so its address is hidden again",
            after.json.venue.options.find((o: any) => o.venueId === den)?.venue.address === null && !after.text.includes("1 Oak Lane"),
            after.json.venue.options.find((o: any) => o.venueId === den));
        check("voting after the venue is decided is refused (409)",
            (await call("POST", P(sid1, "vote"), "p1", { optionIds: [venueOpt(v1, "Hearthside Games")] })).status === 409);

        check("someone outside the party can't confirm the food (403)", (await call("POST", P(sid1, "confirm-food"), "outsider")).status === 403);
        mark = events.length;
        fake.clear();
        const cf = await call("POST", P(sid1, "confirm-food"), "gm");
        check("the Keeper confirms the food stage: the session is scheduled",
            cf.status === 200 && cf.json.session.status === "scheduled" && cf.json.session.stage === null, cf.json?.session ?? cf.json);
        check("...published, and nothing more is sent to Google or Discord",
            busFor(sid1, mark).join() === "stage_changed:scheduled/null" && fake.calls().length === 0, busFor(sid1, mark));
        check("...the party hears when and where", (await talk()).some((b) => /"Feast of Lanterns" is scheduled:.*Sam's Flat/.test(b)));
        check("confirming the food again is a 409", (await call("POST", P(sid1, "confirm-food"), "gm")).status === 409);
        const board = await call("GET", `/api/planning/campaigns/${campaignId}`, "p1");
        const up = board.json.upcoming.find((u: any) => u.id === sid1);
        check("the Notice Board's coming-up list shows the party where it is, address included",
            up?.isOnline === false && up.venue?.name === "Sam's Flat" && up.venue.address === "9 Elm Road", up);

        // ── tie-break, force-advance and no food mode (straight to scheduled) ──
        console.log("\n  force-advance and a tie, no food step");
        const B = slot(4);
        const { sid: sid2, state: s2 } = await toVenueStep("Night of Masks", B, { foodMode: "potluck" });
        // Kickoff now requires a food mode in person (#93); a session planned without
        // one still has its venue confirmation schedule it straight away.
        await pool.query(`UPDATE game_sessions SET food_mode = NULL WHERE id = $1`, [sid2]);
        check("the most recently used venue now leads the pre-filled shortlist",
            s2.venue.options[0]?.venueId === samId && s2.venue.options.length === 4, s2.venue.options.map((o: any) => o.venue.name));
        check("a player can't move the venue vote forward (403)", (await call("POST", P(sid2, "advance"), "p1")).status === 403);
        await call("POST", P(sid2, "vote"), "p1", { optionIds: [venueOpt(s2, "Hearthside Games")] });
        await call("POST", P(sid2, "vote"), "p2", { optionIds: [venueOpt(s2, "The Keeper's Den")] });
        fake.clear();
        const adv2 = await call("POST", P(sid2, "advance"), "gm");
        check("the Keeper moves forward with two still to vote: one each is a tie (gm_advanced), still on the venue step",
            adv2.json.venue.closedReason === "gm_advanced" && adv2.json.venue.result === "tie" &&
                [...adv2.json.venue.tiedOptionIds].sort().join() === [venueOpt(s2, "Hearthside Games"), venueOpt(s2, "The Keeper's Den")].sort().join() &&
                adv2.json.session.stage === "venue" && fake.calls().length === 0, adv2.json.venue);
        check("...the Keeper's bell says to pick the venue", (await bell("gm", `Tie on "Night of Masks"`)).length === 1);
        check("a player can't break the tie (403)",
            (await call("POST", P(sid2, "tiebreak"), "p2", { optionId: venueOpt(s2, "Hearthside Games") })).status === 403);
        check("nor can someone outside the party (403)",
            (await call("POST", P(sid2, "tiebreak"), "outsider", { optionId: venueOpt(s2, "Hearthside Games") })).status === 403);
        check("...the Keeper can't pick a venue that wasn't tied (400)",
            (await call("POST", P(sid2, "tiebreak"), "gm", { optionId: venueOpt(s2, "Town Library") })).status === 400);
        check("a player can't suggest into a closed vote (409)",
            (await call("POST", P(sid2, "suggest-venue"), "p1", { name: "Late idea" })).status === 409);
        const tb2 = await call("POST", P(sid2, "tiebreak"), "admin", { optionId: venueOpt(s2, "The Keeper's Den") });
        const c2 = await row(sid2);
        check("an admin breaks the tie for the Keeper's own home: with no food mode the session is scheduled",
            tb2.status === 200 && c2.status === "scheduled" && c2.planning_stage === null && c2.venue_id === den && c2.host_id === who.gm.id, c2);
        const q2 = (await pool.query(`SELECT * FROM session_tasks WHERE session_id = $1`, [sid2])).rows;
        check("...the Keeper hosts, so the Keeper gets the prep quest", q2.length === 1 && q2[0].kind === "host_prep" && q2[0].assignee_id === who.gm.id, q2);
        check("...and a Google event at the Den, no Discord",
            fake.calls().map((c) => c.name).join() === "google.createCalendarEvent" &&
                fake.calls("google.createCalendarEvent")[0].args[1].location === "The Keeper's Den, 1 Oak Lane", fake.calls());

        // ── re-shortlisting, a winner on force-advance, a store (no host), food provided ──
        console.log("\n  re-shortlist, force-advance to a winner, food provided");
        const C = slot(6);
        const { sid: sid3, state: s3 } = await toVenueStep("Harvest Moot", C, { foodMode: "provided", foodOwnerId: who.gm.id });
        check("food provided with the Keeper as owner is kept", s3.session.foodMode === "provided" && s3.session.foodOwnerId === who.gm.id, s3.session);
        await call("POST", P(sid3, "vote"), "p1", { optionIds: [venueOpt(s3, "Hearthside Games")] });
        check("a player can't re-shortlist venues (403)",
            (await call("POST", P(sid3, "reshortlist"), "p1", { venueIds: [library] })).status === 403);
        check("a re-shortlist needs at least one venue (400)", (await call("POST", P(sid3, "reshortlist"), "gm", { venueIds: [] })).status === 400);
        check("...from this campaign (400)", (await call("POST", P(sid3, "reshortlist"), "gm", { venueIds: [foreign] })).status === 400);
        check("shortlisting while a venue vote is open needs a re-shortlist (409)",
            (await call("POST", P(sid3, "shortlist"), "gm", { venueIds: [library] })).status === 409);
        mark = events.length;
        const rs = await call("POST", P(sid3, "reshortlist"), "gm", { venueIds: [library, hearthside] });
        check("the Keeper re-shortlists: round 2 with just those venues, round 1 closed and kept",
            rs.status === 200 && rs.json.venue.round === 2 && rs.json.venue.options.length === 2 &&
                rs.json.venue.options.every((o: any) => o.suggestedBy === who.gm.id) &&
                rs.json.venueRounds.length === 2 && rs.json.venueRounds[0].closedReason === "gm_reshortlisted", rs.json?.venueRounds ?? rs.json);
        check("...published", busFor(sid3, mark).join() === "poll_closed:venue:null/gm_reshortlisted,poll_opened:venue:2", busFor(sid3, mark));
        await call("POST", P(sid3, "vote"), "p1", { optionIds: [venueOpt(rs.json, "Town Library")] });
        await call("POST", P(sid3, "vote"), "p3", { optionIds: [venueOpt(rs.json, "Town Library")] });
        await call("POST", P(sid3, "vote"), "p2", { optionIds: [venueOpt(rs.json, "Hearthside Games")] });
        fake.clear();
        const adv3 = await call("POST", P(sid3, "advance"), "gm");
        const c3 = await row(sid3);
        check("the Keeper moves forward: most votes wins (Town Library, 2 to 1), on to the food step",
            adv3.json.venue.closedReason === "gm_advanced" && adv3.json.venue.result === "winner" &&
                c3.venue_id === library && c3.planning_stage === "food" && c3.host_id === null, { venue: adv3.json.venue, c3 });
        check("...a store has no host, so no prep quest",
            (await pool.query(`SELECT count(*)::int AS n FROM session_tasks WHERE session_id = $1 AND kind = 'host_prep'`, [sid3])).rows[0].n === 0);
        check("...its Google event is at the library", fake.calls("google.createCalendarEvent")[0]?.args[1].location === "Town Library, 40 Shelf Ave");
        check("moving forward again is a 409", (await call("POST", P(sid3, "advance"), "gm")).status === 409);
        fake.clear();
        const cx3 = await call("POST", P(sid3, "cancel"), "gm");
        check("cancelling in the food step removes the Google event made for the venue",
            cx3.json.session.status === "cancelled" && fake.calls("google.deleteCalendarEvent")[0]?.args[1] === c3.google_event_id &&
                (await row(sid3)).google_event_id === null, fake.calls());

        // An empty shortlist: no recent venues in a fresh campaign.
        await pool.query(`UPDATE venues SET last_used_at = NULL WHERE campaign_id = $1`, [campaignId]);
        const { sid: sid4, state: s4 } = await toVenueStep("Quiet Night", slot(8), { foodMode: "potluck" });
        check("with no recent venues the vote opens empty, waiting for a suggestion", s4.venue.status === "open" && s4.venue.options.length === 0, s4.venue);
        check("...and can't be moved forward until it has a venue (409)", (await call("POST", P(sid4, "advance"), "gm")).status === 409);
        const cx4 = await call("POST", P(sid4, "cancel"), "gm");
        check("cancelling during the venue vote closes it",
            cx4.json.session.status === "cancelled" && cx4.json.venue.closedReason === "cancelled", cx4.json?.venue);

        // ── a later change of night keeps the venue ─────────────────────────
        console.log("\n  changing the night of a scheduled in-person session");
        const googleId = (await row(sid1)).google_event_id;
        const D = slot(10);
        const ro = await call("POST", P(sid1, "reopen"), "gm", { options: [D, slot(11)] });
        fake.clear();
        for (const p of party) await call("POST", P(sid1, "vote"), p, { optionIds: [nightOpt(ro.json, D)] });
        const m1 = await row(sid1);
        check("the new night is confirmed: straight back to scheduled, the venue and host kept",
            m1.status === "scheduled" && m1.date.toISOString() === D.start && m1.venue_id === samId && m1.host_id === who.p2.id &&
                m1.location === "Sam's Flat", m1);
        check("...its Google event moves; no Discord event is made",
            fake.calls().map((c) => c.name).join() === "google.updateCalendarEvent" && fake.calls()[0].args[1] === googleId, fake.calls());
        check("...the host's prep quest is still open (#91 moves its due time with the night)",
            (await pool.query(`SELECT status FROM session_tasks WHERE session_id = $1 AND kind = 'host_prep'`, [sid1])).rows[0]?.status === "open");
    } finally {
        await announcer.idle();
        announcer.stop();
        uninstall();
        const ids = Object.values(who).map((p) => p.id);
        // Sessions (and their polls) first: a venue still named by a poll option can't go.
        for (const id of [campaignId, otherCampaignId]) if (id) {
            await pool.query(`DELETE FROM game_sessions WHERE campaign_id = $1`, [id]);
            await pool.query(`DELETE FROM campaigns WHERE id = $1`, [id]);
        }
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
