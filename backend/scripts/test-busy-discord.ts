/**
 * Discord "interested" busy time (#85, part of #57), over HTTP.
 *
 * Installs the integrations fake (testing/fakeIntegrations.ts) so each guild's
 * scheduled events and their interested users are scripted, mounts the real
 * availability, API-key and friends (link-discord) routers, and drives them
 * with real JWTs against a throwaway database loaded from db/schema.sql.
 * Checks what's visible from outside: responses, the rows behind them, and
 * the Discord reads the fake received. The real Discord reads are then run
 * against a stubbed `fetch` for paging and rate limits. No real Discord call
 * is ever made.
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-busy-discord.ts
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
const { default: availabilityRoutes } = await import("../routes/availabilityRoutes.js");
const { default: apiKeyRoutes } = await import("../routes/apiKeyRoutes.js");
const { default: friendRoutes } = await import("../routes/friendRoutes.js");
const { createFakeIntegrations } = await import("../testing/fakeIntegrations.js");
const { DiscordApiError, realIntegrations } = await import("../utils/integrations.js");
const { DEFAULT_EVENT_HOURS, MAX_EVENTS_PER_GUILD, forgetDiscordReads } = await import("../planning/discordBusySource.js");

const SECRET = process.env.JWT_SECRET || "your-secret-key-change-this";
const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
    const d = typeof detail === "string" ? detail : JSON.stringify(detail);
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !d ? "" : `\n          ${d}`}`);
    ok ? pass++ : fail++;
}

/** Anything in a slot or the party list that would say where busy time came from, or what it was. */
const LEAK = /google|discord|source|title|raid|secret|evt-|lastError|guild/i;

async function main() {
    const fake = createFakeIntegrations();
    const uninstall = fake.install();

    const app = express();
    app.use(express.json());
    app.use("/api/availability", availabilityRoutes);
    app.use("/api/api-keys", apiKeyRoutes);
    app.use("/api/friends", friendRoutes);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const tag = crypto.randomBytes(4).toString("hex");
    const who: Record<string, { id: string; token: string }> = {};
    const campaigns: Record<string, string> = {};

    const call = async (method: string, path: string, as?: string, body?: unknown) => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (as) headers.authorization = `Bearer ${who[as].token}`;
        const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        return { status: res.status, json, text };
    };
    const discordOf = async (as: string) =>
        (await call("GET", "/api/availability/me/busy-sources", as)).json?.sources?.find((s: any) => s.source === "discord");
    const snowflake = (n: number) => `1${String(n).padStart(17, "0")}`;
    const discordIdOf: Record<string, string> = { alice: snowflake(1), bob: snowflake(2), erin: snowflake(5), frank: snowflake(6) };
    const botToken = (gm: string) => `bot-${gm}-${tag}`;
    const guild = { main: `9${tag}01`, other: `9${tag}02`, absent: `9${tag}03`, big: `9${tag}04` };

    // The night being planned: a week out, 17:00-23:00 UTC, in one-hour slots.
    const day = new Date(Date.now() + 7 * DAY);
    day.setUTCHours(0, 0, 0, 0);
    const at = (h: number) => new Date(day.getTime() + h * HOUR);
    const iso = (h: number) => at(h).toISOString();
    const rangeQs = `start=${iso(17)}&end=${iso(23)}&slotMinutes=60&stepMinutes=60`;
    const overlap = (campaign: string, as: string) => call("GET", `/api/availability/campaigns/${campaigns[campaign]}?${rangeQs}`, as);
    const slotAt = (o: any, h: number) => o.json?.slots?.find((s: any) => s.start === iso(h));
    const busyHours = (o: any, name: string) =>
        [17, 18, 19, 20, 21, 22].filter((h) => slotAt(o, h)?.busy.includes(who[name].id));
    const blocksOf = async (name: string) => (await pool.query(
        `SELECT row_to_json(b)::text AS j, starts_at, ends_at, external_id FROM busy_blocks b
          WHERE person_id = $1 AND source = 'discord' ORDER BY starts_at`, [who[name].id])).rows;
    const discordCalls = () => fake.calls().filter((c) => c.name.startsWith("discord."));
    const fresh = () => { fake.clear(); forgetDiscordReads(); };
    const expire = (name: string) => pool.query(
        `UPDATE busy_sources SET synced_at = synced_at - interval '1 hour', last_attempt_at = last_attempt_at - interval '1 hour'
          WHERE person_id = $1 AND source = 'discord'`, [who[name].id]);

    // Scripted Discord. Each guild's events, and who is interested in each.
    // The fake hands back names a careless sync might keep.
    type Ev = { id: string; start: number; end: number | null; status?: number; interested: string[] };
    let guilds: Record<string, Ev[]> = {};
    let notInGuild = new Set<string>([guild.absent]);
    let outage = new Set<string>();
    let latencyMs = 0;   // per interested-users read
    fake.respond("discord.listScheduledEvents", async (token, guildId) => {
        if (notInGuild.has(guildId)) throw new DiscordApiError(403, 50001, '{"message": "Missing Access", "code": 50001}');
        if (outage.has(guildId)) throw new DiscordApiError(502, null, "Bad Gateway");
        return (guilds[guildId] ?? []).map((e) => ({
            id: e.id, start: at(e.start), end: e.end === null ? null : at(e.end), status: e.status ?? 1,
            name: "Secret raid night", description: "dragons",
        }) as any);
    });
    fake.respond("discord.listInterestedUsers", async (token, guildId, eventId) => {
        if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
        return [...(guilds[guildId] ?? []).find((e) => e.id === eventId)?.interested ?? []];
    });

    try {
        for (const name of ["gm", "gm2", "gm3", "gm4", "alice", "bob", "carol", "dave", "erin", "frank"]) {
            const email = `dbusy-${name}-${tag}@example.test`;
            const { rows: [acct] } = await pool.query(
                `INSERT INTO accounts (id, handle, email) VALUES (gen_random_uuid(), $1, $2) RETURNING id`, [`d${name}_${tag}`, email]);
            who[name] = { id: acct.id, token: jwt.sign({ id: acct.id, email }, SECRET, { expiresIn: "1h" }) };
        }
        const makeCampaign = async (key: string, gm: string, guildId: string | null, players: string[]) => {
            const { rows: [c] } = await pool.query(
                `INSERT INTO campaigns (title, owner_id, discord_guild_id) VALUES ($1, $2, $3) RETURNING id`,
                [`Discord busy ${key}`, who[gm].id, guildId]);
            campaigns[key] = c.id;
            for (const [i, name] of [gm, ...players].entries()) {
                await pool.query(`INSERT INTO campaign_members (campaign_id, person_id, status, joined_at) VALUES ($1, $2, $3, $4)`,
                    [c.id, who[name].id, i === 0 ? "Game Master" : "Player", new Date(Date.UTC(2026, 0, 1 + i))]);
            }
        };
        // main: linked guild, GM's bot token.   other: linked guild, GM has no bot token.
        // absent: the bot isn't in the guild.   unlinked: no guild at all.   quiet: nobody uses Discord.
        await makeCampaign("main", "gm", guild.main, ["alice", "bob", "carol", "dave"]);
        await makeCampaign("other", "gm2", guild.other, ["alice"]);
        await makeCampaign("absent", "gm3", guild.absent, ["alice"]);
        await makeCampaign("unlinked", "gm4", null, ["alice"]);
        await makeCampaign("quiet", "gm4", guild.main, ["dave"]);
        await makeCampaign("big", "gm", guild.big, ["frank"]);
        for (const name of ["gm", "alice", "bob", "carol", "dave"]) {
            await call("PUT", "/api/availability/me/windows", name,
                { windows: [{ weekday: day.getUTCDay(), start: "17:00", end: "23:00", timeZone: "UTC" }] });
        }
        for (const gm of ["gm", "gm3"]) {
            check(`${gm} keeps a Discord bot token in the API Key Vault`,
                (await call("PUT", "/api/api-keys/discord", gm, { keyId: "bot", secret: botToken(gm) })).status === 200);
        }
        // Alice, Bob and Erin link Discord the way the profile does; Carol and Dave never do.
        for (const name of ["alice", "bob", "erin", "frank"]) {
            await call("POST", "/api/friends/link-discord", name, { discordId: discordIdOf[name], discordHandle: `${name}#0001` });
        }

        // The campaign's own session, already on Discord: being interested in it must not block planning it.
        const ownEventId = `evt-own-${tag}`;
        await pool.query(
            `INSERT INTO game_sessions (campaign_id, title, date, end_date, is_online, discord_event_id)
             VALUES ($1, 'Session 3', $2, $3, true, $4)`, [campaigns.main, at(21), at(22), ownEventId]);

        guilds = {
            [guild.main]: [
                { id: `evt-a-${tag}`, start: 18, end: 19, interested: [discordIdOf.alice, snowflake(99)] },
                { id: `evt-b-${tag}`, start: 20, end: null, interested: [discordIdOf.bob] },           // no end time
                { id: `evt-c-${tag}`, start: 17, end: 18, status: 4, interested: [discordIdOf.alice] }, // canceled
                { id: ownEventId, start: 21, end: 22, interested: [discordIdOf.alice, discordIdOf.bob] },
                { id: `evt-far-${tag}`, start: 24 * 120, end: 24 * 120 + 2, interested: [discordIdOf.alice] }, // months away
            ],
            [guild.absent]: [{ id: `evt-x-${tag}`, start: 19, end: 20, interested: [discordIdOf.alice] }],
        };

        console.log("\n#85 — Discord \"interested\" busy time\n");

        // ── the switch ──────────────────────────────────────────────────────
        const da = await discordOf("alice");
        check("my busy sources list Discord events: linked, ready, off",
            da && da.connected && da.ready && !da.enabled && !da.needsReconsent && da.problem === null, da);
        const dc = await discordOf("carol");
        check("...a player with no linked Discord id: not ready, told how to link it",
            dc && !dc.connected && !dc.ready && /discord user id/i.test(dc.problem ?? ""), dc);
        const carolOn = await call("PUT", "/api/availability/me/busy-sources/discord", "carol");
        check("...so Discord can't be turned on for her (409 with the reason), and Discord isn't asked",
            carolOn.status === 409 && /discord user id/i.test(carolOn.json?.error) && discordCalls().length === 0, carolOn.json);

        // ── matched players ─────────────────────────────────────────────────
        fresh();
        const aliceOn = await call("PUT", "/api/availability/me/busy-sources/discord", "alice");
        const listCalls = fake.calls("discord.listScheduledEvents");
        check("turning Discord on syncs straight away and works",
            aliceOn.status === 200 && aliceOn.json.source.enabled && !!aliceOn.json.source.syncedAt && aliceOn.json.source.lastError === null,
            aliceOn.json);
        check("...reading each of her campaigns' linked guilds with that campaign's GM bot token",
            listCalls.some((c) => c.args[0] === botToken("gm") && c.args[1] === guild.main) &&
                listCalls.some((c) => c.args[0] === botToken("gm3") && c.args[1] === guild.absent),
            listCalls.map((c) => c.args));
        check("...skipping a guild whose GM has no bot token, and campaigns with no guild",
            !listCalls.some((c) => c.args[1] === guild.other) && listCalls.length === 2, listCalls.map((c) => c.args[1]));
        const userCalls = fake.calls("discord.listInterestedUsers");
        check("...asking who is interested only in live events inside the sync window (not canceled, not months away)",
            userCalls.length > 0 && userCalls.every((c) => c.args[0] === botToken("gm") && c.args[1] === guild.main) &&
                !userCalls.some((c) => c.args[2] === `evt-c-${tag}` || c.args[2] === `evt-far-${tag}`),
            userCalls.map((c) => c.args.slice(1)));

        const aliceBlocks = await blocksOf("alice");
        check("events she marked interested are stored as bare busy blocks, with the event id and no title",
            aliceBlocks.length === 2 && +aliceBlocks[0].starts_at === +at(18) && +aliceBlocks[0].ends_at === +at(19) &&
                aliceBlocks[0].external_id === `evt-a-${tag}` && aliceBlocks[1].external_id === ownEventId &&
                !/raid|dragons|secret/i.test(aliceBlocks.map((b) => b.j).join()), aliceBlocks);
        check("Bob turns Discord on too", (await call("PUT", "/api/availability/me/busy-sources/discord", "bob")).status === 200);
        const bobBlocks = await blocksOf("bob");
        check(`an event with no end time counts for ${DEFAULT_EVENT_HOURS} hours`,
            bobBlocks.some((b) => +b.starts_at === +at(20) && +b.ends_at === +at(20 + DEFAULT_EVENT_HOURS)), bobBlocks);

        fresh();
        const o1 = await overlap("main", "gm");
        check("the GM's overlap shows events a player marked interested as busy",
            o1.status === 200 && JSON.stringify(busyHours(o1, "alice")) === "[18]" &&
                JSON.stringify(busyHours(o1, "bob")) === "[20,21,22]", { alice: busyHours(o1, "alice"), bob: busyHours(o1, "bob") });
        check("...but not the campaign's own session event (Alice is interested in it at 21:00, and is free then)",
            !busyHours(o1, "alice").includes(21) && slotAt(o1, 21)?.free.includes(who.alice.id), o1.json?.slots);
        check("...a player with no linked Discord id just has no Discord signal, and no error",
            JSON.stringify(busyHours(o1, "carol")) === "[]" && slotAt(o1, 17).free.includes(who.carol.id), slotAt(o1, 17));
        check("...nothing in the slots or party says why anyone is busy",
            !LEAK.test(JSON.stringify({ slots: o1.json?.slots, party: o1.json?.party })), JSON.stringify(o1.json).match(LEAK));
        check("...and with the guild readable and a bot token, the GM gets no note", Array.isArray(o1.json?.notes) && o1.json.notes.length === 0, o1.json?.notes);
        check("...the fresh syncs were reused: only the GM-note check read the guild list, once",
            fake.calls("discord.listInterestedUsers").length === 0 && fake.calls("discord.listScheduledEvents").length === 1,
            discordCalls().map((c) => c.name));

        const p1 = await call("GET", `/api/availability/me/preview?start=${iso(17)}&end=${iso(21)}`, "alice");
        check("Alice's own preview shows the event she's interested in as busy, without title or source",
            p1.status === 200 && JSON.stringify(p1.json.runs.map((r: any) => [r.start.slice(11, 13), r.end.slice(11, 13), r.presence])) ===
                JSON.stringify([["17", "18", "free"], ["18", "19", "busy"], ["19", "21", "free"]]) && !LEAK.test(p1.text), p1.json);

        // A party member's sync reads a guild once, however many of them sync together.
        await expire("alice"); await expire("bob");
        fresh();
        await overlap("main", "gm");
        const mainReads = fake.calls("discord.listScheduledEvents").filter((c) => c.args[1] === guild.main);
        check("two players syncing in one overlap share one read of the guild",
            mainReads.length === 1, fake.calls("discord.listScheduledEvents").map((c) => c.args[1]));

        // ── the GM's notes: why Discord busy time is missing ────────────────
        fresh();
        const oOther = await overlap("other", "gm2");
        check("no bot token in the GM's vault: the overlap still loads, and the GM is told why Discord is skipped",
            oOther.status === 200 && oOther.json.notes.length === 1 && /bot token/i.test(oOther.json.notes[0]) &&
                busyHours(oOther, "alice").includes(18), { notes: oOther.json?.notes, alice: busyHours(oOther, "alice") });
        check("...and there, the main campaign's session Alice is interested in counts as busy: it's another game",
            JSON.stringify(busyHours(oOther, "alice")) === "[18,21]", busyHours(oOther, "alice"));
        const oAbsent = await overlap("absent", "gm3");
        check("the bot not in the guild: the overlap still loads, with a short note",
            oAbsent.status === 200 && oAbsent.json.notes.length === 1 && /bot isn.t in/i.test(oAbsent.json.notes[0]), oAbsent.json?.notes);
        check("...and that guild's events never count (Alice isn't busy at 19:00 there)",
            !busyHours(oAbsent, "alice").includes(19) && !(await blocksOf("alice")).some((b) => b.external_id === `evt-x-${tag}`));
        const oUnlinked = await overlap("unlinked", "gm4");
        check("no linked guild: the overlap still loads, with a short note",
            oUnlinked.status === 200 && oUnlinked.json.notes.length === 1 && /no discord server/i.test(oUnlinked.json.notes[0]), oUnlinked.json?.notes);
        check("...the notes name no player", ![...oOther.json.notes, ...oAbsent.json.notes, ...oUnlinked.json.notes]
            .some((n: string) => /alice|bob|dbusy/i.test(n) || n.includes(who.alice.id)));
        const oQuiet = await overlap("quiet", "gm4");
        check("a campaign where nobody counts Discord events gets no note", oQuiet.status === 200 && oQuiet.json.notes.length === 0, oQuiet.json?.notes);
        const aliceTab = await discordOf("alice");
        check("Alice's own tab shows no error for the GMs' setup problems", aliceTab.enabled && aliceTab.lastError === null, aliceTab);

        // ── Discord down for a guild ────────────────────────────────────────
        outage = new Set([guild.main]);
        await expire("alice");
        fresh();
        const oDown = await overlap("main", "gm");
        check("if Discord can't be read, the overlap still loads and Alice falls back to her windows",
            oDown.status === 200 && JSON.stringify(busyHours(oDown, "alice")) === "[]" && (await blocksOf("alice")).length === 2,
            busyHours(oDown, "alice"));
        check("...the GM is told Discord couldn't be read", oDown.json.notes.some((n: string) => /couldn.t be read/i.test(n)), oDown.json?.notes);
        const aliceDown = await discordOf("alice");
        check("...and Alice sees on her own tab that the last sync failed", /discord/i.test(aliceDown.lastError ?? ""), aliceDown);
        outage = new Set();

        // ── interest changes ────────────────────────────────────────────────
        await call("POST", "/api/availability/me/busy-sources/discord/sync", "alice");   // the server's reads are now shared
        guilds[guild.main][0].interested = [snowflake(99)];
        guilds[guild.main].push({ id: `evt-d-${tag}`, start: 19, end: 20, interested: [discordIdOf.alice] });
        fake.clear();   // shared reads kept: "Sync now" must not answer from them
        const syncNow = await call("POST", "/api/availability/me/busy-sources/discord/sync", "alice");
        const oMoved = await overlap("main", "gm");
        check("\"Sync now\" picks up a changed interest: the old event drops off, the new one counts",
            syncNow.status === 200 && syncNow.json.source.lastError === null && JSON.stringify(busyHours(oMoved, "alice")) === "[19]",
            busyHours(oMoved, "alice"));

        // ── unlinking and turning off ───────────────────────────────────────
        await call("POST", "/api/friends/link-discord", "bob", { discordId: "", discordHandle: "" });
        fresh();
        const bobAfter = await call("POST", "/api/availability/me/busy-sources/discord/sync", "bob");
        check("a player who removes their Discord id loses their Discord busy time, without an error",
            bobAfter.status === 200 && bobAfter.json.source.lastError === null && (await blocksOf("bob")).length === 0 &&
                discordCalls().length === 0, { res: bobAfter.json, calls: discordCalls().length });

        const off = await call("DELETE", "/api/availability/me/busy-sources/discord", "alice");
        check("turning Discord off removes Alice's Discord busy blocks (204)",
            off.status === 204 && (await blocksOf("alice")).length === 0 && !(await discordOf("alice")).enabled);

        // Erin is in no campaign: turning Discord on works and finds nothing.
        fresh();
        const erinOn = await call("PUT", "/api/availability/me/busy-sources/discord", "erin");
        check("a linked player in no Discord-linked campaign: on, synced, no busy time, no Discord calls",
            erinOn.status === 200 && erinOn.json.source.lastError === null && (await blocksOf("erin")).length === 0 && discordCalls().length === 0,
            erinOn.json);

        // A big community server: every event's interested users, read a few at a time.
        guilds[guild.big] = Array.from({ length: MAX_EVENTS_PER_GUILD + 10 }, (_, i) => ({
            id: `evt-big-${i}-${tag}`, start: 24 + i, end: 25 + i, interested: i === 3 ? [discordIdOf.frank] : [snowflake(500 + i)],
        }));
        latencyMs = 300;
        fresh();
        const t0 = Date.now();
        const frankOn = await call("PUT", "/api/availability/me/busy-sources/discord", "frank");
        const took = Date.now() - t0;
        latencyMs = 0;
        const bigReads = fake.calls("discord.listInterestedUsers").filter((c) => c.args[1] === guild.big);
        check(`a server with many events syncs in time: at most ${MAX_EVENTS_PER_GUILD} events, read in parallel (300 ms each)`,
            frankOn.status === 200 && frankOn.json.source.lastError === null && bigReads.length === MAX_EVENTS_PER_GUILD &&
                took < 10_000 && (await blocksOf("frank")).length === 1, { took, reads: bigReads.length, res: frankOn.json });

        check("only the integrations fake was ever called", fake.calls().every((c) => c.name.startsWith("discord.list")),
            [...new Set(fake.calls().map((c) => c.name))]);
    } finally {
        if (Object.keys(campaigns).length) await pool.query(`DELETE FROM campaigns WHERE id = ANY($1)`, [Object.values(campaigns)]);
        const ids = Object.values(who).map((p) => p.id);
        if (ids.length) await pool.query(`DELETE FROM accounts WHERE id = ANY($1)`, [ids]);
        uninstall();
        server.close();
    }

    // ── the real Discord reads, against a stubbed fetch ─────────────────────
    console.log("\n  real Discord reads (fetch stubbed)\n");
    const realFetch = globalThis.fetch;
    const requests: { url: string; auth: string | null }[] = [];
    try {
        const users = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({
            guild_scheduled_event_id: "e1", user: { id: snowflake(from + i), username: `user${from + i}`, avatar: "abc" },
        }));
        let rateLimitedOnce = false;
        globalThis.fetch = (async (input: any, init?: any) => {
            const url = String(input);
            requests.push({ url, auth: new Headers(init?.headers).get("authorization") });
            const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
                new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
            if (url.includes("/guilds/403/")) return json({ message: "Missing Access", code: 50001 }, 403);
            if (url.endsWith("/scheduled-events")) {
                return json([
                    { id: "e1", name: "Secret raid", description: "dragons", scheduled_start_time: "2026-11-01T18:00:00+00:00", scheduled_end_time: null, status: 1, creator: { id: "1" } },
                    { id: "e2", name: "Other", scheduled_start_time: "2026-11-02T18:00:00+00:00", scheduled_end_time: "2026-11-02T20:00:00+00:00", status: 2 },
                ]);
            }
            const after = new URL(url).searchParams.get("after");
            if (after === "0" && !rateLimitedOnce) { rateLimitedOnce = true; return json({ message: "You are being rate limited.", retry_after: 0.01, global: false }, 429); }
            if (after === "0") return json(users(1000, 100), 200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "0.01" });
            return json(users(2000, 3));
        }) as typeof fetch;

        const evs = await realIntegrations.discord.listScheduledEvents("tok", "123");
        check("listScheduledEvents keeps only id, times and status (no name or description)",
            evs.length === 2 && JSON.stringify(Object.keys(evs[0]).sort()) === JSON.stringify(["end", "id", "start", "status"]) &&
                evs[0].end === null && +evs[1].end! === Date.parse("2026-11-02T20:00:00Z") && evs[1].status === 2, evs);
        check("...as the bot, at /guilds/{id}/scheduled-events",
            requests[0]?.auth === "Bot tok" && requests[0].url === "https://discord.com/api/v10/guilds/123/scheduled-events", requests[0]);

        requests.length = 0;
        const ids = await realIntegrations.discord.listInterestedUsers("tok", "123", "e1");
        check("listInterestedUsers retries a short 429 once, then pages 100 at a time with after=<last id>",
            ids.length === 103 && ids[0] === snowflake(1000) && ids[102] === snowflake(2002) && requests.length === 3 &&
                requests.every((r) => /\/guilds\/123\/scheduled-events\/e1\/users\?limit=100&after=/.test(r.url)) &&
                new URL(requests[2].url).searchParams.get("after") === snowflake(1099), requests.map((r) => r.url));
        check("...returning bare user ids only", ids.every((id) => /^\d+$/.test(id)));

        let err: any = null;
        try { await realIntegrations.discord.listScheduledEvents("tok", "403"); } catch (e) { err = e; }
        check("a bot that isn't in the guild surfaces as DiscordApiError 403 / 50001",
            err instanceof DiscordApiError && err.status === 403 && err.code === 50001, String(err));
    } finally {
        globalThis.fetch = realFetch;
    }

    console.log(`\n  ${pass} passed, ${fail} failed\n`);
    await pool.end();
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
