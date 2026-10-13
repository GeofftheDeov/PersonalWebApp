/**
 * The agentic OS overview (/admin/os, #139 of spec #135), seam: the HTTP API.
 *
 * Two harnesses over the same throwaway database loaded from db/schema.sql:
 *
 *   - "prod wiring": the real adminRoutes mounted at /admin, exactly as
 *     server.ts does. It serves /admin/os from the router adminRoutes mounts
 *     (real clock), so the nav, the gate and the mount are checked as shipped.
 *   - "clock harness": the router factory, createOsRouter({ now, tiles }),
 *     behind the real admin gate (adminGate, exported by adminRoutes), with an
 *     injected clock and, where a case needs it, an injected tile list.
 *
 * Everything is asserted through HTTP: numbers through the JSON, and the HTML
 * only for nav and tile presence and state. Admin JWTs are minted directly.
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/t139_test npx tsx scripts/test-os-overview.ts
 *
 * Adding a tile (#141-#145): seed its rows, then add cases to the "tiles"
 * section below; the degradation and no-external-calls cases already cover
 * every tile in TILES. Don't stop this script with `pkill -f`: it matches the
 * shell's own command line and kills the shell.
 */
import "./use-test-jwt-secret.js";
import express from "express";
import type { AddressInfo } from "net";
import crypto from "crypto";
import pool from "../db/index.js";
import adminRoutes, { adminGate } from "../routes/adminRoutes.js";
import dbRoutes from "../routes/dbRoutes.js";
import { createOsRouter } from "../routes/osRoutes.js";
import { TILES } from "../os/tiles/index.js";
import { ok, type TileSource } from "../os/overview.js";
import { signJwt } from "../utils/jwt.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
    console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
    process.exit(2);
}

const MIN = 60_000;

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail: unknown = "") {
    const d = typeof detail === "string" ? detail : JSON.stringify(detail);
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !d ? "" : `\n          ${d}`}`);
    cond ? pass++ : fail++;
}

async function listen(app: express.Express) {
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** One <section data-tile="id" ...> opening tag's attributes, or null. */
function tileTag(html: string, id: string) {
    const m = html.match(new RegExp(`<section[^>]*data-tile="${id}"[^>]*>`));
    if (!m) return null;
    const attr = (name: string) => m[0].match(new RegExp(`data-${name}="([^"]*)"`))?.[1];
    return { status: attr("status"), stale: attr("stale") };
}

async function main() {
    // The clock the harness router reads; each case sets it.
    let clock = new Date();
    const prod = express();
    prod.use(express.json());
    prod.use("/db", dbRoutes);
    prod.use("/admin", adminRoutes);

    /** The factory's router behind the real admin gate, on the injected clock. */
    const harness = (tiles?: readonly TileSource<any>[]) => {
        const app = express();
        app.use(express.json());
        app.use("/admin/os", ...adminGate, createOsRouter({ now: () => clock, ...(tiles ? { tiles } : {}) }));
        return listen(app);
    };

    // Two extra tiles for the degradation case: one reads another table (so
    // only the broken tile goes), one throws.
    const canary: TileSource<{ accounts: number }> = {
        id: "canary", title: "Canary", href: "/admin",
        async build({ db }) {
            const { rows: [r] } = await db.query(`SELECT count(*)::int AS n FROM accounts`);
            return ok({ accounts: r.n });
        },
        render: (t) => `<p>${t.accounts} accounts</p>`,
    };
    const thrower: TileSource<object> = {
        id: "thrower", title: "Thrower", href: "/admin",
        async build() { throw new Error("source exploded"); },
        render: () => "",
    };

    const P = await listen(prod), H = await harness(), D = await harness([...TILES, canary, thrower]);

    const get = async (base: string, path: string, token?: string) => {
        const sep = path.includes("?") ? "&" : "?";
        const res = await fetch(`${base}${path}${token ? `${sep}token=${encodeURIComponent(token)}` : ""}`, { redirect: "manual" });
        const body = await res.text();
        let json: any = null;
        try { json = JSON.parse(body); } catch { /* HTML */ }
        return { status: res.status, location: res.headers.get("location"), body, json };
    };

    const tag = crypto.randomBytes(4).toString("hex");
    const created: string[] = [];
    let renamed = false;

    try {
        // ── personas ────────────────────────────────────────────────────────
        const persona = async (role: "admin" | "user") => {
            const { rows: [row] } = await pool.query(
                `INSERT INTO accounts (id, name, email, password, app_role, app_role_source, is_verified)
                 VALUES (gen_random_uuid(), $1, $2, 'x', $3, 'manual', true) RETURNING id, email`,
                [`OS ${role} ${tag}`, `os-${role}-${tag}@example.test`, role]);
            created.push(row.id);
            return signJwt({ id: row.id, type: "User", email: row.email });
        };
        const adminToken = await persona("admin");
        const userToken = await persona("user");

        // The tests own this throwaway table.
        await pool.query(`DELETE FROM alpaca_snapshots`);

        // ── nav ─────────────────────────────────────────────────────────────
        const pages = ["/admin", "/admin/briefs", "/admin/obsidian", "/admin/alpaca", "/admin/paperclip",
            "/admin/person-sync", "/admin/profile", "/admin/cloud-claw", "/db"];
        const rendered = await Promise.all(pages.map((p) => get(P.base, p, adminToken)));
        const osLink = /<a href="\/admin\/os\?token=[^"]*" class="nav-link ([^"]*)">OS<\/a>/;
        check("every admin page has an OS link in the nav, not marked active",
            rendered.every((r) => r.status === 200 && osLink.test(r.body) && !/active/.test(r.body.match(osLink)![1])),
            pages.map((p, i) => `${p}=${rendered[i].status}/${osLink.test(rendered[i].body) ? "link" : "nolink"}`).join(", "));

        const osPage = await get(P.base, "/admin/os", adminToken);
        check("/admin/os renders through the admin router, with its OS link marked active",
            osPage.status === 200 && /active/.test(osPage.body.match(osLink)?.[1] ?? ""),
            `status ${osPage.status}`);
        check("/admin/os has an Alpaca tile", tileTag(osPage.body, "alpaca") !== null);

        // ── gate ────────────────────────────────────────────────────────────
        for (const path of ["/admin/os", "/admin/os/api/overview"]) {
            const none = await get(P.base, path);
            const user = await get(P.base, path, userToken);
            check(`${path}: no token is redirected to login`, none.status === 302, `status ${none.status}`);
            check(`${path}: a non-admin JWT is turned away (the admin gate's 403) and sees no tile`,
                user.status === 403 && !/data-tile|"tiles"/.test(user.body), `status ${user.status}`);
        }

        // ── Alpaca tile: empty table ────────────────────────────────────────
        clock = new Date("2026-10-12T14:00:00Z");
        const empty = await get(H.base, "/admin/os/api/overview", adminToken);
        const e = empty.json?.tiles?.alpaca;
        check("an empty table makes the Alpaca tile unavailable with 'no snapshots yet' and a hint about the keys",
            empty.status === 200 && e?.status === "unavailable" && /no snapshots yet/i.test(e.reason)
                && /ALPACA_API_KEY/.test(e.reason) && !("equity" in e), e);
        const emptyHtml = await get(H.base, "/admin/os", adminToken);
        check("the empty tile's HTML says 'no snapshots yet' and shows no $0.00",
            tileTag(emptyHtml.body, "alpaca")?.status === "unavailable" && /no snapshots yet/i.test(emptyHtml.body)
                && !/\$0\.00/.test(emptyHtml.body), tileTag(emptyHtml.body, "alpaca"));

        // ── Alpaca tile: latest snapshot wins, P&L % ─────────────────────────
        const snap = (ts: Date, equity: number, lastEquity: number) => pool.query(
            `INSERT INTO alpaca_snapshots (ts, equity, last_equity, cash, buying_power, day_pl)
             VALUES ($1, $2, $3, 1000, 2000, $4)`, [ts, equity, lastEquity, +(equity - lastEquity).toFixed(2)]);
        const latest = new Date("2026-10-12T13:55:00Z");
        // Inserted out of order: the newest ts wins, not the newest row.
        await snap(new Date("2026-10-12T13:45:00Z"), 99_000, 100_000);
        await snap(latest, 100_412.10, 100_000);
        await snap(new Date("2026-10-12T13:50:00Z"), 98_000, 100_000);

        clock = new Date(latest.getTime() + 5 * MIN);
        const fresh = (await get(H.base, "/admin/os/api/overview", adminToken)).json?.tiles?.alpaca;
        check("the latest snapshot (by time) wins", fresh?.status === "ok" && fresh.equity === 100_412.10
            && fresh.lastEquity === 100_000 && fresh.dayPl === 412.10 && fresh.asOf === latest.toISOString(), fresh);
        check("day P&L % is day_pl / last_equity", Math.abs((fresh?.dayPlPct ?? NaN) - 0.4121) < 1e-9, fresh?.dayPlPct);
        check("five minutes old is not stale", fresh?.stale === false, fresh);

        const freshHtml = await get(H.base, "/admin/os", adminToken);
        const ft = tileTag(freshHtml.body, "alpaca");
        check("the ok tile renders signed dollars and percent, an 'as of' in Central, and links to /admin/alpaca",
            ft?.status === "ok" && ft.stale === "false" && freshHtml.body.includes("+$412.10")
                && freshHtml.body.includes("+0.41%") && /as of [^<]*CT/.test(freshHtml.body)
                && /href="\/admin\/alpaca\?token=/.test(freshHtml.body), ft);

        // A down day carries an explicit minus sign.
        await snap(new Date(latest.getTime() + MIN), 99_500, 100_000);
        clock = new Date(latest.getTime() + 6 * MIN);
        const downHtml = await get(H.base, "/admin/os", adminToken);
        const down = (await get(H.base, "/admin/os/api/overview", adminToken)).json?.tiles?.alpaca;
        check("a down day is negative in the JSON and shows an explicit − sign",
            down?.dayPl === -500 && Math.abs(down.dayPlPct + 0.5) < 1e-9
                && downHtml.body.includes("−$500.00") && downHtml.body.includes("−0.50%"), down);
        await pool.query(`DELETE FROM alpaca_snapshots WHERE ts = $1`, [new Date(latest.getTime() + MIN)]);

        // ── Alpaca tile: staleness on the injected clock ────────────────────
        clock = new Date(latest.getTime() + 15 * MIN);
        const at15 = (await get(H.base, "/admin/os/api/overview", adminToken)).json?.tiles?.alpaca;
        clock = new Date(latest.getTime() + 15 * MIN + 1000);
        const past15 = (await get(H.base, "/admin/os/api/overview", adminToken)).json?.tiles?.alpaca;
        check("exactly 15 minutes old is not stale; a second later it is",
            at15?.stale === false && past15?.stale === true, { at15: at15?.stale, past15: past15?.stale });
        const staleHtml = await get(H.base, "/admin/os", adminToken);
        check("the stale tile is flagged in the HTML", tileTag(staleHtml.body, "alpaca")?.stale === "true"
            && /STALE/.test(staleHtml.body), tileTag(staleHtml.body, "alpaca"));

        // Yesterday's snapshot is yesterday's P&L, not "today".
        clock = new Date("2026-10-13T15:00:00Z");
        const oldHtml = await get(H.base, "/admin/os", adminToken);
        check("a snapshot from an earlier Central day labels its P&L with that day, not 'today'",
            oldHtml.body.includes("on Oct 12") && !/<span class="muted">today<\/span>/.test(oldHtml.body));

        // numeric accepts NaN; a NaN snapshot is unavailable, never "$NaN".
        const nanTs = new Date(latest.getTime() + 2 * MIN);
        await pool.query(`INSERT INTO alpaca_snapshots (ts, equity, last_equity, day_pl) VALUES ($1, 'NaN', 100000, 'NaN')`, [nanTs]);
        clock = new Date(latest.getTime() + 5 * MIN);
        const nan = (await get(H.base, "/admin/os/api/overview", adminToken)).json?.tiles?.alpaca;
        const nanHtml = await get(H.base, "/admin/os", adminToken);
        check("a snapshot with NaN equity makes the tile unavailable, not '$NaN'",
            nan?.status === "unavailable" && /no usable equity/.test(nan.reason) && !/NaN/.test(nanHtml.body), nan);
        await pool.query(`DELETE FROM alpaca_snapshots WHERE ts = $1`, [nanTs]);

        // ── Usage tile (#144) ───────────────────────────────────────────────
        // Seeded in March 2026, far from the real clock, so nothing another case
        // (or a live runner) writes lands in these windows. The clock sits on
        // Tue Mar 10, two days after DST began: the window is 7 Central days
        // including today, Wed Mar 4 00:00 CST (06:00Z) to Wed Mar 11 00:00 CDT
        // (05:00Z), and its start and end carry different UTC offsets.
        const usageRunner = `t144-${tag}`;
        const run = (finishedAt: Date | null, usage: { cost?: number; input?: number; output?: number; ms?: number } = {},
            opts: { skill?: string; trigger?: string; status?: string } = {}) => pool.query(
            `INSERT INTO agent_runs (skill, status, requested_at, claimed_at, finished_at, runner,
                                     cost_usd, input_tokens, output_tokens, duration_ms, trigger)
             VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [opts.skill ?? "morning-brief", opts.status ?? (finishedAt ? "succeeded" : "running"),
                new Date((finishedAt ?? clock).getTime() - 5 * MIN), finishedAt, usageRunner,
                usage.cost ?? null, usage.input ?? null, usage.output ?? null, usage.ms ?? null, opts.trigger ?? "button"]);
        const usageAt = async (at: Date) => {
            clock = at;
            return (await get(H.base, "/admin/os/api/overview", adminToken)).json?.tiles?.usage;
        };
        const usageNow = new Date("2026-03-10T18:00:00Z");
        const windowStart = new Date("2026-03-04T06:00:00Z");
        const windowEnd = new Date("2026-03-11T05:00:00Z");
        const SEC = 1000;

        // Inside: the first instant of the window, mid-window (a scheduled run), and today.
        await run(windowStart, { cost: 0.5, input: 1_000, output: 100, ms: 60_000 });
        await run(new Date("2026-03-07T12:00:00Z"), { cost: 1.25, input: 20_000, output: 3_000, ms: 90_000 },
            { skill: "weekly-review", trigger: "scheduled" });
        await run(new Date("2026-03-10T11:45:00Z"), { cost: 0.0025, input: 50, output: 5, ms: 1_000 },
            { trigger: "manual" });
        // Inside, but without usage: a failed run the runner sent nothing for.
        await run(new Date("2026-03-09T12:00:00Z"), {}, { status: "failed" });
        // Just outside: a second before the window opens, and the first instant of tomorrow.
        await run(new Date(windowStart.getTime() - SEC), { cost: 9, input: 900_000, output: 90_000 });
        await run(windowEnd, { cost: 7, input: 700_000, output: 70_000 });
        // Still running: nothing finished, nothing to count.
        await run(null, {}, { status: "running" });

        const u = await usageAt(usageNow);
        check("the usage tile is ok and covers 7 Central days including today, across the DST change",
            u?.status === "ok" && u.from === windowStart.toISOString() && u.to === windowEnd.toISOString(), u);
        check("the totals cover only the window: runs just outside it are excluded",
            u?.costUsd === 1.7525 && u.inputTokens === 21_050 && u.outputTokens === 3_105, u);
        check("runs without usage are counted separately, not added as zero",
            u?.runs === 4 && u.runsWithUsage === 3 && u.runsWithoutUsage === 1, u);

        // ── degradation ─────────────────────────────────────────────────────
        clock = new Date(latest.getTime() + 5 * MIN);

        await pool.query(`ALTER TABLE alpaca_snapshots RENAME TO alpaca_snapshots_t139_renamed`);
        renamed = true;
        const broken = await get(D.base, "/admin/os/api/overview", adminToken);
        const bt = broken.json?.tiles ?? {};
        check("a renamed table makes only the Alpaca tile unavailable, naming the table, and the JSON is still 200",
            broken.status === 200 && bt.alpaca?.status === "unavailable" && /alpaca_snapshots/.test(bt.alpaca.reason)
                && bt.canary?.status === "ok" && bt.canary.accounts >= 2, { status: broken.status, bt });
        check("a tile that throws is unavailable with the reason", bt.thrower?.status === "unavailable"
            && /source exploded/.test(bt.thrower.reason), bt.thrower);
        const brokenHtml = await get(D.base, "/admin/os", adminToken);
        check("the page still renders (200) with the broken tile unavailable and the others ok",
            brokenHtml.status === 200 && tileTag(brokenHtml.body, "alpaca")?.status === "unavailable"
                && tileTag(brokenHtml.body, "canary")?.status === "ok"
                && tileTag(brokenHtml.body, "thrower")?.status === "unavailable", brokenHtml.status);
        await pool.query(`ALTER TABLE alpaca_snapshots_t139_renamed RENAME TO alpaca_snapshots`);
        renamed = false;

        // ── no external calls ───────────────────────────────────────────────
        const realFetch = globalThis.fetch;
        const outbound: string[] = [];
        globalThis.fetch = (async (input: any, init?: any) => {
            const url = String(input?.url ?? input);
            if (!url.startsWith(H.base) && !url.startsWith(P.base)) outbound.push(url);
            return realFetch(input, init);
        }) as typeof fetch;
        let calm: any;
        try {
            calm = (await get(H.base, "/admin/os/api/overview", adminToken)).json;
            await get(H.base, "/admin/os", adminToken);
        } finally { globalThis.fetch = realFetch; }
        check("an overview with every tile ok makes no outbound calls (never Alpaca)",
            Object.values(calm?.tiles ?? {}).every((t: any) => t.status === "ok") && outbound.length === 0,
            { outbound, tiles: Object.keys(calm?.tiles ?? {}) });

        // ── the page ────────────────────────────────────────────────────────
        check("the page refreshes itself every 2 minutes while visible, with no CDN scripts",
            /visibilityState/.test(osPage.body) && /120000/.test(osPage.body) && !/<script[^>]+src=/.test(osPage.body));
        // A phone only reaches the 800px breakpoint if the page lays out at device width.
        check("the layout pins calc(100vh - 60px), lays out at device width and stacks to one column below 800px",
            /calc\(100vh - 60px\)/.test(osPage.body) && /@media \(max-width: 800px\)/.test(osPage.body)
                && /<meta name="viewport" content="width=device-width/.test(osPage.body));
    } finally {
        if (renamed) await pool.query(`ALTER TABLE alpaca_snapshots_t139_renamed RENAME TO alpaca_snapshots`).catch(() => {});
        await pool.query(`DELETE FROM alpaca_snapshots`).catch(() => {});
        await pool.query(`DELETE FROM agent_runs WHERE runner = $1`, [`t144-${tag}`]).catch(() => {});
        for (const id of created) await pool.query(`DELETE FROM accounts WHERE id = $1`, [id]);
        P.server.close(); H.server.close(); D.server.close();
    }

    console.log(`\n  ${pass} passed, ${fail} failed\n`);
    await pool.end();
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
