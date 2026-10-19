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
 * OBSIDIAN_VAULT_PATH points at a temporary vault (scripts/temp-vault.ts),
 * never the real one; the brief tile reads its briefs from there.
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
import { createTempVault } from "./temp-vault.js";

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

/** One tile's whole <section> (tiles don't nest sections), so a text check can't match another tile. */
const tileHtml = (html: string, id: string) =>
    html.match(new RegExp(`<section[^>]*data-tile="${id}"[^>]*>[\\s\\S]*?</section>`))?.[0] ?? "";

async function main() {
    // The brief tile reads the local vault checkout: a throwaway one, set before any tile builds.
    const vault = createTempVault("t142");
    process.env.OBSIDIAN_VAULT_PATH = vault.dir;

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
    let renamed = false, usageRenamed = false, asksRenamed = false;

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
        check("/admin/os has a Claude usage tile, ahead of the Alpaca tile",
            tileTag(osPage.body, "usage") !== null
                && osPage.body.indexOf(`data-tile="usage"`) < osPage.body.indexOf(`data-tile="alpaca"`));
        check("/admin/os has a Brief & runner tile, after the Alpaca tile",
            tileTag(osPage.body, "brief") !== null
                && osPage.body.indexOf(`data-tile="alpaca"`) < osPage.body.indexOf(`data-tile="brief"`));
        check("/admin/os has a Tasks tile, between the Alpaca tile and the brief",
            tileTag(osPage.body, "tasks") !== null
                && osPage.body.indexOf(`data-tile="alpaca"`) < osPage.body.indexOf(`data-tile="tasks"`)
                && osPage.body.indexOf(`data-tile="tasks"`) < osPage.body.indexOf(`data-tile="brief"`));

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
            tileTag(emptyHtml.body, "alpaca")?.status === "unavailable" && /no snapshots yet/i.test(tileHtml(emptyHtml.body, "alpaca"))
                && !/\$0\.00/.test(tileHtml(emptyHtml.body, "alpaca")), tileTag(emptyHtml.body, "alpaca"));

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
            nan?.status === "unavailable" && /no usable equity/.test(nan.reason) && !/NaN/.test(tileHtml(nanHtml.body, "alpaca")), nan);
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
        check("the per-run points are the runs with usage, oldest first, with skill, trigger and outcome",
            u?.points?.length === 3 && u.points.every((p: any) => p.costUsd !== null)
                && u.points[0].finishedAt === windowStart.toISOString() && u.points[1].skill === "weekly-review"
                && u.points[1].trigger === "scheduled" && u.points[1].inputTokens === 20_000
                && u.points[2].trigger === "manual" && u.points[2].ok === true, u?.points);

        const usagePage = await get(H.base, "/admin/os", adminToken);
        const ut = tileTag(usagePage.body, "usage"), usageHtml = tileHtml(usagePage.body, "usage");
        check("the ok usage tile is labelled API-equivalent, counts the run without usage, and links to /admin/briefs",
            ut?.status === "ok" && usageHtml.includes("API-equivalent") && usageHtml.includes("$1.75")
                && /1 run without usage/.test(usageHtml) && /href="\/admin\/briefs\?token=/.test(usageHtml), ut);

        // The newest 30 runs with usage become points; the totals still cover them all.
        const burst = Array.from({ length: 31 }, (_, i) => new Date(new Date("2026-03-08T12:00:00Z").getTime() + i * MIN));
        for (const at of burst) await run(at, { cost: 0.01, input: 10, output: 1 });
        const many = await usageAt(usageNow);
        check("at most 30 points, the newest; the totals still count every run",
            many?.points?.length === 30 && many.runsWithUsage === 34
                && many.points.every((p: any, i: number) => i === 0 || p.finishedAt >= many.points[i - 1].finishedAt)
                && many.points.at(-1).trigger === "manual"
                && !many.points.some((p: any) => p.finishedAt === burst[0].toISOString()),
            { n: many?.points?.length, runsWithUsage: many?.runsWithUsage });
        await pool.query(`DELETE FROM agent_runs WHERE runner = $1 AND finished_at = ANY($2)`, [usageRunner, burst]);

        // An empty window: a week with no runs at all.
        const emptyWeek = await usageAt(new Date("2026-02-10T18:00:00Z"));
        check("an empty window is reported as empty (no cost, no tokens), not $0",
            emptyWeek?.status === "ok" && emptyWeek.runs === 0 && emptyWeek.runsWithUsage === 0
                && emptyWeek.costUsd === null && emptyWeek.inputTokens === null && emptyWeek.points?.length === 0, emptyWeek);
        const emptyWeekPage = await get(H.base, "/admin/os", adminToken);
        const emptyWeekHtml = tileHtml(emptyWeekPage.body, "usage");
        check("the empty tile says 'no runs with usage in the last 7 days', not $0.00",
            tileTag(emptyWeekPage.body, "usage")?.status === "ok"
                && emptyWeekHtml.includes("no runs with usage in the last 7 days") && !/\$0\.00/.test(emptyWeekHtml));

        // A window whose only runs reported nothing is still empty of usage, not $0.
        await run(new Date("2026-02-20T15:00:00Z"), {}, { status: "failed" });
        await run(new Date("2026-02-21T15:00:00Z"));
        const noUsage = await usageAt(new Date("2026-02-21T18:00:00Z"));
        check("runs without any usage are counted, and the totals stay empty rather than zero",
            noUsage?.runs === 2 && noUsage.runsWithoutUsage === 2 && noUsage.runsWithUsage === 0
                && noUsage.costUsd === null && noUsage.outputTokens === null, noUsage);
        const noUsageHtml = tileHtml((await get(H.base, "/admin/os", adminToken)).body, "usage");
        check("...and the tile says so, with the count of runs without usage",
            noUsageHtml.includes("no runs with usage in the last 7 days") && /2 runs without usage/.test(noUsageHtml)
                && !/\$0\.00/.test(noUsageHtml));

        // numeric accepts NaN, and CHECK (cost_usd >= 0) lets it through: never "$NaN".
        await pool.query(`INSERT INTO agent_runs (skill, status, finished_at, runner, cost_usd)
                          VALUES ('morning-brief', 'succeeded', $1, $2, 'NaN')`, [new Date("2026-02-21T16:00:00Z"), usageRunner]);
        const nanUsage = await usageAt(new Date("2026-02-21T18:00:00Z"));
        const nanUsageHtml = tileHtml((await get(H.base, "/admin/os", adminToken)).body, "usage");
        check("a NaN cost makes the usage tile unavailable, not '$NaN'",
            nanUsage?.status === "unavailable" && /isn't a number/.test(nanUsage.reason) && !/NaN/.test(nanUsageHtml), nanUsage);
        await pool.query(`DELETE FROM agent_runs WHERE runner = $1 AND cost_usd = 'NaN'`, [usageRunner]);

        // The usage migration not applied: the tile names it; the other tiles carry on.
        await pool.query(`ALTER TABLE agent_runs RENAME COLUMN cost_usd TO cost_usd_t144_renamed`);
        usageRenamed = true;
        clock = usageNow;
        const unmigrated = await get(H.base, "/admin/os/api/overview", adminToken);
        const um = unmigrated.json?.tiles ?? {};
        check("a renamed usage column makes the usage tile unavailable and names the migration; the JSON is still 200",
            unmigrated.status === 200 && um.usage?.status === "unavailable" && /cost_usd/.test(um.usage.reason)
                && um.usage.reason.includes("2026-10-12-agent-run-usage.sql") && um.alpaca?.status === "ok", um);
        const unmigratedHtml = await get(H.base, "/admin/os", adminToken);
        check("the unmigrated usage tile is unavailable in the HTML, naming the migration",
            unmigratedHtml.status === 200 && tileTag(unmigratedHtml.body, "usage")?.status === "unavailable"
                && tileHtml(unmigratedHtml.body, "usage").includes("2026-10-12-agent-run-usage.sql"));
        await pool.query(`ALTER TABLE agent_runs RENAME COLUMN cost_usd_t144_renamed TO cost_usd`);
        usageRenamed = false;

        // ── Usage tile: today's tier-2 spend against its daily cap (#156) ───
        // Tue Mar 10, 2026 (CDT, UTC-5): today is 05:00Z to Mar 11 05:00Z. The
        // asks are the admin's; spend is every priced model call on the day.
        const askSpend = (at: Date, cost: number | null, tier = 2) => pool.query(
            `INSERT INTO os_asks (account_id, asked_at, text, source, tier, kind, intent, latency_ms, model, cost_usd)
             VALUES ($1, $2, 't156 seeded spend', 'typed', $3, 'answer', 'model.answer', 0, $4, $5)`,
            [created[0], at, tier, cost === null ? null : "claude-haiku-5-5", cost]);
        delete process.env.OS_ASK_DAILY_BUDGET_USD;
        const quiet = await usageAt(usageNow);
        const quietHtml = tileHtml((await get(H.base, "/admin/os", adminToken)).body, "usage");
        check("with no asks today, the tile shows nothing spent at tier 2 against the default $0.25 cap",
            quiet?.status === "ok" && quiet.tier2?.spentUsd === 0 && quiet.tier2.capUsd === 0.25
                && /open questions today/i.test(quietHtml) && quietHtml.includes("nothing spent of the $0.25 daily cap"), { tier2: quiet?.tier2, quietHtml });

        await askSpend(new Date("2026-03-10T05:00:00Z"), 0.03);
        await askSpend(new Date("2026-03-10T17:00:00Z"), 0.0125, 3); // a model proposal (#157) logs at tier 3
        await askSpend(new Date("2026-03-10T17:30:00Z"), null, 1);    // tier 1 costs nothing
        await askSpend(new Date("2026-03-10T04:59:59Z"), 4);          // 23:59:59 CDT yesterday
        await askSpend(new Date("2026-03-11T05:00:00Z"), 6);          // midnight tomorrow
        const spent = await usageAt(usageNow);
        const spentHtml = tileHtml((await get(H.base, "/admin/os", adminToken)).body, "usage");
        check("the tile shows today's tier-2 spend and the cap: $0.0425 of $0.25, yesterday and tomorrow excluded",
            spent?.status === "ok" && Math.abs(spent.tier2?.spentUsd - 0.0425) < 1e-12 && spent.tier2.capUsd === 0.25
                && spentHtml.includes("$0.04 spent of the $0.25 daily cap") && !/budget reached/i.test(spentHtml), { tier2: spent?.tier2 });
        check("... and the week's run usage alongside it is unchanged", spent?.costUsd === 1.7525 && spent.runs === 4, spent);

        process.env.OS_ASK_DAILY_BUDGET_USD = "0.04";
        const budgetCapped = await usageAt(usageNow);
        const budgetCappedHtml = tileHtml((await get(H.base, "/admin/os", adminToken)).body, "usage");
        check("the cap comes from OS_ASK_DAILY_BUDGET_USD, and a spent budget is flagged as reached",
            budgetCapped?.tier2?.capUsd === 0.04 && budgetCappedHtml.includes("$0.04 spent of the $0.04 daily cap") && /budget reached/i.test(budgetCappedHtml),
            { tier2: budgetCapped?.tier2, budgetCappedHtml });
        delete process.env.OS_ASK_DAILY_BUDGET_USD;

        // A NaN cost in today's ask log: the tier-2 line says so; the week's run usage stays up.
        await askSpend(new Date("2026-03-10T18:00:00Z"), NaN);
        const nanAsk = await usageAt(usageNow);
        const nanAskHtml = tileHtml((await get(H.base, "/admin/os", adminToken)).body, "usage");
        check("a NaN tier-2 cost leaves the usage tile ok, with the spend unreadable and the reason",
            nanAsk?.status === "ok" && nanAsk.costUsd === 1.7525 && nanAsk.tier2?.spentUsd === null
                && nanAsk.tier2.capUsd === 0.25 && /isn't a number/.test(nanAsk.tier2.reason)
                && /spend unreadable/.test(nanAskHtml) && !/NaN/.test(nanAskHtml), { tier2: nanAsk?.tier2 });
        await pool.query(`DELETE FROM os_asks WHERE cost_usd = 'NaN'`);

        // The ask log not migrated: only the tier-2 line goes; the tile stays ok.
        await pool.query(`ALTER TABLE os_asks RENAME TO os_asks_t156_renamed`);
        asksRenamed = true;
        const noAsks = await usageAt(usageNow);
        const noAsksHtml = tileHtml((await get(H.base, "/admin/os", adminToken)).body, "usage");
        check("without the os_asks table the usage tile is still ok, with no tier-2 line",
            noAsks?.status === "ok" && noAsks.tier2 === null && noAsks.costUsd === 1.7525
                && !/open questions today/i.test(noAsksHtml) && noAsksHtml.includes("$1.75"), noAsks);
        await pool.query(`ALTER TABLE os_asks_t156_renamed RENAME TO os_asks`);
        asksRenamed = false;

        // ── Brief & runner tile (#142): the next brief and the latest one ────
        // The morning brief runs weekdays at 06:45 Central. In 2026, DST ends
        // Sun Nov 1 (06:45 is 11:45Z before, 12:45Z after) and starts Sun Mar 8.
        const briefAt = async (at: Date) => {
            clock = at;
            return (await get(H.base, "/admin/os/api/overview", adminToken)).json?.tiles?.brief;
        };
        const briefPage = async () => tileHtml((await get(H.base, "/admin/os", adminToken)).body, "brief");
        const nextRunCases: [string, string, string][] = [
            // [case, now, expected next run]
            ["Friday evening is followed by Monday 06:45", "2026-10-09T23:00:00Z", "2026-10-12T11:45:00.000Z"],
            ["Friday just after 06:45 is followed by Monday", "2026-10-09T11:46:00Z", "2026-10-12T11:45:00.000Z"],
            ["Saturday is followed by Monday", "2026-10-10T17:00:00Z", "2026-10-12T11:45:00.000Z"],
            ["late Sunday is followed by Monday", "2026-10-12T04:59:00Z", "2026-10-12T11:45:00.000Z"],
            ["Monday just before 06:45 is followed by today's 06:45", "2026-10-12T11:44:00Z", "2026-10-12T11:45:00.000Z"],
            ["Monday at 06:45 exactly is followed by Tuesday", "2026-10-12T11:45:00Z", "2026-10-13T11:45:00.000Z"],
            ["Monday just after 06:45 is followed by Tuesday", "2026-10-12T11:46:00Z", "2026-10-13T11:45:00.000Z"],
            ["Central midnight starts the new day, not UTC midnight", "2026-10-13T03:00:00Z", "2026-10-13T11:45:00.000Z"],
            ["across the fall-back weekend, Monday 06:45 is CST", "2026-10-30T23:00:00Z", "2026-11-02T12:45:00.000Z"],
            ["across the spring-forward weekend, Monday 06:45 is CDT", "2026-03-07T00:00:00Z", "2026-03-09T11:45:00.000Z"],
            ["on the fall-back Sunday itself, Monday 06:45 is CST", "2026-11-01T07:30:00Z", "2026-11-02T12:45:00.000Z"],
        ];
        for (const [name, at, expected] of nextRunCases) {
            const b = await briefAt(new Date(at));
            check(`next brief: ${name}`, b?.status === "ok" && b.nextRun === expected, { at, nextRun: b?.nextRun, expected });
        }
        const sched = await briefAt(new Date("2026-10-12T17:00:00Z"));
        check("the schedule is reported as data: weekdays at 06:45 America/Chicago",
            JSON.stringify(sched?.schedule) === JSON.stringify({ days: [1, 2, 3, 4, 5], at: "06:45", timeZone: "America/Chicago" }),
            sched?.schedule);

        // The latest brief: its date, status and unavailable sections.
        vault.clearBriefs();
        vault.writeBrief("2026-10-08", { generated: "2026-10-08T06:47-05:00", run: "scheduled", status: "ok", failed: "[]" });
        vault.writeBrief("2026-10-09", {
            generated: "2026-10-09T06:52-05:00", run: "scheduled", status: "partial", failed: "[trading.account, email]",
        });
        const sat = await briefAt(new Date("2026-10-10T15:00:00Z"));
        check("the latest brief is the newest: its date, status and unavailable sections",
            sat?.latest?.date === "2026-10-09" && sat.latest.status === "partial"
                && JSON.stringify(sat.latest.failed) === JSON.stringify(["trading.account", "email"])
                && sat.latest.run === "scheduled" && sat.latest.generated === "2026-10-09T06:52-05:00", sat?.latest);
        check("a weekend day with no brief is not flagged", sat?.missingToday === false && sat.dueToday === null, sat);
        const satPage = await get(H.base, "/admin/os", adminToken);
        const satHtml = tileHtml(satPage.body, "brief");
        check("the tile shows the latest brief's date, its partial status and the unavailable sections, and links to /admin/briefs",
            tileTag(satPage.body, "brief")?.status === "ok" && satHtml.includes("Oct 9") && /partial/.test(satHtml)
                && satHtml.includes("trading.account") && satHtml.includes("email")
                && /href="\/admin\/briefs\?token=/.test(satHtml) && /Mon 6:45 AM/.test(satHtml) && /Mon, Oct 12 · runs weekdays at 6:45 AM CT/.test(satHtml), satHtml);
        const sun = await briefAt(new Date("2026-10-11T18:00:00Z"));
        check("Sunday with no brief is not flagged either", sun?.missingToday === false, sun);

        // Monday with no brief yet: not before 06:45, flagged from 06:45.
        const monEarly = await briefAt(new Date("2026-10-12T11:44:00Z"));
        check("a weekday with no brief yet is not flagged before 06:45",
            monEarly?.missingToday === false && monEarly.dueToday === "2026-10-12T11:45:00.000Z", monEarly);
        const monEarlyHtml = await briefPage();
        check("...and the tile shows no missing-brief flag", !/data-flag="brief-missing"/.test(monEarlyHtml), monEarlyHtml);
        const monLate = await briefAt(new Date("2026-10-12T12:30:00Z"));
        check("a weekday with no brief after 06:45 is flagged, with the time it was due",
            monLate?.missingToday === true && monLate.dueToday === "2026-10-12T11:45:00.000Z" && monLate.today === "2026-10-12"
                && monLate.latest?.date === "2026-10-09", monLate);
        const monLateHtml = await briefPage();
        const flag = monLateHtml.match(/<div[^>]*data-flag="brief-missing"[^>]*>[\s\S]*?<\/div>/)?.[0] ?? "";
        check("...and the tile flags it as a prompt to look, not a failure",
            /6:45 AM CT/.test(flag) && /worth a look/i.test(flag) && !/fail/i.test(flag), monLateHtml);
        // At 23:00 Central on Monday it's already Tuesday in UTC; Monday's brief is still the one due.
        const monNight = await briefAt(new Date("2026-10-13T04:00:00Z"));
        check("late Monday evening (Tuesday in UTC) still flags Monday's missing brief",
            monNight?.missingToday === true && monNight.today === "2026-10-12", monNight);

        vault.writeBrief("2026-10-12", { generated: "2026-10-12T06:49-05:00", run: "scheduled", status: "ok", failed: "[]" });
        const monDone = await briefAt(new Date("2026-10-12T12:30:00Z"));
        check("once today's brief is in, nothing is flagged and it is the latest",
            monDone?.missingToday === false && monDone.latest?.date === "2026-10-12" && monDone.latest.status === "ok"
                && monDone.latest.failed?.length === 0, monDone);
        const monDoneHtml = await briefPage();
        check("...and the tile shows today's brief as ok, with no flag",
            !/data-flag="brief-missing"/.test(monDoneHtml) && /data-brief-status="ok"/.test(monDoneHtml), monDoneHtml);

        // No brief at all: the tile stays ok with the next run, and says why there's no brief.
        vault.clearBriefs();
        const none = await briefAt(new Date("2026-10-12T12:30:00Z"));
        check("with no briefs at all the tile is still ok, with the next run, no latest brief and a note",
            none?.status === "ok" && none.nextRun === "2026-10-13T11:45:00.000Z" && none.latest === null
                && /no briefs yet/i.test(none.latestNote ?? "") && none.missingToday === true, none);
        const noneHtml = await briefPage();
        check("...and the tile says there are no briefs yet, and still flags today's",
            /no briefs yet/i.test(noneHtml) && /data-flag="brief-missing"/.test(noneHtml), noneHtml);

        delete process.env.OBSIDIAN_VAULT_PATH;
        const unset = await briefAt(new Date("2026-10-12T12:30:00Z"));
        const unsetHtml = await briefPage();
        check("with OBSIDIAN_VAULT_PATH unset the tile stays ok, names the variable, and flags nothing it can't know",
            unset?.status === "ok" && unset.nextRun === "2026-10-13T11:45:00.000Z" && unset.latest === null
                && /OBSIDIAN_VAULT_PATH/.test(unset.latestNote ?? "") && unset.missingToday === false
                && /OBSIDIAN_VAULT_PATH/.test(unsetHtml) && !/data-flag="brief-missing"/.test(unsetHtml), unset);
        process.env.OBSIDIAN_VAULT_PATH = `${vault.dir}-t142-missing`;
        const gone = await briefAt(new Date("2026-10-12T12:30:00Z"));
        check("with the vault checkout missing the tile stays ok and says the checkout isn't there",
            gone?.status === "ok" && gone.latest === null && /vault checkout/i.test(gone.latestNote ?? "")
                && gone.missingToday === false, gone);
        process.env.OBSIDIAN_VAULT_PATH = vault.dir;
        vault.writeBrief("2026-10-12", { generated: "2026-10-12T06:49-05:00", run: "scheduled", status: "ok", failed: "[]" });

        // ── Tasks tile (#141) ───────────────────────────────────────────────
        // Mid-October is CDT (UTC-5): Central midnight starting Tue Oct 13 is
        // 05:00Z. Notion date-only due dates arrive as UTC midnight of that
        // date, and count on that date, not on the Central evening before.
        const tasksAt = async (at: Date) => {
            clock = at;
            return (await get(H.base, "/admin/os/api/overview", adminToken)).json?.tiles?.tasks;
        };
        const tasksPage = async () => {
            const page = await get(H.base, "/admin/os", adminToken);
            return { tag: tileTag(page.body, "tasks"), html: tileHtml(page.body, "tasks") };
        };
        const notionId = () => crypto.randomUUID();
        const task = async (title: string, due: string | null,
            opts: { status?: string; notion?: string | null; synced?: Date | null } = {}) => {
            const notion = opts.notion === undefined ? notionId() : opts.notion;
            const { rows: [r] } = await pool.query(
                `INSERT INTO tasks (title, status, due_date, notion_page_id, notion_last_synced)
                 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
                [`t141 ${title}`, opts.status ?? "Not Started", due, notion,
                    opts.synced === undefined ? (notion ? taskSync : null) : opts.synced]);
            return { id: r.id as string, notion };
        };
        const ids = (list: any[] | undefined) => (list ?? []).map((t) => t.id);
        // The tests own this throwaway table.
        await pool.query(`DELETE FROM tasks`);

        // Empty: a fresh sync with nothing due (only a completed task) is a good state.
        const lastNight = new Date("2026-10-13T04:50:00Z");
        let taskSync: Date | null = lastNight;
        await task("done today", "2026-10-13T15:00:00Z", { status: "Completed" });
        const emptyTasks = await tasksAt(new Date("2026-10-13T05:00:00Z"));
        check("with nothing due the tasks tile is ok, with zero counts, no rows and a fresh sync",
            emptyTasks?.status === "ok" && emptyTasks.counts?.overdue === 0 && emptyTasks.counts.today === 0
                && emptyTasks.counts.tomorrow === 0 && emptyTasks.counts.total === 0 && emptyTasks.tasks?.length === 0
                && emptyTasks.more === 0 && emptyTasks.stale === false && emptyTasks.lastSync === lastNight.toISOString(),
            emptyTasks);
        const emptyTasksHtml = await tasksPage();
        check("...and the tile shows 'Nothing due' as a good state, linking to the tasks table",
            emptyTasksHtml.tag?.status === "ok" && emptyTasksHtml.tag.stale === "false"
                && /data-tasks-state="clear"/.test(emptyTasksHtml.html) && /Nothing due/.test(emptyTasksHtml.html)
                && /href="\/db\/tasks\?token=/.test(emptyTasksHtml.html), emptyTasksHtml);

        // The buckets, either side of Central midnight.
        const overdueOld = await task("overdue Sat", "2026-10-10T15:00:00Z");     // Sat 10:00 CDT
        const monLateTask = await task("Mon 23:30", "2026-10-13T04:30:00Z");      // Mon 23:30 CDT
        const tueEarly = await task("Tue 00:30", "2026-10-13T05:30:00Z");         // Tue 00:30 CDT
        const tueDateOnly = await task("Tue (date only)", "2026-10-13T00:00:00Z"); // Notion "2026-10-13"
        const tueLate = await task("Tue 23:59", "2026-10-14T04:59:00Z");          // Tue 23:59 CDT
        const wedEarly = await task("Wed 00:00", "2026-10-14T05:00:00Z", { status: "In Progress" });
        const wedLate = await task("Wed 23:59", "2026-10-15T04:59:00Z");
        const thu = await task("Thu 00:00", "2026-10-15T05:00:00Z");
        const thuDateOnly = await task("Thu (date only)", "2026-10-15T00:00:00Z");
        // Excluded: completed, not from Notion (null or blank page id), no due date.
        const completed = await task("completed Tue", "2026-10-13T15:00:00Z", { status: "Completed" });
        const local = await task("local Tue", "2026-10-13T15:00:00Z", { notion: null, synced: new Date("2026-10-13T05:30:00Z") });
        const blank = await task("blank notion Tue", "2026-10-13T15:00:00Z", { notion: "  " });
        const undated = await task("no due date", null);

        const mon = await tasksAt(new Date("2026-10-13T04:59:00Z")); // Mon 23:59 CDT
        check("just before Central midnight: today is Monday and tomorrow Tuesday",
            mon?.status === "ok" && mon.today === "2026-10-12" && mon.tomorrow === "2026-10-13", mon);
        check("...the buckets are 1 overdue, 1 today, 3 tomorrow (the date-only Tuesday task is tomorrow, not today)",
            mon?.counts?.overdue === 1 && mon.counts.today === 1 && mon.counts.tomorrow === 3 && mon.counts.total === 5
                && JSON.stringify(ids(mon.tasks)) === JSON.stringify([overdueOld.id, monLateTask.id, tueDateOnly.id, tueEarly.id, tueLate.id]),
            { counts: mon?.counts, tasks: mon?.tasks?.map((t: any) => `${t.bucket} ${t.title}`) });
        check("...and each row carries its bucket, Central due day and date-only flag",
            mon?.tasks?.[0]?.bucket === "overdue" && mon.tasks[0].dueDay === "2026-10-10" && mon.tasks[0].dateOnly === false
                && mon.tasks[2].bucket === "tomorrow" && mon.tasks[2].dueDay === "2026-10-13" && mon.tasks[2].dateOnly === true
                && mon.tasks[2].due === "2026-10-13T00:00:00.000Z", mon?.tasks);

        const tue = await tasksAt(new Date("2026-10-13T05:00:00Z")); // Tue 00:00 CDT
        check("at Central midnight: today is Tuesday; Monday 23:30 is now overdue; Wednesday is tomorrow; Thursday is out",
            tue?.today === "2026-10-13" && tue.tomorrow === "2026-10-14"
                && tue.counts?.overdue === 2 && tue.counts.today === 3 && tue.counts.tomorrow === 2 && tue.counts.total === 7
                && JSON.stringify(ids(tue.tasks)) === JSON.stringify(
                    [overdueOld.id, monLateTask.id, tueDateOnly.id, tueEarly.id, tueLate.id, wedEarly.id, wedLate.id])
                && JSON.stringify(tue.tasks.map((t: any) => t.bucket)) === JSON.stringify(
                    ["overdue", "overdue", "today", "today", "today", "tomorrow", "tomorrow"]),
            { counts: tue?.counts, tasks: tue?.tasks?.map((t: any) => `${t.bucket} ${t.title}`) });
        const shownIds = ids(tue?.tasks);
        check("completed, non-Notion, blank-id and undated tasks are excluded",
            ![completed, local, blank, undated, thu, thuDateOnly].some((t) => shownIds.includes(t.id)), tue?.tasks);
        check("each row has its title, status and a link to its Notion page",
            tue?.tasks?.[5]?.title === "t141 Wed 00:00" && tue.tasks[5].status === "In Progress"
                && tue.tasks[5].notionPageId === wedEarly.notion
                && tue.tasks[5].url === `https://www.notion.so/${wedEarly.notion!.replace(/-/g, "")}`, tue?.tasks?.[5]);
        check("seven due is exactly the cap: nothing more", tue?.tasks?.length === 7 && tue.more === 0, tue?.more);
        const tueHtml = await tasksPage();
        const counts = tueHtml.html.match(/<div[^>]*data-tasks-counts[^>]*>[\s\S]*?<\/div>/)?.[0] ?? "";
        check("the tile is ok, leads with the overdue / today / tomorrow counts, and marks overdue rows",
            tueHtml.tag?.status === "ok" && /2[^<]*<\/[a-z]+>\s*overdue/.test(counts) && /3[^<]*<\/[a-z]+>\s*today/.test(counts)
                && /2[^<]*<\/[a-z]+>\s*tomorrow/.test(counts)
                && (tueHtml.html.match(/data-bucket="overdue"/g) ?? []).length === 2 && /OVERDUE/.test(tueHtml.html)
                && !/data-tasks-state="clear"/.test(tueHtml.html), counts || tueHtml.html);
        check("each title links to its Notion page in a new tab",
            tueHtml.html.includes(`href="https://www.notion.so/${wedEarly.notion!.replace(/-/g, "")}"`)
                && /target="_blank" rel="noopener noreferrer"/.test(tueHtml.html), tueHtml.html);

        // The tail of the week: by Wednesday the two Thursday tasks (timed and date-only) are
        // tomorrow, and everything due Monday and Tuesday is overdue.
        const wed = await tasksAt(new Date("2026-10-14T17:00:00Z"));
        check("by Wednesday the Thursday tasks (timed and date-only) are tomorrow; Monday and Tuesday are overdue",
            wed?.today === "2026-10-14" && wed.counts?.overdue === 5 && wed.counts.today === 2 && wed.counts.tomorrow === 2,
            wed?.counts);

        // Over the cap: three more overdue tasks lead; the list stops at 7 with "+3 more".
        const lateA = await task("overdue Fri A", "2026-10-09T14:00:00Z");
        const lateB = await task("overdue Fri B", "2026-10-09T15:00:00Z");
        const lateC = await task("<b>overdue</b> Sun", "2026-10-11T00:00:00Z"); // date-only Sun Oct 11
        const capped = await tasksAt(new Date("2026-10-13T05:00:00Z"));
        check("over the cap: 7 shown, overdue first, '+3 more', and the counts cover all 10",
            capped?.tasks?.length === 7 && capped.more === 3
                && capped.counts?.overdue === 5 && capped.counts.today === 3 && capped.counts.tomorrow === 2 && capped.counts.total === 10
                && JSON.stringify(ids(capped.tasks)) === JSON.stringify(
                    [lateA.id, lateB.id, overdueOld.id, lateC.id, monLateTask.id, tueDateOnly.id, tueEarly.id]),
            { counts: capped?.counts, more: capped?.more, tasks: capped?.tasks?.map((t: any) => `${t.bucket} ${t.title}`) });
        const cappedHtml = await tasksPage();
        check("...and the tile shows 7 rows and '+3 more', with titles escaped",
            (cappedHtml.html.match(/<li\b/g) ?? []).length === 7 && /\+3 more/.test(cappedHtml.html)
                && cappedHtml.html.includes("&lt;b&gt;overdue&lt;/b&gt;") && !cappedHtml.html.includes("<b>overdue</b>"),
            cappedHtml.html);

        // A page id that isn't a Notion id gets no link, rather than a broken one.
        await pool.query(`UPDATE tasks SET notion_page_id = 'javascript:alert(1)' WHERE id = $1`, [lateA.id]);
        const oddId = await tasksAt(new Date("2026-10-13T05:00:00Z"));
        const oddHtml = await tasksPage();
        check("a page id that isn't a Notion id is still listed, with no link",
            oddId?.tasks?.[0]?.id === lateA.id && oddId.tasks[0].url === null && !/javascript:/.test(oddHtml.html), oddId?.tasks?.[0]);

        // Sync staleness: the newest notion_last_synced of the Notion tasks, stale after an hour.
        // The non-Notion row's newer notion_last_synced (05:30Z) doesn't count.
        const syncedAt = await tasksAt(new Date(lastNight.getTime() + 60 * MIN));
        const syncedLate = await tasksAt(new Date(lastNight.getTime() + 60 * MIN + 1000));
        check("the last sync is the newest Notion task's; exactly an hour old is not stale, a second later it is",
            syncedAt?.lastSync === lastNight.toISOString() && syncedAt.stale === false && syncedAt.syncAgeMs === 60 * MIN
                && syncedLate?.stale === true, { at: syncedAt?.stale, late: syncedLate?.stale, lastSync: syncedAt?.lastSync });
        const staleTasksHtml = await tasksPage();
        check("the stale tasks tile is flagged in the HTML, with the last sync time in Central",
            staleTasksHtml.tag?.status === "ok" && staleTasksHtml.tag.stale === "true" && /STALE/.test(staleTasksHtml.html)
                && /synced[^<]*11:50 PM CT/.test(staleTasksHtml.html), staleTasksHtml.tag);
        const newer = new Date("2026-10-13T05:55:00Z");
        await pool.query(`UPDATE tasks SET notion_last_synced = $1 WHERE id = $2`, [newer, thu.id]);
        const resynced = await tasksAt(new Date("2026-10-13T06:00:00Z"));
        check("a newer sync on any Notion task (even one not shown) clears the flag",
            resynced?.lastSync === newer.toISOString() && resynced.stale === false, resynced);

        // Never synced: no Notion task has a sync time.
        await pool.query(`UPDATE tasks SET notion_last_synced = NULL`);
        const never = await tasksAt(new Date("2026-10-13T06:00:00Z"));
        const neverHtml = await tasksPage();
        check("with no sync time at all the tile is ok but stale, and says it has never synced",
            never?.status === "ok" && never.lastSync === null && never.syncAgeMs === null && never.stale === true
                && neverHtml.tag?.stale === "true" && /never synced/i.test(neverHtml.html), never);

        // DST: tomorrow ends at Central midnight, not 48 hours after today began. On
        // Sat Oct 31, tomorrow (Sun Nov 1) is 25 hours long and ends at Nov 2 06:00Z.
        await pool.query(`DELETE FROM tasks`);
        taskSync = new Date("2026-11-01T04:30:00Z");
        const sunLate = await task("Sun 23:30 CST", "2026-11-02T05:30:00Z");
        const monFirst = await task("Mon 00:00 CST", "2026-11-02T06:00:00Z");
        const dst = await tasksAt(new Date("2026-11-01T04:59:00Z")); // Sat Oct 31 23:59 CDT
        check("across the fall-back weekend, Sunday 23:30 CST is tomorrow and Monday 00:00 CST is not",
            dst?.today === "2026-10-31" && dst.tomorrow === "2026-11-01" && dst.counts?.tomorrow === 1
                && ids(dst.tasks).includes(sunLate.id) && !ids(dst.tasks).includes(monFirst.id), dst);

        // Leave nothing due and a fresh sync, so the no-external-calls case sees every tile ok.
        await pool.query(`DELETE FROM tasks`);

        // ── degradation ─────────────────────────────────────────────────────
        clock = new Date(latest.getTime() + 5 * MIN);

        await pool.query(`ALTER TABLE alpaca_snapshots RENAME TO alpaca_snapshots_t139_renamed`);
        renamed = true;
        const broken = await get(D.base, "/admin/os/api/overview", adminToken);
        const bt = broken.json?.tiles ?? {};
        check("a renamed table makes only the Alpaca tile unavailable, naming the table, and the JSON is still 200",
            broken.status === 200 && bt.alpaca?.status === "unavailable" && /alpaca_snapshots/.test(bt.alpaca.reason)
                && bt.canary?.status === "ok" && bt.canary.accounts >= 2 && bt.usage?.status === "ok"
                && bt.brief?.status === "ok" && bt.tasks?.status === "ok",
            { status: broken.status, bt });
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
        if (usageRenamed) await pool.query(`ALTER TABLE agent_runs RENAME COLUMN cost_usd_t144_renamed TO cost_usd`).catch(() => {});
        if (asksRenamed) await pool.query(`ALTER TABLE os_asks_t156_renamed RENAME TO os_asks`).catch(() => {});
        delete process.env.OS_ASK_DAILY_BUDGET_USD;
        await pool.query(`DELETE FROM alpaca_snapshots`).catch(() => {});
        await pool.query(`DELETE FROM tasks`).catch(() => {});
        await pool.query(`DELETE FROM agent_runs WHERE runner = $1`, [`t144-${tag}`]).catch(() => {});
        for (const id of created) await pool.query(`DELETE FROM accounts WHERE id = $1`, [id]);
        P.server.close(); H.server.close(); D.server.close();
        vault.remove();
    }

    console.log(`\n  ${pass} passed, ${fail} failed\n`);
    await pool.end();
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
