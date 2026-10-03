/**
 * Google Calendar busy time (#84, part of #57), over HTTP.
 *
 * Installs the integrations fake (testing/fakeIntegrations.ts) so Google
 * free/busy is scripted, mounts the real availability, Google Calendar and
 * API-key routers, and drives them with real JWTs against a throwaway database
 * loaded from db/schema.sql. Checks what's visible from outside: responses,
 * the rows behind them, bus events, and the free/busy calls the fake received.
 * No real Google call is ever made: the client id and secret are dummies.
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-busy-google.ts
 */
import express from "express";
import type { AddressInfo } from "net";
import crypto from "crypto";
import jwt from "jsonwebtoken";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
    console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
    process.exit(2);
}
// Throwaway values for this run only: the vault key, and an OAuth client that
// is never used to reach Google (building a consent URL is local).
process.env.VAULT_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
process.env.GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";

const { default: pool } = await import("../db/index.js");
const { bus } = await import("../events/index.js");
const { default: availabilityRoutes } = await import("../routes/availabilityRoutes.js");
const { default: googleCalendarRoutes } = await import("../routes/googleCalendarRoutes.js");
const { default: apiKeyRoutes } = await import("../routes/apiKeyRoutes.js");
const { saveGoogleGrant, SCOPE_EVENTS, SCOPE_FREEBUSY } = await import("../utils/googleCalendarGrant.js");
const { createFakeIntegrations } = await import("../testing/fakeIntegrations.js");
const { FRESH_MINUTES, HORIZON_DAYS } = await import("../planning/busySources.js");

const SECRET = process.env.JWT_SECRET || "your-secret-key-change-this";
const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
    const d = typeof detail === "string" ? detail : JSON.stringify(detail);
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !d ? "" : `\n          ${d}`}`);
    ok ? pass++ : fail++;
}

/** Anything that would say where busy time came from, or what it was. */
const LEAK = /google|discord|source|title|summary|dentist|evt-|lastError|reconnect/i;

async function main() {
    const fake = createFakeIntegrations();
    const uninstall = fake.install();

    const app = express();
    app.use(express.json());
    app.use("/api/availability", availabilityRoutes);
    app.use("/api/google-calendar", googleCalendarRoutes);
    app.use("/api/api-keys", apiKeyRoutes);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const events: any[] = [];
    bus.subscribe("availability.changed", (p) => { events.push(p); });

    const tag = crypto.randomBytes(4).toString("hex");
    const who: Record<string, { id: string; token: string }> = {};
    let campaignId = "";

    const call = async (method: string, path: string, as?: string, body?: unknown) => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (as) headers.authorization = `Bearer ${who[as].token}`;
        const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
        const text = await res.text();
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        return { status: res.status, json, text, location: res.headers.get("location") ?? "" };
    };
    const google = async (as: string) => (await call("GET", "/api/availability/me/busy-sources", as)).json?.sources?.find((s: any) => s.source === "google");
    const freeBusyCalls = () => fake.calls("google.freeBusy");
    const tokenOf = (name: string) => `refresh-${name}-${tag}`;

    // The night being planned: a week out, 17:00-23:00 UTC, in one-hour slots.
    const day = new Date(Date.now() + 7 * DAY);
    day.setUTCHours(0, 0, 0, 0);
    const at = (h: number, d = day) => new Date(d.getTime() + h * HOUR);
    const iso = (h: number, d = day) => at(h, d).toISOString();
    const mid = new Date(day.getTime() + 35 * DAY);   // beyond the 28-day horizon, close enough to share a sync with it
    const far = new Date(day.getTime() + 84 * DAY);   // too far to share: synced on its own
    const rangeQs = (d = day) => `start=${iso(17, d)}&end=${iso(23, d)}&slotMinutes=60&stepMinutes=60`;
    const overlap = (d = day) => call("GET", `/api/availability/campaigns/${campaignId}?${rangeQs(d)}`, "gm");
    const slotAt = (o: any, h: number, d = day) => o.json?.slots?.find((s: any) => s.start === iso(h, d));
    const busyHours = (o: any, name: string, d = day) =>
        [17, 18, 19, 20, 21, 22].filter((h) => slotAt(o, h, d)?.busy.includes(who[name].id));
    const blocksOf = async (name: string) => (await pool.query(
        `SELECT row_to_json(b)::text AS j, starts_at, ends_at, external_id FROM busy_blocks b
          WHERE person_id = $1 AND source = 'google' ORDER BY starts_at`, [who[name].id])).rows;

    // Scripted Google: each person's calendar, keyed by their refresh token.
    // The fake hands back extra fields a careless sync might keep.
    let calendars: Record<string, [number, number][]> = {};
    let broken = new Set<string>();
    let brokenWith = "Google Calendar API 500: backendError";
    fake.respond("google.freeBusy", async (refreshToken, input) => {
        const name = Object.keys(who).find((n) => tokenOf(n) === refreshToken) ?? "?";
        if (broken.has(name)) throw new Error(brokenWith);
        // The same hours on each night the test plans; the sync keeps
        // whichever fall inside the window it asked about.
        return [day, mid, far].flatMap((d) => (calendars[name] ?? []).map(([s, e]) => ({
            start: at(s, d), end: at(e, d), summary: "Dentist (secret)", id: `evt-${name}`,
        }) as any)).filter((b) => b.end > input.start && b.start < input.end);
    });

    try {
        for (const name of ["gm", "alice", "bob", "carol", "dave", "erin"]) {
            const email = `busy-${name}-${tag}@example.test`;
            const { rows: [acct] } = await pool.query(
                `INSERT INTO accounts (id, handle, email) VALUES (gen_random_uuid(), $1, $2) RETURNING id`, [`${name}_${tag}`, email]);
            who[name] = { id: acct.id, token: jwt.sign({ id: acct.id, email }, SECRET, { expiresIn: "1h" }) };
        }
        const { rows: [camp] } = await pool.query(
            `INSERT INTO campaigns (title, owner_id) VALUES ('Busy test', $1) RETURNING id`, [who.gm.id]);
        campaignId = camp.id;
        for (const [i, name] of ["gm", "alice", "bob", "carol", "dave"].entries()) {
            await pool.query(`INSERT INTO campaign_members (campaign_id, person_id, status, joined_at) VALUES ($1, $2, $3, $4)`,
                [campaignId, who[name].id, i === 0 ? "Game Master" : "Player", new Date(Date.UTC(2026, 0, 1 + i))]);
            await call("PUT", "/api/availability/me/windows", name,
                { windows: [{ weekday: day.getUTCDay(), start: "17:00", end: "23:00", timeZone: "UTC" }] });
        }

        console.log("\n#84 — Google Calendar busy time\n");

        // ── the scope: new connections ask for free/busy up front ───────────
        const authUrl = await call("GET", "/api/google-calendar/auth-url?return=availability", "alice");
        const consent = new URL(authUrl.json?.url ?? "http://x");
        const scopes = (consent.searchParams.get("scope") ?? "").split(" ");
        check("a new connection asks for calendar.events and calendar.freebusy, offline, with consent",
            authUrl.status === 200 && scopes.includes(SCOPE_EVENTS) && scopes.includes(SCOPE_FREEBUSY) && scopes.length === 2 &&
                consent.searchParams.get("access_type") === "offline" && consent.searchParams.get("prompt") === "consent" &&
                consent.searchParams.get("include_granted_scopes") === "true", authUrl.json);
        const state: any = jwt.decode(consent.searchParams.get("state") ?? "");
        check("...and remembers to come back to the Availability tab (only a known tab)",
            state?.back === "availability" && state?.id === who.alice.id &&
                (jwt.decode(new URL((await call("GET", "/api/google-calendar/auth-url?return=https://evil.test", "alice")).json.url)
                    .searchParams.get("state") ?? "") as any)?.back === undefined, state);
        const denied = await call("GET", `/api/google-calendar/callback?error=access_denied&state=${consent.searchParams.get("state")}`);
        check("a cancelled consent goes back to the Availability tab",
            denied.status === 302 && /\/profile\?gcal=denied&tab=availability$/.test(denied.location), denied.location);

        // Alice and Bob connect after #84 (what the callback stores); Carol
        // connected before it (calendar.events only, the old callback's key id);
        // Erin unticked free/busy on Google's granular consent screen; Dave never connected.
        const granted = `openid ${SCOPE_EVENTS} ${SCOPE_FREEBUSY}`;
        await saveGoogleGrant(who.alice.id, tokenOf("alice"), granted);
        await saveGoogleGrant(who.bob.id, tokenOf("bob"), granted);
        await saveGoogleGrant(who.erin.id, tokenOf("erin"), SCOPE_EVENTS);
        check("Carol's pre-#84 connection is stored the way the old callback stored it",
            (await call("PUT", "/api/api-keys/google_calendar", "carol", { keyId: "oauth-refresh-token", secret: tokenOf("carol") })).status === 200);

        const st = async (name: string) => (await call("GET", "/api/google-calendar/status", name)).json;
        const [sa, sc, se, sd] = [await st("alice"), await st("carol"), await st("erin"), await st("dave")];
        check("status: a post-#84 connection can read free/busy",
            sa.connected && sa.freeBusy && !sa.needsReconsent, sa);
        check("status: a pre-#84 connection is asked to reconnect once",
            sc.connected && !sc.freeBusy && sc.needsReconsent, sc);
        check("status: a connection without the free/busy grant is asked too", se.connected && se.needsReconsent, se);
        check("status: no connection, nothing to reconnect", !sd.connected && !sd.needsReconsent, sd);

        // ── turning Google on ───────────────────────────────────────────────
        check("no token, no busy sources", (await call("GET", "/api/availability/me/busy-sources")).status === 401);
        const ga = await google("alice");
        check("my busy sources list Google: connected, ready, off",
            ga && ga.connected && ga.ready && !ga.enabled && !ga.needsReconsent && ga.freshMinutes === FRESH_MINUTES, ga);
        const gc = await google("carol");
        check("...for a pre-#84 connection: not ready, needs reconsent, says how to fix it",
            gc && gc.connected && !gc.ready && gc.needsReconsent && /reconnect/i.test(gc.problem), gc);

        const carolOn = await call("PUT", "/api/availability/me/busy-sources/google", "carol");
        const daveOn = await call("PUT", "/api/availability/me/busy-sources/google", "dave");
        const erinOn = await call("PUT", "/api/availability/me/busy-sources/google", "erin");
        check("Google can't be turned on until it can read free/busy (409 with the reason)",
            carolOn.status === 409 && /reconnect/i.test(carolOn.json.error) && daveOn.status === 409 && /connect/i.test(daveOn.json.error) &&
                erinOn.status === 409, [carolOn.json, daveOn.json, erinOn.json]);
        check("...and nothing reached Google", freeBusyCalls().length === 0, fake.calls());
        check("an unknown source is a 404", (await call("PUT", "/api/availability/me/busy-sources/outlook", "alice")).status === 404 &&
            (await call("DELETE", "/api/availability/me/busy-sources/outlook", "alice")).status === 404);

        calendars = { alice: [[18, 19]], bob: [[20, 21]] };
        const before = Date.now();
        const aliceOn = await call("PUT", "/api/availability/me/busy-sources/google", "alice");
        const firstCall = freeBusyCalls()[0];
        check("turning Google on syncs straight away, with Alice's own token",
            aliceOn.status === 200 && aliceOn.json.source.enabled && aliceOn.json.source.syncedAt && aliceOn.json.source.lastError === null &&
                freeBusyCalls().length === 1 && firstCall.args[0] === tokenOf("alice"), { res: aliceOn.json, calls: freeBusyCalls() });
        const [win] = firstCall ? [firstCall.args[1]] : [{ start: new Date(0), end: new Date(0) }];
        check(`a sync reads the planning horizon: yesterday to ${HORIZON_DAYS} days out (+1 day)`,
            Math.abs(win.start.getTime() - (before - DAY)) < 60_000 && Math.abs(win.end.getTime() - (before + (HORIZON_DAYS + 1) * DAY)) < 60_000,
            { start: win.start, end: win.end });
        const aliceBlocks = await blocksOf("alice");
        check("Google busy time is stored as bare busy blocks: times only, no title, no event id",
            aliceBlocks.length === 1 && +aliceBlocks[0].starts_at === +at(18) && +aliceBlocks[0].ends_at === +at(19) &&
                aliceBlocks[0].external_id === null && !/dentist|evt-/i.test(aliceBlocks[0].j), aliceBlocks);
        check("...and publishes availability.changed (busy) for Alice",
            events.some((e) => e.personId === who.alice.id && e.what === "busy"), events);
        check("Bob turns Google on too", (await call("PUT", "/api/availability/me/busy-sources/google", "bob")).status === 200);

        // ── the overlap and the preview ─────────────────────────────────────
        const callsBefore = freeBusyCalls().length;
        const o1 = await overlap();
        check("the GM's overlap shows Google busy time as busy",
            o1.status === 200 && JSON.stringify(busyHours(o1, "alice")) === "[18]" && JSON.stringify(busyHours(o1, "bob")) === "[20]" &&
                slotAt(o1, 17).headcount === 5 && slotAt(o1, 18).headcount === 4, o1.json?.slots);
        check("...without saying why: no source, title, event id or error anywhere in it", !LEAK.test(o1.text), o1.text.match(LEAK));
        check(`...and data under ${FRESH_MINUTES} minutes old that covers the range isn't fetched again`,
            freeBusyCalls().length === callsBefore, freeBusyCalls().length);

        const p1 = await call("GET", `/api/availability/me/preview?start=${iso(17)}&end=${iso(23)}`, "alice");
        check("Alice's own preview shows that hour busy, without title or source",
            p1.status === 200 && JSON.stringify(p1.json.runs.map((r: any) => [r.start.slice(11, 13), r.end.slice(11, 13), r.presence])) ===
                JSON.stringify([["17", "18", "free"], ["18", "19", "busy"], ["19", "23", "free"]]) && !LEAK.test(p1.text), p1.json);

        // ── freshness ───────────────────────────────────────────────────────
        await pool.query(`UPDATE busy_sources SET synced_at = synced_at - interval '${FRESH_MINUTES + 1} minutes' WHERE person_id = $1`, [who.alice.id]);
        calendars.alice = [[19, 20]];
        fake.clear();
        const o2 = await overlap();
        check(`after ${FRESH_MINUTES} minutes, the next overlap re-reads only the stale calendar`,
            freeBusyCalls().length === 1 && freeBusyCalls()[0].args[0] === tokenOf("alice"), freeBusyCalls().map((c) => c.args[0]));
        check("...and the overlap uses the new answer (the old block is replaced, not added to)",
            JSON.stringify(busyHours(o2, "alice")) === "[19]" && (await blocksOf("alice")).length === 1, busyHours(o2, "alice"));

        // ── Google failing for one player ───────────────────────────────────
        await pool.query(`UPDATE busy_sources SET synced_at = synced_at - interval '1 hour' WHERE person_id = ANY($1)`, [[who.alice.id, who.bob.id]]);
        broken = new Set(["alice"]);
        fake.clear();
        const o4 = await overlap();
        check("if Google fails for Alice, the overlap still loads",
            o4.status === 200 && freeBusyCalls().length === 2 && freeBusyCalls().some((c) => c.error), freeBusyCalls().map((c) => c.error?.message));
        check("...falling back to her windows: her stored Google block (19:00) is left out",
            JSON.stringify(busyHours(o4, "alice")) === "[]" && (await blocksOf("alice")).some((b) => +b.starts_at === +at(19)),
            busyHours(o4, "alice"));
        check("...while Bob's Google busy time still counts", JSON.stringify(busyHours(o4, "bob")) === "[20]", busyHours(o4, "bob"));
        check("...and the GM's overlap doesn't mention the failure", !LEAK.test(o4.text), o4.text.match(LEAK));
        const gaFailed = await google("alice");
        check("Alice sees on her own tab that the last sync failed",
            gaFailed.enabled && /couldn't be read/i.test(gaFailed.lastError ?? ""), gaFailed);

        fake.clear();
        const o5 = await overlap();
        check("a failed calendar isn't retried on every load for a few minutes (still falls back)",
            o5.status === 200 && freeBusyCalls().length === 0 && JSON.stringify(busyHours(o5, "alice")) === "[]", freeBusyCalls().length);

        broken = new Set();
        const syncNow = await call("POST", "/api/availability/me/busy-sources/google/sync", "alice");
        check("\"Sync now\" retries straight away and clears the error",
            syncNow.status === 200 && syncNow.json.source.lastError === null && freeBusyCalls().length === 1, syncNow.json);
        check("...and the overlap counts her busy time again", JSON.stringify(busyHours(await overlap(), "alice")) === "[19]");

        broken = new Set(["alice"]);
        const failedNow = await call("POST", "/api/availability/me/busy-sources/google/sync", "alice");
        fake.clear();
        const o5b = await overlap();
        check("a failed \"Sync now\" stops her still-young Google data counting too, as her tab says",
            failedNow.status === 200 && !!failedNow.json.source.lastError && JSON.stringify(busyHours(o5b, "alice")) === "[]" &&
                freeBusyCalls().length === 0, { res: failedNow.json, busy: busyHours(o5b, "alice") });
        broken = new Set();
        await call("POST", "/api/availability/me/busy-sources/google/sync", "alice");

        // ── ranges outside the horizon ──────────────────────────────────────
        fake.clear();
        const midAsked = Date.now();
        const oMid = await overlap(mid);
        const midCalls = freeBusyCalls();
        check("a range just past the horizon stretches the sync over it (horizon and range in one read), for everyone using Google",
            oMid.status === 200 && midCalls.length === 2 && midCalls.every((c) =>
                Math.abs(+c.args[1].start - (midAsked - DAY)) < 60_000 && +c.args[1].end === +at(23 + 24, mid)),
            midCalls.map((c) => [c.args[0], c.args[1]]));
        check("...and its busy time counts there", JSON.stringify(busyHours(oMid, "alice", mid)) === "[19]" &&
            JSON.stringify(busyHours(oMid, "bob", mid)) === "[20]", oMid.json?.slots?.slice(0, 2));
        fake.clear();
        await overlap();
        await overlap(mid);
        check("...so the near and the stretched range then share that sync instead of re-reading each other",
            freeBusyCalls().length === 0, freeBusyCalls().length);

        fake.clear();
        const o3 = await overlap(far);
        const farCalls = freeBusyCalls();
        check("a range too far to share a sync is read on its own (a day either side)",
            o3.status === 200 && farCalls.length === 2 && farCalls.every((c) =>
                +c.args[1].start === +at(17 - 24, far) && +c.args[1].end === +at(23 + 24, far)),
            farCalls.map((c) => [c.args[0], c.args[1]]));
        check("...its busy time counts there", JSON.stringify(busyHours(o3, "alice", far)) === "[19]" &&
            JSON.stringify(busyHours(o3, "bob", far)) === "[20]", o3.json?.slots?.slice(0, 2));
        check("...and it leaves the nearer busy time alone (a concurrent near overlap can't lose it)",
            (await blocksOf("alice")).some((b) => +b.starts_at === +at(19)) && (await blocksOf("alice")).some((b) => +b.starts_at === +at(19, far)),
            (await blocksOf("alice")).map((b) => b.starts_at));

        // ── turning Google off ──────────────────────────────────────────────
        events.length = 0;
        const off = await call("DELETE", "/api/availability/me/busy-sources/google", "alice");
        const { rows: [srcRow] } = await pool.query(`SELECT count(*)::int AS n FROM busy_sources WHERE person_id = $1`, [who.alice.id]);
        check("turning Google off removes Alice's Google busy blocks (204)",
            off.status === 204 && (await blocksOf("alice")).length === 0 && srcRow.n === 0 && !(await google("alice")).enabled);
        check("...and publishes availability.changed", events.some((e) => e.personId === who.alice.id && e.what === "busy"), events);
        fake.clear();
        const o6 = await overlap();
        check("...so the overlap shows her free again, without asking Google",
            JSON.stringify(busyHours(o6, "alice")) === "[]" && freeBusyCalls().every((c) => c.args[0] !== tokenOf("alice")), busyHours(o6, "alice"));
        check("syncing a source that's off is a 404",
            (await call("POST", "/api/availability/me/busy-sources/google/sync", "alice")).status === 404);
        check("Alice's Google connection itself is untouched (events still work)", (await st("alice")).connected);

        // ── disconnecting Google turns it off as a busy source too ──────────
        check("Bob has Google busy blocks", (await blocksOf("bob")).length > 0);
        const disc = await call("DELETE", "/api/google-calendar", "bob");
        const gb = await google("bob");
        check("disconnecting Google Calendar removes it as a busy source, and its blocks",
            disc.status === 200 && (await blocksOf("bob")).length === 0 && !gb.enabled && !gb.connected, gb);

        // ── re-consent happens once ─────────────────────────────────────────
        await saveGoogleGrant(who.carol.id, tokenOf("carol"), `${SCOPE_EVENTS} ${SCOPE_FREEBUSY}`);
        calendars.carol = [[21, 22]];
        const carolAgain = await call("PUT", "/api/availability/me/busy-sources/google", "carol");
        check("after Carol reconnects once, Google turns on and her busy time counts",
            carolAgain.status === 200 && !(await st("carol")).needsReconsent &&
                JSON.stringify(busyHours(await overlap(), "carol")) === "[21]", carolAgain.json);

        // A 403 that is a rate limit isn't a consent problem.
        broken = new Set(["carol"]);
        brokenWith = 'Google Calendar API 403: {"error":{"errors":[{"reason":"rateLimitExceeded"}]}}';
        const limited = await call("POST", "/api/availability/me/busy-sources/google/sync", "carol");
        check("a rate-limited Google says so, rather than asking Carol to reconnect",
            /limiting requests/i.test(limited.json?.source?.lastError ?? "") && !/reconnect/i.test(limited.json.source.lastError), limited.json);
        brokenWith = 'Google Calendar API 403: {"error":{"status":"PERMISSION_DENIED","details":[{"reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}';
        const narrow = await call("POST", "/api/availability/me/busy-sources/google/sync", "carol");
        check("...while a grant that's too narrow does ask her to reconnect",
            /reconnect/i.test(narrow.json?.source?.lastError ?? ""), narrow.json);
        broken = new Set();

        const vaultDelete = await call("DELETE", "/api/api-keys/google_calendar", "carol");
        const gcGone = await google("carol");
        check("removing the Google entry from the API Key Vault also turns Google off as a busy source, and deletes its blocks",
            vaultDelete.status === 200 && !gcGone.enabled && !gcGone.connected && (await blocksOf("carol")).length === 0, gcGone);

        check("only the integrations fake was ever called", fake.calls().every((c) => c.name === "google.freeBusy"),
            fake.calls().map((c) => c.name));
    } finally {
        if (campaignId) await pool.query(`DELETE FROM campaigns WHERE id = $1`, [campaignId]);
        const ids = Object.values(who).map((p) => p.id);
        if (ids.length) await pool.query(`DELETE FROM accounts WHERE id = ANY($1)`, [ids]);
        uninstall();
        server.close();
    }

    console.log(`\n  ${pass} passed, ${fail} failed\n`);
    await pool.end();
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
