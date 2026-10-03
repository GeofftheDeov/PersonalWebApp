/**
 * The night vote's Game Master controls (#87, part of #57): force-advance,
 * tie-break, failed rounds and re-shortlisting, reopening a confirmed night,
 * and cancelling -- plus who may do each, and the bus event each publishes.
 *
 * Installs the integrations fake (testing/fakeIntegrations.ts) and mounts the
 * real planning, API-key and tabletop routers, with the planner using the real
 * ExternalEvents. Drives them over HTTP with real JWTs against a throwaway
 * database loaded from db/schema.sql, and checks what's visible from outside:
 * responses, rows, bell notifications, Table Talk posts, bus events and the
 * raw Discord / Google calls the fake received. The party's bells and Table
 * Talk posts come from planning/announcements.ts reacting to the bus events
 * (#88), started here as server.ts starts it.
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-night-vote.ts
 */
import express from "express";
import type { AddressInfo } from "net";
import crypto from "crypto";
import jwt from "jsonwebtoken";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
    console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
    process.exit(2);
}
// The API Key Vault encrypts with this; a fresh throwaway key for this run.
process.env.VAULT_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

const { default: pool } = await import("../db/index.js");
const { bus } = await import("../events/index.js");
const { default: tabletopRoutes } = await import("../routes/tabletopRoutes.js");
const { default: apiKeyRoutes } = await import("../routes/apiKeyRoutes.js");
const { buildPlanningRouter } = await import("../routes/planningRoutes.js");
const { createPlanner } = await import("../planning/planner.js");
const { startPlanningAnnouncements } = await import("../planning/announcements.js");
const { buildGoogleCalendarLink } = await import("../utils/integrations.js");
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
    app.use("/api/tabletop", tabletopRoutes);
    app.use("/api/api-keys", apiKeyRoutes);
    app.use("/api/planning", buildPlanningRouter(createPlanner()));   // the real ExternalEvents
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const events: { name: string; payload: any }[] = [];
    for (const name of ["planning.stage_changed", "planning.poll_opened", "planning.vote_cast", "planning.poll_closed",
        "planning.night_moved"] as const) {
        bus.subscribe(name, (payload: any) => { events.push({ name, payload }); });
    }
    /** Bus events for one session since `from`, as "name" or "name:detail". */
    const busFor = (sid: string, from = 0) => events.slice(from).filter((e) => e.payload.sessionId === sid).map((e) => {
        const p = e.payload, n = e.name.replace("planning.", "");
        if (n === "poll_closed") return `${n}:${p.result}/${p.reason}`;
        if (n === "stage_changed") return `${n}:${p.status}/${p.stage}`;
        if (n === "poll_opened") return `${n}:${p.round}`;
        return n;
    });
    /** The bus event `name` for one session since `from`. */
    const busEvent = (sid: string, name: string, from = 0, match: (p: any) => boolean = () => true) =>
        events.slice(from).find((e) => e.name === name && e.payload.sessionId === sid && match(e.payload))?.payload;
    // Bells and Table Talk posts react to those events (#88) after the
    // response, so checks on them wait for the announcer to finish first.
    const announcer = startPlanningAnnouncements();
    /** A time as the party's messages state it (no GM availability here, so UTC). */
    const fmt = (iso: string) => new Date(iso).toLocaleString("en-US", {
        timeZone: "UTC", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
    });

    const tag = crypto.randomBytes(4).toString("hex");
    const who: Record<string, { id: string; token: string }> = {};
    let campaignId = "";

    const call = async (method: string, path: string, as?: string, body?: unknown) => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (as) headers.authorization = `Bearer ${who[as].token}`;
        const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        return { status: res.status, json };
    };
    const P = (sid: string, action = "") => `/api/planning/sessions/${sid}${action ? `/${action}` : ""}`;
    const row = async (id: string) => (await pool.query(`SELECT * FROM game_sessions WHERE id = $1`, [id])).rows[0];
    const bell = async (person: string, sid: string, like: string) => (await announcer.idle(), await pool.query(
        `SELECT title, body FROM notifications WHERE user_id = $1 AND meta->>'sessionId' = $2 AND title LIKE $3`,
        [who[person].id, sid, like])).rows;
    /**
     * How many party alerts this person has had for a session. They collapse
     * into one unread entry whose title the latest overwrites, so a title
     * alone can't show an alert didn't happen; the entry's count can.
     */
    const alerts = async (person: string, sid: string) => (await announcer.idle(), Number((await pool.query(
        `SELECT coalesce(sum(count), 0) AS n FROM notifications WHERE user_id = $1 AND source_key = $2`,
        [who[person].id, `planning:${sid}`])).rows[0].n));
    const talk = async () => (await announcer.idle(), await pool.query(
        `SELECT body FROM messages WHERE campaign_id = $1 AND sender_id = 'system' ORDER BY created_at`, [campaignId])).rows.map((r) => r.body);

    const t0 = Math.ceil((Date.now() + 7 * DAY) / HOUR) * HOUR;
    const slot = (dayOffset: number, hours = 4) => ({
        start: new Date(t0 + dayOffset * DAY).toISOString(), end: new Date(t0 + dayOffset * DAY + hours * HOUR).toISOString(),
    });
    const optionAt = (state: any, s: { start: string }) => state.night.options.find((o: any) => o.start === s.start)?.id;

    const kick = async (title: string, as = "gm") =>
        (await call("POST", `/api/planning/campaigns/${campaignId}/kickoff`, as, { title, isOnline: true, agenda: `${title} agenda` })).json.session.id as string;
    /** Each voter's ballot, by slot; the state after the last one. */
    const voteAll = async (sid: string, state: any, ballots: [string, { start: string }[]][]) => {
        let last: any = null;
        for (const [as, picks] of ballots) {
            last = await call("POST", P(sid, "vote"), as, { optionIds: picks.map((p) => optionAt(state, p)) });
        }
        return last;
    };
    const everyone = (picks: { start: string }[]): [string, { start: string }[]][] =>
        ["p1", "p2", "p3", "gm"].map((p) => [p, picks]);

    try {
        for (const name of ["gm", "p1", "p2", "p3", "outsider", "admin"]) {
            const email = `night-${name}-${tag}@example.test`;
            const { rows: [acct] } = await pool.query(
                `INSERT INTO accounts (id, handle, email, app_role, app_role_source) VALUES (gen_random_uuid(), $1, $2, $3, 'manual') RETURNING id`,
                [`${name}_${tag}`, email, name === "admin" ? "admin" : "user"]);
            who[name] = { id: acct.id, token: jwt.sign({ id: acct.id, email }, SECRET, { expiresIn: "1h" }) };
        }
        const { rows: [camp] } = await pool.query(
            `INSERT INTO campaigns (title, owner_id, discord_guild_id, quorum, table_link)
             VALUES ('Ashen Crown', $1, '555000555', 3, 'https://foundry.example/game') RETURNING id`, [who.gm.id]);
        campaignId = camp.id;
        for (const [i, [name, status]] of ([["gm", "Game Master"], ["p1", "Player"], ["p2", "Player"], ["p3", "Player"]] as const).entries()) {
            await pool.query(`INSERT INTO campaign_members (campaign_id, person_id, status, joined_at) VALUES ($1, $2, $3, $4)`,
                [campaignId, who[name].id, status, new Date(Date.UTC(2026, 0, 1 + i))]);
        }
        const bot = `bot-token-${tag}`, refresh = `refresh-token-${tag}`;
        for (const [provider, secret] of [["discord", bot], ["google_calendar", refresh]]) {
            await call("PUT", `/api/api-keys/${provider}`, "gm", { keyId: `${provider}-id`, secret });
        }

        console.log("\n#87 — the night vote's Game Master controls\n");

        // ── a failed round, then re-shortlisting ────────────────────────────
        console.log("  failed round and re-shortlist");
        const A = slot(0), B = slot(1), C = slot(2), D = slot(3), E = slot(4), F = slot(5), G = slot(6), H = slot(7), I = slot(8);
        const sidF = await kick("Failed night");
        const r1 = (await call("POST", P(sidF, "shortlist"), "gm", { options: [A, B] })).json;
        let mark = events.length;
        const failed = await voteAll(sidF, r1, [["p1", [A]], ["p2", [B]], ["p3", []], ["gm", [A]]]);
        check("everyone voted but no time reached quorum (2 of 3): the round is marked failed, still on the night step",
            failed.json.night.status === "closed" && failed.json.night.result === "no_quorum" && failed.json.night.closedReason === "all_voted" &&
                failed.json.session.status === "planning" && failed.json.session.stage === "night", failed.json);
        check("...the GM sees it failed: their bell, and the state they load",
            (await bell("gm", sidF, "No night worked%")).length === 1 &&
                (await call("GET", P(sidF), "gm")).json.night.result === "no_quorum");
        check("...Table Talk tells the party", (await talk()).some((b) => /None of the shortlisted times for "Failed night"/.test(b)));
        check("...and the close was published on the bus",
            busFor(sidF, mark).join() === "vote_cast,vote_cast,vote_cast,vote_cast,poll_closed:no_quorum/all_voted", busFor(sidF, mark));
        check("a vote on the failed round is refused (409)",
            (await call("POST", P(sidF, "vote"), "p1", { optionIds: [optionAt(r1, A)] })).status === 409);
        check("a player can't re-shortlist (403)", (await call("POST", P(sidF, "reshortlist"), "p1", { options: [C, D] })).status === 403);
        check("nor can someone outside the party (403)", (await call("POST", P(sidF, "reshortlist"), "outsider", { options: [C, D] })).status === 403);

        mark = events.length;
        const r2 = await call("POST", P(sidF, "reshortlist"), "gm", { options: [C, D] });
        check("the GM re-shortlists from wider dates: round 2 opens", r2.status === 200 && r2.json.night.round === 2 && r2.json.night.status === "open", r2.json);
        check("...published as a new poll", busFor(sidF, mark).join() === "poll_opened:2", busFor(sidF, mark));
        const rounds = r2.json.nightRounds ?? [];
        check("earlier rounds and their votes stay visible: round 1, failed, with who voted for what",
            rounds.length === 2 && rounds[0].round === 1 && rounds[0].result === "no_quorum" &&
                [...rounds[0].options.find((o: any) => o.start === A.start).approvals].sort().join() === [who.p1.id, who.gm.id].sort().join() &&
                rounds[0].voted.length === 4 && rounds[1].round === 2, rounds);
        check("...and the party sees them too", (await call("GET", P(sidF), "p2")).json.nightRounds?.length === 2);

        await call("POST", P(sidF, "vote"), "p1", { optionIds: [optionAt(r2.json, C)] });
        mark = events.length;
        const r3 = await call("POST", P(sidF, "reshortlist"), "gm", { options: [E, F] });
        const abandoned = r3.json.nightRounds?.find((r: any) => r.round === 2);
        check("re-shortlisting an open round closes it with gm_reshortlisted and opens round 3",
            r3.json.night.round === 3 && abandoned?.status === "closed" && abandoned.closedReason === "gm_reshortlisted" &&
                abandoned.result === null && abandoned.options.find((o: any) => o.start === C.start).approvals.includes(who.p1.id), r3.json.nightRounds);
        check("...both published", busFor(sidF, mark).join() === "poll_closed:null/gm_reshortlisted,poll_opened:3", busFor(sidF, mark));

        // ── force-advance ───────────────────────────────────────────────────
        console.log("\n  force-advance");
        const ballots: [string, { start: string }[]][] = [["p1", [A, B]], ["p2", [A]], ["gm", [A, C]]];
        const sidV = await kick("Forced night");
        const fv = (await call("POST", P(sidV, "shortlist"), "gm", { options: [A, B, C] })).json;
        await voteAll(sidV, fv, ballots);
        check("a player can't move the vote forward (403)", (await call("POST", P(sidV, "advance"), "p1")).status === 403);
        check("nor can someone outside the party (403)", (await call("POST", P(sidV, "advance"), "outsider")).status === 403);
        check("...and the vote is still open", (await call("GET", P(sidV), "gm")).json.night.status === "open");

        fake.clear();
        mark = events.length;
        const adv = await call("POST", P(sidV, "advance"), "gm");
        check("the GM moves forward with p3 still to vote: closed as gm_advanced, A wins with 3 approvals",
            adv.status === 200 && adv.json.night.closedReason === "gm_advanced" && adv.json.night.result === "winner" &&
                adv.json.night.winningOptionId === optionAt(fv, A), adv.json.night);

        // The same ballots plus p3 approving nothing, closed by the last vote.
        const sidT = await kick("Twin night");
        const tv = (await call("POST", P(sidT, "shortlist"), "gm", { options: [A, B, C] })).json;
        const twin = await voteAll(sidT, tv, [...ballots, ["p3", []]]);
        const shape = (n: any) => ({ result: n.result, winner: n.options.find((o: any) => o.id === n.winningOptionId)?.start ?? null,
            approvals: n.options.map((o: any) => [o.start, o.approvals.length, o.meetsQuorum]) });
        check("...resolved exactly as if everyone had voted (a twin vote closed by everyone voting)",
            twin.json.night.closedReason === "all_voted" && JSON.stringify(shape(adv.json.night)) === JSON.stringify(shape(twin.json.night)),
            { forced: shape(adv.json.night), twin: shape(twin.json.night) });

        const vRow = await row(sidV);
        const [dCreate] = fake.calls("discord.createScheduledEvent"), [gCreate] = fake.calls("google.createCalendarEvent");
        check("...the online session is scheduled for A, with a Discord and a Google event made with the GM's keys",
            vRow.status === "scheduled" && vRow.date.toISOString() === A.start && dCreate?.args[0].botToken === bot &&
                dCreate.args[0].guildId === "555000555" && gCreate?.args[0] === refresh &&
                vRow.discord_event_id === dCreate.result?.id && vRow.google_event_id === gCreate.result?.id, { vRow, calls: fake.calls() });
        check("...and the advance was published", busFor(sidV, mark).join() === "poll_closed:winner/gm_advanced,stage_changed:scheduled/null", busFor(sidV, mark));
        check("moving forward again is a 409", (await call("POST", P(sidV, "advance"), "gm")).status === 409);

        // ── tie-break ───────────────────────────────────────────────────────
        console.log("\n  tie-break");
        const sidB = await kick("Tied night");
        const bv = (await call("POST", P(sidB, "shortlist"), "gm", { options: [A, B, C] })).json;
        const tied = await voteAll(sidB, bv, [["p1", [A, B, C]], ["p2", [A, B]], ["p3", [A, B]], ["gm", [A, B]]]);
        check("A and B both meet quorum with 4: the vote closes as a tie and waits for the GM",
            tied.json.night.result === "tie" && tied.json.night.tiedOptionIds.sort().join() === [optionAt(bv, A), optionAt(bv, B)].sort().join() &&
                tied.json.session.status === "planning" && tied.json.session.stage === "night" && (await row(sidB)).date === null, tied.json);
        check("...the GM's bell says to pick", (await bell("gm", sidB, "Tie on%")).length === 1);
        check("a player can't break the tie (403)", (await call("POST", P(sidB, "tiebreak"), "p1", { optionId: optionAt(bv, A) })).status === 403);
        check("nor can someone outside the party (403)", (await call("POST", P(sidB, "tiebreak"), "outsider", { optionId: optionAt(bv, A) })).status === 403);
        const notTied = await call("POST", P(sidB, "tiebreak"), "gm", { optionId: optionAt(bv, C) });
        check("the GM can't pick an option that wasn't in the tie (C, 1 approval) — 400", notTied.status === 400 && /tied/.test(notTied.json.error), notTied.json);
        check("...and the session is still waiting", (await row(sidB)).status === "planning");
        mark = events.length;
        const picked = await call("POST", P(sidB, "tiebreak"), "gm", { optionId: optionAt(bv, B) });
        check("the GM picks B: it wins, and the session is scheduled for B",
            picked.json.night.result === "winner" && picked.json.night.winningOptionId === optionAt(bv, B) &&
                picked.json.session.status === "scheduled" && picked.json.session.date === B.start, picked.json);
        check("...published", busFor(sidB, mark).join() === "poll_closed:winner/all_voted,stage_changed:scheduled/null", busFor(sidB, mark));

        // ── reopening a confirmed night ─────────────────────────────────────
        console.log("\n  reopening the night");
        const discordId = vRow.discord_event_id, googleId = vRow.google_event_id;
        await pool.query(`UPDATE game_sessions SET ready_check = '{"sentAt":"2026-01-01T00:00:00Z","responses":[]}' WHERE id = $1`, [sidV]);

        const board = await call("GET", `/api/planning/campaigns/${campaignId}`, "gm");
        const upcoming = board.json.upcoming?.find((u: any) => u.id === sidV);
        check("the Notice Board lists the scheduled session as coming up, which the GM may change",
            upcoming?.date === A.start && upcoming.canChangeNight === true, board.json.upcoming);
        check("...a player sees it but may not change it",
            (await call("GET", `/api/planning/campaigns/${campaignId}`, "p1")).json.upcoming?.find((u: any) => u.id === sidV)?.canChangeNight === false);

        fake.clear();
        mark = events.length;
        check("a player can't change the night (403)", (await call("POST", P(sidV, "reopen"), "p1", { options: [D, E] })).status === 403);
        check("nor can someone outside the party (403)", (await call("POST", P(sidV, "reopen"), "outsider", { options: [D, E] })).status === 403);
        check("one new time isn't a shortlist (400)", (await call("POST", P(sidV, "reopen"), "gm", { options: [D] })).status === 400);
        check("...none of those changed anything or reached Discord or Google",
            (await row(sidV)).status === "scheduled" && fake.calls().length === 0 && busFor(sidV, mark).length === 0);

        const talkBeforeReopen = (await talk()).length;
        const alertsBeforeReopen = { p1: await alerts("p1", sidV), gm: await alerts("gm", sidV) };
        const ro = await call("POST", P(sidV, "reopen"), "gm", { options: [E, D] });
        check("the GM changes the night: back on the night step, with round 2 open",
            ro.status === 200 && ro.json.session.status === "planning" && ro.json.session.stage === "night" &&
                ro.json.night.round === 2 && ro.json.night.status === "open" &&
                ro.json.night.options.map((o: any) => o.start).join() === [D.start, E.start].join(), ro.json);
        check("...the old night stands until a new one is confirmed", ro.json.session.date === A.start && (await row(sidV)).date.toISOString() === A.start);
        check("...round 1 and its votes stay visible",
            ro.json.nightRounds?.length === 2 && ro.json.nightRounds[0].result === "winner" &&
                ro.json.nightRounds[0].options.find((o: any) => o.start === A.start).approvals.length === 3, ro.json.nightRounds);
        check("...nothing is sent to Discord or Google yet", fake.calls().length === 0, fake.calls());
        check("...published: back to planning, and a new poll", busFor(sidV, mark).join() === "stage_changed:planning/night,poll_opened:2", busFor(sidV, mark));
        const roStage = busEvent(sidV, "planning.stage_changed", mark), roPoll = busEvent(sidV, "planning.poll_opened", mark);
        check("...the stage change is marked as a reopen (not a kickoff), by the GM, and so is the round it opens",
            roStage?.nightChange === "reopened" && roStage.actorId === who.gm.id &&
                roPoll?.nightChange === "reopened" && roPoll.actorId === who.gm.id, { roStage, roPoll });
        const roTalk = (await talk()).slice(talkBeforeReopen);
        check("...the party is told the night is changing, and what it was",
            (await bell("p1", sidV, "%night%changing%")).length === 1 && roTalk.length === 1 &&
                /night for "Forced night" is changing/i.test(roTalk[0]) && roTalk[0].includes(`It was ${fmt(A.start)}`) &&
                /2 new times/.test(roTalk[0]), roTalk);
        check("...once: one alert per player, and no kickoff or separate vote call (bus-driven, #88)",
            !roTalk.some((b) => /new session is being planned|Vote on the night/.test(b)) &&
                (await alerts("p1", sidV)) === alertsBeforeReopen.p1 + 1, { roTalk, before: alertsBeforeReopen.p1, after: await alerts("p1", sidV) });
        check("...and the GM who changed it isn't belled about it",
            (await bell("gm", sidV, "%night%changing%")).length === 0 && (await alerts("gm", sidV)) === alertsBeforeReopen.gm);
        check("changing it again while it's being re-planned is a 409 (re-shortlist instead)",
            (await call("POST", P(sidV, "reopen"), "gm", { options: [F, G] })).status === 409);

        mark = events.length;
        const talkBeforeMove = (await talk()).length;
        const alertsBeforeMove = await alerts("p2", sidV);
        const moved = await voteAll(sidV, ro.json, everyone([E]));
        const mRow = await row(sidV);
        check("the party confirms E: the session is scheduled again, and its date moves to E",
            moved.json.session.status === "scheduled" && mRow.date.toISOString() === E.start && mRow.end_date.toISOString() === E.end, mRow);
        const [dUpd] = fake.calls("discord.updateScheduledEvent"), [gUpd] = fake.calls("google.updateCalendarEvent");
        check("...the existing Discord event is moved, with the GM's bot token and the linked server",
            dUpd?.args[0].eventId === discordId && dUpd.args[0].botToken === bot && dUpd.args[0].guildId === "555000555" &&
                dUpd.args[0].start?.toISOString() === E.start && dUpd.args[0].end?.toISOString() === E.end, dUpd?.args);
        check("...the existing Google event is moved, with the GM's refresh token",
            gUpd?.args[0] === refresh && gUpd.args[1] === googleId &&
                gUpd.args[2].start?.toISOString() === E.start && gUpd.args[2].end?.toISOString() === E.end, gUpd?.args);
        check("...updated, not duplicated: no event was created or deleted",
            fake.calls().map((c) => c.name).sort().join() === "discord.updateScheduledEvent,google.updateCalendarEvent", fake.calls().map((c) => c.name));
        check("...the event ids stay, and the shareable link shows the new time",
            mRow.discord_event_id === discordId && mRow.google_event_id === googleId &&
                mRow.google_calendar_link === buildGoogleCalendarLink({ title: "Ashen Crown: Forced night", description: "Forced night agenda",
                    location: "https://foundry.example/game", start: new Date(E.start), end: new Date(E.end) }), mRow);
        check("...the ready check for the old night is cleared", mRow.ready_check === null, mRow.ready_check);
        const nm = events.slice(mark).find((e) => e.name === "planning.night_moved" && e.payload.sessionId === sidV)?.payload;
        check("...a night_moved bus event carries the old and new times (for quests to follow, #91)",
            nm?.campaignId === campaignId && nm.previousStart === A.start && nm.previousEnd === A.end && nm.start === E.start && nm.end === E.end, nm);
        check("...alongside the close and the stage change",
            busFor(sidV, mark).filter((n) => n !== "vote_cast").join() === "poll_closed:winner/all_voted,stage_changed:scheduled/null,night_moved", busFor(sidV, mark));
        check("...the stage change is marked as a move",
            busEvent(sidV, "planning.stage_changed", mark)?.nightChange === "moved", busEvent(sidV, "planning.stage_changed", mark));
        const mvTalk = (await talk()).slice(talkBeforeMove);
        const mvBell = await bell("p2", sidV, "%moved%");
        check("...and the party hears it moved: the new night, what it was, and the table",
            mvBell.length === 1 && mvBell[0].title.includes(fmt(E.start)) && mvBell[0].body.includes(`was ${fmt(A.start)}`) &&
                mvTalk.length === 1 && /night has moved.*Forced night/i.test(mvTalk[0]) &&
                mvTalk[0].includes(`now ${fmt(E.start)} (was ${fmt(A.start)})`) && mvTalk[0].includes("https://foundry.example/game"),
            { mvBell, mvTalk });
        check("...announced once, as a move, not as a fresh \"it's on\"",
            !mvTalk.some((b) => /The night is set!/.test(b)) && (await alerts("p2", sidV)) === alertsBeforeMove + 1,
            { mvTalk, before: alertsBeforeMove, after: await alerts("p2", sidV) });
        check("...the GM hears it too (the move isn't something they did alone)", (await bell("gm", sidV, "%moved:%")).length === 1);

        // An event that can't be moved (deleted, or already started) is replaced.
        await call("POST", P(sidV, "reopen"), "gm", { options: [F, G] });
        const ro2 = (await call("GET", P(sidV), "gm")).json;
        fake.clear();
        fake.fail("discord.updateScheduledEvent", new Error("Discord API 404: Unknown Guild Scheduled Event"));
        fake.fail("google.updateCalendarEvent", new Error("Google Calendar API 404: Not Found"));
        await voteAll(sidV, ro2, everyone([F]));
        const rRow = await row(sidV);
        const names = fake.calls().map((c) => c.name);
        const [dNew] = fake.calls("discord.createScheduledEvent"), [gNew] = fake.calls("google.createCalendarEvent");
        check("when the old events can't be moved, new ones are made for F and the old ones removed",
            names.join() === ["discord.updateScheduledEvent", "discord.createScheduledEvent", "discord.deleteScheduledEvent",
                "google.updateCalendarEvent", "google.createCalendarEvent", "google.deleteCalendarEvent"].join() &&
                dNew?.args[0].start.toISOString() === F.start && dNew.args[0].name === "Ashen Crown: Forced night" &&
                fake.calls("discord.deleteScheduledEvent")[0]?.args[0].eventId === discordId &&
                gNew?.args[1].start.toISOString() === F.start && fake.calls("google.deleteCalendarEvent")[0]?.args[1] === googleId, names);
        check("...the session now points at the replacements",
            rRow.date.toISOString() === F.start && rRow.discord_event_id === dNew?.result?.id && rRow.google_event_id === gNew?.result?.id, rRow);
        check("...a clean replacement doesn't trouble the GM", (await bell("gm", sidV, "%with a problem")).length === 0);

        // Neither moving nor replacing works: keep the old id, tell the GM.
        await call("POST", P(sidV, "reopen"), "gm", { options: [G, H] });
        const ro3 = (await call("GET", P(sidV), "gm")).json;
        fake.clear();
        fake.fail("discord.updateScheduledEvent", new Error("Discord API 403: Missing Permissions"));
        fake.fail("discord.createScheduledEvent", new Error("Discord API 403: Missing Permissions"));
        await voteAll(sidV, ro3, everyone([G]));
        const kRow = await row(sidV);
        const warn = await bell("gm", sidV, "%with a problem");
        check("if the Discord event can be neither moved nor replaced, the night still moves and the GM is told",
            kRow.status === "scheduled" && kRow.date.toISOString() === G.start && kRow.discord_event_id === rRow.discord_event_id &&
                warn.length === 1 && /Discord event couldn't be moved/.test(warn[0].body) && /Missing Permissions/.test(warn[0].body), { kRow, warn });
        check("...Google, which worked, was moved", fake.calls("google.updateCalendarEvent")[0]?.args[1] === rRow.google_event_id &&
            !fake.calls("google.updateCalendarEvent")[0]?.error);

        // An online session with no event yet (say its creation failed) gets one.
        await pool.query(`UPDATE game_sessions SET discord_event_id = NULL WHERE id = $1`, [sidB]);
        const roB = await call("POST", P(sidB, "reopen"), "admin", { options: [H, I] });
        check("an admin can change the night", roB.status === 200 && roB.json.session.stage === "night", roB.json);
        fake.clear();
        await voteAll(sidB, roB.json, everyone([I]));
        check("...an online session missing its Discord event gets one made; its Google event is moved",
            fake.calls().map((c) => c.name).sort().join() === "discord.createScheduledEvent,google.updateCalendarEvent" &&
                (await row(sidB)).discord_event_id === fake.calls("discord.createScheduledEvent")[0]?.result?.id, fake.calls().map((c) => c.name));

        // A one-off, in-person session added with a fixed date.
        fake.clear();
        const oneOff = await call("POST", "/api/tabletop/sessions", "gm", {
            title: "Board game night", campaign: campaignId, date: slot(9).start, endDate: slot(9).end,
            location: "Hearthside Games", createGoogleEvent: true,
        });
        const oneOffGoogle = (await row(oneOff.json.id)).google_event_id;
        const roO = await call("POST", P(oneOff.json.id, "reopen"), "gm", { options: [slot(10), slot(11)] });
        check("a one-off session's night can be changed too (round 1)", roO.status === 200 && roO.json.night.round === 1, roO.json);
        check("...announced as a change of night, not a kickoff",
            (await bell("p3", oneOff.json.id, "%night%changing%")).length === 1 &&
                !(await talk()).some((b) => /new session is being planned:\*\* "Board game night"/.test(b)));
        fake.clear();
        const doneO = await voteAll(oneOff.json.id, roO.json, everyone([slot(11)]));
        const oRow = await row(oneOff.json.id);
        check("...confirming it schedules it again (an in-person session isn't sent back to the venue step)",
            doneO.json.session.status === "scheduled" && oRow.planning_stage === null && oRow.date.toISOString() === slot(11).start &&
                oRow.location === "Hearthside Games", oRow);
        check("...its Google event is moved, and no Discord event is invented for an in-person session",
            fake.calls().map((c) => c.name).join() === "google.updateCalendarEvent" && fake.calls()[0].args[1] === oneOffGoogle, fake.calls());
        check("...and the party hears it moved, to where it's always been",
            (await talk()).some((b) => b.includes(`"Board game night" — now ${fmt(slot(11).start)} (was ${fmt(slot(9).start)}), at Hearthside Games.`)),
            (await talk()).slice(-2));

        // The vote keeps the same night, for a session added with a start but no end.
        const { rows: [noEnd] } = await pool.query(
            `INSERT INTO game_sessions (title, campaign_id, date, is_online, ready_check)
             VALUES ('Open-ended', $1, $2, true, '{"sentAt":null,"responses":[]}') RETURNING id`, [campaignId, slot(12).start]);
        const roN = await call("POST", P(noEnd.id, "reopen"), "gm", { options: [slot(12), slot(13)] });
        fake.clear();
        mark = events.length;
        const talkBeforeKept = (await talk()).length;
        const alertsBeforeKept = await alerts("p1", noEnd.id);
        await voteAll(noEnd.id, roN.json, everyone([slot(12)]));
        const nRow = await row(noEnd.id);
        check("re-voting the same start isn't a move: scheduled again, no night_moved, nothing sent out, ready check kept",
            nRow.status === "scheduled" && nRow.date.toISOString() === slot(12).start && nRow.end_date?.toISOString() === slot(12).end &&
                nRow.ready_check !== null && fake.calls().length === 0 &&
                !busFor(noEnd.id, mark).includes("night_moved") && (await bell("p1", noEnd.id, "%stays on%")).length === 1,
            { nRow, calls: fake.calls(), bus: busFor(noEnd.id, mark) });
        check("...the stage change says the night was kept, and the party isn't told it moved or posted a fresh \"it's on\"",
            busEvent(noEnd.id, "planning.stage_changed", mark)?.nightChange === "kept" &&
                (await talk()).length === talkBeforeKept && (await alerts("p1", noEnd.id)) === alertsBeforeKept + 1 &&
                (await bell("p1", noEnd.id, "%moved%")).length === 0,
            { stage: busEvent(noEnd.id, "planning.stage_changed", mark), talk: (await talk()).slice(talkBeforeKept) });

        const { rows: [past] } = await pool.query(
            `INSERT INTO game_sessions (title, campaign_id, date, end_date, is_online) VALUES ('Last week', $1, $2, $3, true) RETURNING id`,
            [campaignId, new Date(Date.now() - DAY), new Date(Date.now() - DAY + 3 * HOUR)]);
        check("a session that has already started can't have its night changed (409)",
            (await call("POST", P(past.id, "reopen"), "gm", { options: [D, E] })).status === 409);
        check("...and isn't listed as coming up",
            !(await call("GET", `/api/planning/campaigns/${campaignId}`, "gm")).json.upcoming?.some((u: any) => u.id === past.id));

        // ── cancelling ──────────────────────────────────────────────────────
        console.log("\n  cancelling");
        await call("POST", P(sidV, "reopen"), "gm", { options: [H, I] });
        const cancelIds = await row(sidV);
        fake.clear();
        check("a player can't cancel (403)", (await call("POST", P(sidV, "cancel"), "p1")).status === 403);
        check("nor can someone outside the party (403)", (await call("POST", P(sidV, "cancel"), "outsider")).status === 403);
        mark = events.length;
        const cx = await call("POST", P(sidV, "cancel"), "gm");
        const cRow = await row(sidV);
        check("cancelling a re-planned night: the session is cancelled and its open round closed",
            cx.status === 200 && cRow.status === "cancelled" && cRow.planning_stage === null &&
                cx.json.night.status === "closed" && cx.json.night.closedReason === "cancelled", cx.json);
        check("...its Discord and Google events are removed, with the GM's keys, and forgotten",
            fake.calls("discord.deleteScheduledEvent")[0]?.args[0].eventId === cancelIds.discord_event_id &&
                fake.calls("discord.deleteScheduledEvent")[0]?.args[0].botToken === bot &&
                fake.calls("google.deleteCalendarEvent")[0]?.args[0] === refresh &&
                fake.calls("google.deleteCalendarEvent")[0]?.args[1] === cancelIds.google_event_id &&
                cRow.discord_event_id === null && cRow.google_event_id === null, { calls: fake.calls(), cRow });
        check("...published", busFor(sidV, mark).join() === "poll_closed:null/cancelled,stage_changed:cancelled/null", busFor(sidV, mark));
        const optionH = optionAt((await call("GET", P(sidV), "gm")).json, H);
        check("later votes are refused (409)", (await call("POST", P(sidV, "vote"), "p1", { optionIds: [optionH] })).status === 409);
        check("...as are moving forward, re-shortlisting and changing the night (409)",
            (await call("POST", P(sidV, "advance"), "gm")).status === 409 &&
                (await call("POST", P(sidV, "reshortlist"), "gm", { options: [D, E] })).status === 409 &&
                (await call("POST", P(sidV, "reopen"), "gm", { options: [D, E] })).status === 409);

        const sidK = await kick("Never shortlisted");
        fake.clear();
        mark = events.length;
        const ck = await call("POST", P(sidK, "cancel"), "admin");
        check("an admin cancels a session before any vote: cancelled, nothing sent out",
            ck.status === 200 && ck.json.session.status === "cancelled" && fake.calls().length === 0 &&
                busFor(sidK, mark).join() === "stage_changed:cancelled/null", { res: ck.json, bus: busFor(sidK, mark) });
        const cf = await call("POST", P(sidF, "cancel"), "gm");
        check("cancelling mid-vote (round 3 of the failed-night session) closes that round",
            cf.json.session.status === "cancelled" && cf.json.night.round === 3 && cf.json.night.closedReason === "cancelled", cf.json.night);
        check("a scheduled session isn't being planned, so it can't be cancelled here (409)",
            (await call("POST", P(sidB, "cancel"), "gm")).status === 409);
    } finally {
        await announcer.idle();
        announcer.stop();
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
