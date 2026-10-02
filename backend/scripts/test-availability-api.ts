/**
 * Session planning (#57), seam 1 for regular availability: the HTTP API.
 *
 * Mounts the real availability and campaign routers the way server.ts does and
 * drives them over HTTP with real JWTs, against a throwaway database loaded
 * from db/schema.sql. Checks what a person could see from outside: responses,
 * the rows behind them, and the bus events other features listen for.
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-availability-api.ts
 */
import express from "express";
import type { AddressInfo } from "net";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import pool from "../db/index.js";
import { bus } from "../events/index.js";
import availabilityRoutes from "../routes/availabilityRoutes.js";
import campaignRoutes from "../routes/campaignRoutes.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
    console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
    process.exit(2);
}

const SECRET = process.env.JWT_SECRET || "your-secret-key-change-this";
const DAY = 24 * 60 * 60 * 1000;

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
    const d = typeof detail === "string" ? detail : JSON.stringify(detail);
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !d ? "" : `\n          ${d}`}`);
    ok ? pass++ : fail++;
}

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api/campaigns", campaignRoutes);
    app.use("/api/availability", availabilityRoutes);
    return app;
}

async function main() {
    const server = buildApp().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const events: any[] = [];
    bus.subscribe("availability.changed", (p) => { events.push(p); });

    const tag = crypto.randomBytes(4).toString("hex");
    const people: Record<string, { id: string; token: string }> = {};
    const campaigns: string[] = [];

    const call = async (method: string, path: string, who?: string, body?: unknown) => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (who) headers.authorization = `Bearer ${people[who].token}`;
        const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        return { status: res.status, json, text };
    };

    try {
        // ── personas ────────────────────────────────────────────────────────
        for (const who of ["gm", "alice", "bob", "newbie", "outsider"]) {
            const email = `avail-${who}-${tag}@example.test`;
            const { rows: [row] } = await pool.query(
                `INSERT INTO accounts (id, handle, email) VALUES (gen_random_uuid(), $1, $2) RETURNING id`,
                [`${who}_${tag}`, email]);
            people[who] = { id: row.id, token: jwt.sign({ id: row.id, email }, SECRET, { expiresIn: "1h" }) };
        }
        const { rows: [camp] } = await pool.query(
            `INSERT INTO campaigns (title, owner_id) VALUES ('Overlap test', $1) RETURNING id`, [people.gm.id]);
        campaigns.push(camp.id);
        const join = (who: string, status: string, joined: string) => pool.query(
            `INSERT INTO campaign_members (campaign_id, person_id, status, joined_at) VALUES ($1, $2, $3, $4)`,
            [camp.id, people[who].id, status, joined]);
        await join("gm", "Game Master", "2026-01-01");
        await join("alice", "Player", "2026-01-02");
        await join("bob", "Player", "2026-01-03");
        await join("newbie", "Player", "2026-01-04");

        console.log("\n#57 — availability API\n");

        // ── weekly windows ──────────────────────────────────────────────────
        check("no token, no access", (await call("GET", "/api/availability/me")).status === 401);

        const empty = await call("GET", "/api/availability/me", "newbie");
        check("someone who never set availability gets an empty week, not an error",
            empty.status === 200 && empty.json.windows.length === 0 && empty.json.exceptions.length === 0, empty.json);

        const week = [
            { weekday: 6, start: "18:00", end: "23:00", timeZone: "America/Chicago" },
            { weekday: 5, start: "21:00", end: "01:00", timeZone: "America/Chicago" },   // crosses midnight
            { weekday: 6, start: "18:00", end: "23:00", timeZone: "America/Chicago" },   // duplicate
        ];
        const put = await call("PUT", "/api/availability/me/windows", "alice", { windows: week });
        check("PUT replaces the week, dropping an exact duplicate, sorted by weekday",
            put.status === 200 && JSON.stringify(put.json.windows.map((w: any) => [w.weekday, w.start, w.end, w.timeZone])) ===
                JSON.stringify([[5, "21:00", "01:00", "America/Chicago"], [6, "18:00", "23:00", "America/Chicago"]]), put.json);

        const bad = [
            ["an unknown time zone", { weekday: 6, start: "18:00", end: "23:00", timeZone: "Mars/Olympus_Mons" }],
            ["weekday 7", { weekday: 7, start: "18:00", end: "23:00", timeZone: "UTC" }],
            ["24:00", { weekday: 6, start: "18:00", end: "24:00", timeZone: "UTC" }],
            ["an empty window", { weekday: 6, start: "18:00", end: "18:00", timeZone: "UTC" }],
        ] as const;
        for (const [what, w] of bad) {
            const r = await call("PUT", "/api/availability/me/windows", "alice", { windows: [w] });
            check(`${what} is a 400 with a message`, r.status === 400 && typeof r.json?.error === "string", r.json);
        }
        const tooMany = await call("PUT", "/api/availability/me/windows", "alice", {
            windows: Array.from({ length: 51 }, (_, i) => ({ weekday: i % 7, start: "18:00", end: "19:00", timeZone: "UTC" })) });
        check("more than 50 windows is refused", tooMany.status === 400);
        check("not an array is refused", (await call("PUT", "/api/availability/me/windows", "alice", { windows: "Sat" })).status === 400);
        const after = await call("GET", "/api/availability/me", "alice");
        check("a refused save changes nothing", after.json.windows.length === 2, after.json);

        await call("PUT", "/api/availability/me/windows", "gm", { windows: [{ weekday: 6, start: "17:00", end: "23:00", timeZone: "America/Chicago" }] });
        // Bob is in London: Sun midnight-5 am BST is Sat 6-11 pm CDT.
        await call("PUT", "/api/availability/me/windows", "bob", { windows: [{ weekday: 0, start: "00:00", end: "05:00", timeZone: "Europe/London" }] });
        const others = await call("GET", "/api/availability/me", "bob");
        check("each person sees only their own windows", others.json.windows.length === 1 && others.json.windows[0].timeZone === "Europe/London");

        const cleared = await call("PUT", "/api/availability/me/windows", "outsider", { windows: [] });
        check("an empty list clears the week", cleared.status === 200 && cleared.json.windows.length === 0);

        // ── exceptions ──────────────────────────────────────────────────────
        const soon = new Date(Date.now() + 7 * DAY), soonEnd = new Date(soon.getTime() + DAY);
        const add = await call("POST", "/api/availability/me/exceptions", "alice",
            { start: soon.toISOString(), end: soonEnd.toISOString(), kind: "unavailable", note: "  out of town  " });
        check("an exception is added (201), with its note trimmed",
            add.status === 201 && add.json.exception.kind === "unavailable" && add.json.exception.note === "out of town", add.json);
        await pool.query(
            `INSERT INTO availability_exceptions (person_id, starts_at, ends_at, kind) VALUES ($1, $2, $3, 'available')`,
            [people.alice.id, new Date(Date.now() - 3 * DAY), new Date(Date.now() - 2 * DAY)]);
        const list = await call("GET", "/api/availability/me/exceptions", "alice");
        check("only exceptions that haven't finished are listed",
            list.status === 200 && list.json.exceptions.length === 1 && list.json.exceptions[0].id === add.json.exception.id, list.json);

        const badExceptions = [
            ["end before start", { start: soonEnd.toISOString(), end: soon.toISOString(), kind: "unavailable" }],
            ["an unknown kind", { start: soon.toISOString(), end: soonEnd.toISOString(), kind: "maybe" }],
            ["a date that isn't one", { start: "next tuesday", end: soonEnd.toISOString(), kind: "available" }],
            ["one already over", { start: new Date(Date.now() - 2 * DAY).toISOString(), end: new Date(Date.now() - DAY).toISOString(), kind: "available" }],
        ] as const;
        for (const [what, body] of badExceptions) {
            const r = await call("POST", "/api/availability/me/exceptions", "alice", body);
            check(`an exception with ${what} is a 400`, r.status === 400, r.json);
        }
        check("someone else's exception can't be removed (404, and it stays)",
            (await call("DELETE", `/api/availability/me/exceptions/${add.json.exception.id}`, "bob")).status === 404 &&
            (await call("GET", "/api/availability/me/exceptions", "alice")).json.exceptions.length === 1);
        check("a malformed id is a 404, not a 500",
            (await call("DELETE", "/api/availability/me/exceptions/not-a-uuid", "alice")).status === 404);
        const del = await call("DELETE", `/api/availability/me/exceptions/${add.json.exception.id}`, "alice");
        check("my own exception is removed (204)",
            del.status === 204 && (await call("GET", "/api/availability/me/exceptions", "alice")).json.exceptions.length === 0);

        // ── the party overlap ───────────────────────────────────────────────
        // Sat Oct 10 2026: gm 5-11 pm CDT (22:00Z-04:00Z); alice and bob 6-11 pm
        // CDT (23:00Z-04:00Z); newbie has set nothing. Quorum: whole party (4).
        const range = "start=2026-10-10T22:00:00Z&end=2026-10-11T05:00:00Z&slotMinutes=240&stepMinutes=60";
        const path = `/api/availability/campaigns/${camp.id}?${range}`;
        const o = await call("GET", path, "gm");
        const top = o.json?.slots?.[0];
        check("the Game Master gets the overlap: party in joining order, quorum = whole party",
            o.status === 200 && JSON.stringify(o.json.party.map((p: any) => p.id)) ===
                JSON.stringify([people.gm.id, people.alice.id, people.bob.id, people.newbie.id]) &&
                o.json.quorum === 4 && o.json.party[1].name === `alice_${tag}`, o.json);
        check("slots are ranked by headcount; the best has the three who set availability, newbie unknown",
            top?.start === "2026-10-10T23:00:00.000Z" && top.headcount === 3 && top.meetsQuorum === false &&
                JSON.stringify(top.free) === JSON.stringify([people.gm.id, people.alice.id, people.bob.id]) &&
                JSON.stringify(top.unknown) === JSON.stringify([people.newbie.id]), top);

        await pool.query(`UPDATE campaigns SET quorum = 3 WHERE id = $1`, [camp.id]);
        const q3 = await call("GET", path, "gm");
        check("the campaign's quorum setting decides which slots are workable",
            q3.json.quorum === 3 && q3.json.slots.filter((s: any) => s.meetsQuorum).map((s: any) => s.start).join() ===
                "2026-10-10T23:00:00.000Z,2026-10-11T00:00:00.000Z", q3.json.slots.slice(0, 3));

        await pool.query(
            `INSERT INTO busy_blocks (person_id, source, starts_at, ends_at, external_id)
             VALUES ($1, 'google', '2026-10-11T01:00Z', '2026-10-11T02:00Z', 'evt-secret-dentist')`, [people.alice.id]);
        const withBusy = await call("GET", path, "gm");
        const slot23 = withBusy.json.slots.find((s: any) => s.start === "2026-10-10T23:00:00.000Z");
        check("a calendar busy block makes alice busy for slots it touches",
            slot23.busy.includes(people.alice.id) && slot23.headcount === 2, slot23);
        check("...and the response never says why: no source, no event id",
            !/google|discord|evt-secret|source|title/i.test(withBusy.text));

        await pool.query(
            `INSERT INTO availability_exceptions (person_id, starts_at, ends_at, kind)
             VALUES ($1, '2026-10-10T23:00Z', '2026-10-11T00:00Z', 'unavailable')`, [people.bob.id]);
        const withOut = await call("GET", path, "gm");
        check("an 'unavailable' exception feeds the overlap too",
            withOut.json.slots.find((s: any) => s.start === "2026-10-10T23:00:00.000Z").busy.includes(people.bob.id));

        check("a player who isn't the Game Master can't see the grid (403)", (await call("GET", path, "alice")).status === 403);
        check("nor can someone outside the campaign (403)", (await call("GET", path, "outsider")).status === 403);
        check("a range that ends before it starts is a 400",
            (await call("GET", `/api/availability/campaigns/${camp.id}?start=2026-10-11T00:00:00Z&end=2026-10-10T00:00:00Z`, "gm")).status === 400);
        check("a range over 62 days is a 400",
            (await call("GET", `/api/availability/campaigns/${camp.id}?start=2026-10-01T00:00:00Z&end=2026-12-15T00:00:00Z`, "gm")).status === 400);
        check("a malformed campaign id is a 404",
            (await call("GET", `/api/availability/campaigns/nope?${range}`, "gm")).status === 404);

        // ── what the party sees about me ────────────────────────────────────
        const preview = await call("GET",
            "/api/availability/me/preview?start=2026-10-10T22:00:00Z&end=2026-10-11T05:00:00Z", "alice");
        check("my preview is my free / busy runs, the busy block included and unexplained",
            preview.status === 200 && JSON.stringify(preview.json.runs.map((r: any) => [r.start.slice(11, 16), r.end.slice(11, 16), r.presence])) ===
                JSON.stringify([["22:00", "23:00", "busy"], ["23:00", "01:00", "free"], ["01:00", "02:00", "busy"],
                                ["02:00", "04:00", "free"], ["04:00", "05:00", "busy"]]) &&
                !/google|evt-secret/.test(preview.text), preview.json);
        const nothing = await call("GET",
            "/api/availability/me/preview?start=2026-10-10T22:00:00Z&end=2026-10-11T05:00:00Z", "newbie");
        check("with nothing set, I show as unknown -- not unavailable",
            JSON.stringify(nothing.json.runs.map((r: any) => r.presence)) === JSON.stringify(["unknown"]), nothing.json);

        // ── events ──────────────────────────────────────────────────────────
        const seen = events.map((e) => `${e.personId === people.alice.id ? "alice" : e.personId === people.gm.id ? "gm" : "other"}:${e.what}`);
        check("every change publishes availability.changed (and refused saves don't)",
            seen.filter((s) => s === "alice:windows").length === 1 &&
                seen.filter((s) => s === "alice:exceptions").length === 2 && seen.includes("gm:windows"), seen);

        // ── campaign ownership ──────────────────────────────────────────────
        const created = await call("POST", "/api/campaigns", "alice",
            { title: "Alice's campaign", description: "d", status: "Not Started", startDate: "2026-11-01" });
        const campaignId = created.json?.campaign?.id;
        if (campaignId) campaigns.push(campaignId);
        const { rows: [own] } = await pool.query(`SELECT owner_id, gm_title FROM campaigns WHERE id = $1`, [campaignId ?? null]);
        check("creating a campaign makes the creator its owner, with the default GM title",
            created.status === 201 && own?.owner_id === people.alice.id && own?.gm_title === "Dungeon Master", { created: created.json, own });
    } finally {
        if (campaigns.length) await pool.query(`DELETE FROM campaigns WHERE id = ANY($1)`, [campaigns]);
        const ids = Object.values(people).map((p) => p.id);
        if (ids.length) await pool.query(`DELETE FROM accounts WHERE id = ANY($1)`, [ids]);
        server.close();
    }

    console.log(`\n  ${pass} passed, ${fail} failed\n`);
    await pool.end();
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
