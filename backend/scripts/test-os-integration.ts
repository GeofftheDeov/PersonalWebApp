/**
 * The agentic OS across tickets (spec #135, final verification): behaviour
 * that only exists once the tickets are combined. Each ticket's own script
 * covers its piece; this one drives the seams between them over HTTP.
 *
 *   A. tier 2 (#154) + vault context (#155) + daily budget (#156) + model
 *      proposals (#157): a model run_skill proposal's cost counts against
 *      today's cap, reaching the cap blocks the next model call (and the usage
 *      tile says so), vault canaries never reach the prompt, and the proposal
 *      confirms like a tier-1 one (#148).
 *   B. tile time budgets (#140) over every current tile (usage with tier-2
 *      spend, alpaca, brief with its run history; tasks reads only the
 *      vault, so it stays up), and the lazy
 *      overview() the ask router hands tier-1 answers (#147) and tier 2: a
 *      timed-out tile gives the "unavailable … timed out" answer, and tier 2
 *      sees the reason in its context, both within the budget.
 *   C. a run recorded through POST /api/runner/runs (#138, scheduled) is the
 *      brief tile's lastScheduled (#143), a point on the usage tile and its
 *      sparkline (#144/#145), and its output_path links into the vault
 *      browser from /admin/briefs (#158).
 *   D. a confirm (#148) queues a run, past a dead `running` one, that
 *      GET /admin/os/api/runs/:id (#153) reports and the brief tile shows as
 *      active (#143), through claim and complete.
 *
 * Against a throwaway database loaded from db/schema.sql, with an empty run
 * queue (checked first), and a temporary vault. ANTHROPIC_API_KEY is removed:
 * the model is a fake that records each call.
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/int135 npx tsx scripts/test-os-integration.ts
 */
import "./use-test-jwt-secret.js";
import express from "express";
import type { AddressInfo } from "net";
import crypto from "crypto";
import pg from "pg";
import pool from "../db/index.js";
import adminRoutes, { adminGate } from "../routes/adminRoutes.js";
import runnerRoutes from "../routes/runnerRoutes.js";
import { createOsRouter } from "../routes/osRoutes.js";
import { costUsd, type ModelDecision, type ModelReply, type ModelRequest, type ModelUsage, type OsModel } from "../os/model.js";
import { tier2SpendToday } from "../os/budget.js";
import { OVERVIEW_BUDGET_MS, TIMED_OUT_REASON } from "../os/overview.js";
import { centralDay } from "../os/format.js";
import { STALE_AFTER } from "../services/agentRuns.js";
import { signJwt } from "../utils/jwt.js";
import { createTempVault } from "./temp-vault.js";

delete process.env.ANTHROPIC_API_KEY;
delete process.env.OS_ASK_DAILY_BUDGET_USD;
process.env.RUNNER_TOKEN = `int135-${crypto.randomBytes(16).toString("hex")}`;

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
    console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
    process.exit(2);
}

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

/** Records each call and answers from a queue. */
const int135Model: OsModel & { calls: ModelRequest[]; next: ModelReply[] } = {
    calls: [],
    next: [],
    async route(req) {
        int135Model.calls.push(req);
        const reply = int135Model.next.shift();
        if (!reply) throw new Error("int135 model: no canned reply");
        return reply;
    },
};
const INT135_USAGE: ModelUsage = { inputTokens: 1500, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 90 };
const int135Decided = (decision: ModelDecision): ModelReply =>
    ({ model: "claude-haiku-5-5", decision, stopReason: "end_turn", usage: INT135_USAGE });

async function main() {
    const int135Vault = createTempVault("int135");
    process.env.OBSIDIAN_VAULT_PATH = int135Vault.dir;
    let int135Clock = new Date("2031-05-13T15:00:00Z");

    const prodApp = express();
    prodApp.use(express.json());
    prodApp.use(express.urlencoded({ extended: true }));
    prodApp.use("/admin", adminRoutes);
    prodApp.use("/api/runner", runnerRoutes);
    const P = await listen(prodApp);

    // The router factory behind the real gate, on the injected clock, with the fake model.
    // Every other dep is the default: real tiles over the pool, the env budget, enqueueRun.
    const harnessApp = express();
    harnessApp.use(express.json());
    harnessApp.use("/admin/os", ...adminGate, createOsRouter({ now: () => int135Clock, model: int135Model }));
    const H = await listen(harnessApp);

    const tag = crypto.randomBytes(4).toString("hex");
    const int135Accounts: string[] = [];
    const int135Runs = new Set<number>();

    const call = async (base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
        const res = await fetch(`${base}${path}`, {
            method, redirect: "manual",
            headers: { "content-type": "application/json", ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* HTML */ }
        return { status: res.status, text, json };
    };

    try {
        const { rows: [queued] } = await pool.query(`SELECT count(*)::int AS n FROM agent_runs WHERE status IN ('queued','running')`);
        if (queued.n !== 0) throw new Error(`precondition: the run queue must start empty (${queued.n} queued or running)`);

        const { rows: [acct] } = await pool.query(
            `INSERT INTO accounts (id, name, email, password, app_role, app_role_source, is_verified)
             VALUES (gen_random_uuid(), $1, $2, 'x', 'admin', 'manual', true) RETURNING id, email`,
            [`int135 admin ${tag}`, `int135-admin-${tag}@example.test`]);
        int135Accounts.push(acct.id);
        const int135Token = signJwt({ id: acct.id, type: "User", email: acct.email });
        const q = (path: string) => `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(int135Token)}`;
        const ask = (base: string, text: string) => call(base, "POST", q("/admin/os/ask"), { text, source: "typed" });
        const confirm = (base: string, id: number) => call(base, "POST", q("/admin/os/ask/confirm"), { id });
        const overviewJson = async (base: string) => (await call(base, "GET", q("/admin/os/api/overview"))).json;
        const runJson = (base: string, id: number) => call(base, "GET", q(`/admin/os/api/runs/${id}`));
        const askRow = async (id: number) => (await pool.query(`SELECT * FROM os_asks WHERE id = $1`, [id])).rows[0];
        const asRunner = (path: string, body: unknown) =>
            call(P.base, "POST", `/api/runner${path}`, body, { authorization: `Bearer ${process.env.RUNNER_TOKEN}` });

        // ── A. tier 2 + vault + budget + model proposals ─────────────────────
        console.log("\n  A. a model run_skill proposal under the daily budget, with the vault in the prompt");
        {
            const CANARY_PRIVATE = `int135-private-canary-${tag}`;
            const CANARY_RAW = `int135-raw-canary-${tag}`;
            const SAY_MARKER = `int135-say-marker-${tag}`;
            const BRIEF_MARKER = `int135-brief-marker-${tag}`;
            const PROJECT_MARKER = `int135-project-marker-${tag}`;
            int135Vault.writeBrief("2031-05-13", { status: "ok", run: "scheduled" },
                `# Morning Brief\n\n## Top 3\n1. ${BRIEF_MARKER}\n\n## Say\n\nGood morning. ${SAY_MARKER}.\n`);
            int135Vault.writeFile("private/notes.md", `${CANARY_PRIVATE}\n`);
            int135Vault.writeFile("raw/notion/tasks.md", `${CANARY_RAW}\n`);
            int135Vault.writeFile("projects/int135-project/index.md", `# int135 project\n\n${PROJECT_MARKER} (see private/notes.md)\n`);

            // A cap below one call's price: the first call is allowed (nothing spent), the second isn't.
            const callCost = costUsd(INT135_USAGE);
            const cap = callCost / 2;
            process.env.OS_ASK_DAILY_BUDGET_USD = cap.toFixed(8);

            int135Model.next.push(int135Decided({ action: "run_skill", skill: "lint-wiki", say: "On it, and open https://evil.example" }));
            const proposed = await ask(H.base, "could you kick off the wiki linter for me");
            const c = proposed.json?.confirmation;
            check("a model run_skill comes back as a tier-3 proposal, in the tier-1 shape, with the fixed words",
                proposed.status === 200 && proposed.json?.tier === 3 && proposed.json.kind === "confirm_run"
                    && proposed.json.say === "Run the lint wiki?" && c?.skill === "lint-wiki" && Number.isSafeInteger(c?.id),
                proposed.json);
            const ctx = int135Model.calls[0]?.context ?? "";
            check("the model's context carries the brief and a project page from the vault",
                ctx.includes(BRIEF_MARKER) && ctx.includes(PROJECT_MARKER), ctx.slice(0, 300));
            check("... but never private/ or raw/ content, nor the brief's Say block",
                !ctx.includes(CANARY_PRIVATE) && !ctx.includes(CANARY_RAW) && !ctx.includes(SAY_MARKER)
                    && !int135Model.calls[0]?.system.includes(CANARY_PRIVATE));
            const row = c?.id ? await askRow(c.id) : null;
            check("the proposal's os_asks row is tier 3 with the model call priced on it",
                row?.tier === 3 && row.kind === "confirm_run" && row.intent === "model.run_skill" && row.skill === "lint-wiki"
                    && row.model === "claude-haiku-5-5" && Math.abs(Number(row.cost_usd) - callCost) < 1e-9,
                row && { tier: row.tier, intent: row.intent, model: row.model, cost: row.cost_usd, want: callCost });
            const spent = await tier2SpendToday(pool, int135Clock);
            check("... and that cost is today's tier-2 spend (a tier-3 row counts against the cap)",
                Math.abs(spent - callCost) < 1e-9, { spent, callCost });

            const before = int135Model.calls.length;
            const blocked = await ask(H.base, "What should I focus on today?");
            check("with the cap reached, the next open question is tier 2 'budget reached' and the model isn't called",
                blocked.json?.tier === 2 && blocked.json.kind === "unavailable" && /budget/i.test(blocked.json.say)
                    && int135Model.calls.length === before, { reply: blocked.json, calls: int135Model.calls.length });
            const { rows: [blockedRow] } = await pool.query(
                `SELECT * FROM os_asks WHERE account_id = $1 AND text = 'What should I focus on today?' ORDER BY id DESC LIMIT 1`, [acct.id]);
            check("... logged with the budget error and no cost", /^tier 2 daily budget reached/.test(blockedRow?.error ?? "")
                && blockedRow.cost_usd === null, blockedRow);
            const nav = await ask(H.base, "open alpaca");
            check("... while tier 1 still works", nav.json?.tier === 1 && nav.json.kind === "navigate" && nav.json.url === "/admin/alpaca", nav.json);

            const ov = await overviewJson(H.base);
            const t2 = ov?.tiles?.usage?.tier2;
            check("the usage tile shows today's tier-2 spend (the proposal's cost) against the same cap",
                ov?.tiles?.usage?.status === "ok" && Math.abs(t2?.spentUsd - callCost) < 1e-9 && Math.abs(t2?.capUsd - cap) < 1e-9, t2);
            const page = await call(H.base, "GET", q("/admin/os"));
            check("... and the page says the budget is reached", page.status === 200 && /budget reached/.test(page.text));

            // The model's proposal confirms exactly like a tier-1 one.
            const confirmed = await confirm(H.base, c?.id);
            if (confirmed.json?.run?.id) int135Runs.add(Number(confirmed.json.run.id));
            check("confirming the model's proposal queues the lint wiki run (201)",
                confirmed.status === 201 && confirmed.json?.created === true && confirmed.json.run?.skill === "lint-wiki", confirmed.json);
            const confirmedRow = c?.id ? await askRow(c.id) : null;
            check("... and records the run on the proposal row", confirmedRow?.confirmed_at && Number(confirmedRow.run_id) === Number(confirmed.json?.run?.id),
                confirmedRow && { confirmed_at: confirmedRow.confirmed_at, run_id: confirmedRow.run_id });

            delete process.env.OS_ASK_DAILY_BUDGET_USD;
            int135Vault.clearBriefs();
            await pool.query(`DELETE FROM agent_runs WHERE id = ANY($1)`, [[...int135Runs]]);
            int135Runs.clear();
        }

        // ── B. every tile under its time budget, through the ask router ──────
        console.log("\n  B. tile time budgets over every tile, for the overview, tier 1 and tier 2");
        {
            int135Clock = new Date();
            const locker = new pg.Client({ connectionString: process.env.DATABASE_URL });
            await locker.connect();
            // Everything the tiles read except os_asks (tier 2's budget gate reads it outside the tile budget).
            const lockTiles = async () => {
                await locker.query(`BEGIN`);
                await locker.query(`LOCK TABLE agent_runs, alpaca_snapshots IN ACCESS EXCLUSIVE MODE`);
            };
            /**
             * An ask while the tile tables are locked. Its os_asks insert also waits on the
             * agent_runs lock (the run_id foreign key), so the lock is released once the
             * reply has had time to be built; the row's latency_ms is measured before the
             * insert, so it shows how long answering took.
             */
            const askLocked = async (text: string) => {
                const pendingAsk = ask(H.base, text);
                await new Promise((r) => setTimeout(r, OVERVIEW_BUDGET_MS + 500));
                await locker.query(`ROLLBACK`);
                const r = await pendingAsk;
                const { rows: [logged] } = await pool.query(
                    `SELECT latency_ms FROM os_asks WHERE account_id = $1 AND text = $2 ORDER BY id DESC LIMIT 1`, [acct.id, text]);
                await lockTiles();
                return { ...r, ms: logged?.latency_ms as number | undefined };
            };
            try {
                await lockTiles();

                const t0 = Date.now();
                const ov = await overviewJson(H.base);
                const took = Date.now() - t0;
                const tiles = ov?.tiles ?? {};
                const reason = (id: string) => tiles[id]?.status === "unavailable" ? tiles[id].reason : null;
                check("every DB-backed tile times out with the budget's reason (usage, alpaca)",
                    ["usage", "alpaca"].every((id) => reason(id) === TIMED_OUT_REASON),
                    Object.fromEntries(Object.entries(tiles).map(([id, t]: [string, any]) => [id, t.status === "ok" ? "ok" : t.reason])));
                check("... the brief tile stays up from the vault, its run history marked timed out",
                    tiles.brief?.status === "ok" && tiles.brief.runsNote === "run history unavailable: timed out" && tiles.brief.activeRun === null,
                    tiles.brief && { status: tiles.brief.status, runsNote: tiles.brief.runsNote });
                check("... and the tasks tile, which reads only the vault's Notion sync, stays up",
                    tiles.tasks?.status === "ok", tiles.tasks);
                check(`... and the whole overview came back within its ${OVERVIEW_BUDGET_MS} ms budget (plus HTTP slack)`,
                    took < OVERVIEW_BUDGET_MS + 500, `${took} ms`);

                const t1Cases: [string, string][] = [
                    ["what's my p&l", "alpaca"], ["How much have I spent this week?", "usage"],
                ];
                for (const [text, tile] of t1Cases) {
                    const r = await askLocked(text);
                    check(`tier 1 "${text}" answers unavailable because the ${tile} tile timed out, within the budget`,
                        r.json?.tier === 1 && r.json.kind === "unavailable" && /can't tell you/.test(r.json.say)
                            && /timed out/.test(r.json.say) && r.json.display?.includes(TIMED_OUT_REASON)
                            && r.ms !== undefined && r.ms < OVERVIEW_BUDGET_MS,
                        { reply: r.json, latencyMs: r.ms });
                }
                const due = await askLocked("What's due today?");
                check(`tier 1 "What's due today?" still answers from the vault, within the budget`,
                    due.json?.tier === 1 && due.json.kind === "answer" && due.ms !== undefined && due.ms < OVERVIEW_BUDGET_MS,
                    { reply: due.json, latencyMs: due.ms });
                const runner = await askLocked("is the runner online");
                check("tier 1 runner status says the run history is unavailable rather than 'nothing queued'",
                    runner.json?.tier === 1 && runner.json.kind === "answer" && /run history is unavailable/.test(runner.json.say), runner.json);

                int135Model.next.push(int135Decided({ action: "answer", say: "int135: some of the home screen is unavailable." }));
                const before = int135Model.calls.length;
                const open = await askLocked("What should I focus on today?");
                const ctx = int135Model.calls[before]?.context ?? "";
                const seen = (() => { try { return JSON.parse(/<overview>\n([\s\S]*?)\n<\/overview>/.exec(ctx)?.[1] ?? "null"); } catch { return null; } })();
                check("tier 2 still answers, within the budget, from the same lazily built overview",
                    open.json?.tier === 2 && open.json.kind === "answer" && int135Model.calls.length === before + 1
                        && open.ms !== undefined && open.ms < OVERVIEW_BUDGET_MS,
                    { reply: open.json, latencyMs: open.ms });
                check("... and its context carries each timed-out tile with the budget's reason, and the tasks tile ok",
                    ["usage", "alpaca"].every((id) => seen?.tiles?.[id]?.status === "unavailable" && seen.tiles[id].reason === TIMED_OUT_REASON)
                        && seen?.tiles?.tasks?.status === "ok",
                    seen?.tiles && Object.keys(seen.tiles));
                const page = await call(H.base, "GET", q("/admin/os"));
                check("the page itself renders with the timed-out tiles", page.status === 200 && page.text.includes(TIMED_OUT_REASON));
            } finally {
                await locker.query(`ROLLBACK`).catch(() => {});
                await locker.end().catch(() => {});
            }
        }

        // ── C. a recorded scheduled run across the tiles and the vault browser ──
        console.log("\n  C. a run recorded by its wrapper shows on the brief tile, the usage tile and links into the vault");
        let scheduledId = 0;
        {
            const today = centralDay(new Date());
            const outputPath = `outputs/briefs/${today}.md`;
            int135Vault.writeBrief(today, { status: "ok", run: "scheduled" });
            const startedAt = new Date(Date.now() - 4 * 60_000);
            const rec = await asRunner("/runs", {
                skill: "morning-brief", trigger: "scheduled", ok: true, runner: `int135-pc-${tag}`,
                startedAt: startedAt.toISOString(), summary: "brief status: ok", outputPath,
                usage: { costUsd: 0.4321, inputTokens: 12345, outputTokens: 678, durationMs: 240000 },
            });
            scheduledId = Number(rec.json?.run?.id);
            if (scheduledId) int135Runs.add(scheduledId);
            check("POST /api/runner/runs records the scheduled brief (201)", rec.status === 201 && scheduledId > 0, rec.json);
            // A newer manual run of the same skill: not a scheduled one.
            const manual = await asRunner("/runs", { skill: "morning-brief", trigger: "manual", ok: true, runner: `int135-pc-${tag}`,
                usage: { costUsd: 0.1, inputTokens: 1, outputTokens: 1, durationMs: 1000 } });
            if (manual.json?.run?.id) int135Runs.add(Number(manual.json.run.id));

            const ov = await overviewJson(P.base);
            const last = ov?.tiles?.brief?.lastScheduled;
            check("the brief tile's lastScheduled is the recorded run, started when the wrapper said (not the newer manual one)",
                last?.id !== undefined && Number(last.id) === scheduledId && last.ok === true && last.outputPath === outputPath
                    && new Date(last.startedAt).getTime() === startedAt.getTime() && Math.abs(Number(last.costUsd) - 0.4321) < 1e-9,
                last);
            const points: any[] = ov?.tiles?.usage?.points ?? [];
            const point = points.find((p) => Number(p.id) === scheduledId);
            check("the usage tile plots it as a scheduled point with its cost and tokens",
                ov?.tiles?.usage?.status === "ok" && point?.trigger === "scheduled" && point.costUsd === 0.4321
                    && point.inputTokens === 12345 && point.durationMs === 240000 && ov.tiles.usage.costUsd >= 0.5321 - 1e-9,
                { status: ov?.tiles?.usage?.status, point, total: ov?.tiles?.usage?.costUsd });
            const page = await call(P.base, "GET", q("/admin/os"));
            check("... the sparkline on the page carries its point, and the brief tile its last scheduled run",
                page.status === 200 && page.text.includes(`data-run="${scheduledId}"`) && /data-last-scheduled="(?!none|unknown)/.test(page.text));

            const briefs = await call(P.base, "GET", q("/admin/briefs"));
            const link = [...briefs.text.matchAll(/class="run-output" href="([^"]+)"/g)]
                .map((m) => m[1].replace(/&amp;/g, "&"))
                .find((href) => new URL(href, "http://x").searchParams.get("path") === outputPath);
            check("/admin/briefs links the recorded run's output path into the vault browser", briefs.status === 200 && !!link,
                [...briefs.text.matchAll(/class="run-output"[^>]*>/g)].map((m) => m[0]));
            const opened = link ? await call(P.base, "GET", link) : null;
            check("... and the link opens that file in the vault browser", opened?.status === 200 && opened.text.includes(outputPath),
                opened && { status: opened.status });
        }

        // ── D. a confirm queues past a dead run; the page can follow it ──────
        console.log("\n  D. confirm → GET /admin/os/api/runs/:id → the brief tile's active run, through claim and complete");
        {
            const { rows: [dead] } = await pool.query(
                `INSERT INTO agent_runs (skill, status, requested_at, claimed_at, runner, trigger)
                 VALUES ('morning-brief', 'running', now() - interval '3 hours', now() - interval '2 hours', $1, 'button') RETURNING id`,
                [`int135-dead-${tag}`]);
            int135Runs.add(Number(dead.id));

            const proposed = await ask(P.base, "run my morning brief");
            const pid = proposed.json?.confirmation?.id;
            check("(precondition) \"run my morning brief\" is a tier-3 proposal", proposed.json?.tier === 3 && Number.isSafeInteger(pid), proposed.json);
            const confirmed = await confirm(P.base, pid);
            const runId = Number(confirmed.json?.run?.id);
            if (runId) int135Runs.add(runId);
            check(`a confirm with a 'running' run dead for over ${STALE_AFTER} queues a new run instead of reporting it "already running"`,
                confirmed.status === 201 && confirmed.json?.created === true && runId !== Number(dead.id), confirmed.json);
            const { rows: [deadNow] } = await pool.query(`SELECT status, summary FROM agent_runs WHERE id = $1`, [dead.id]);
            check("... the dead run is expired as failed", deadNow?.status === "failed" && /no result from runner/.test(deadNow.summary ?? ""), deadNow);

            const r1 = await runJson(P.base, runId);
            check("GET /admin/os/api/runs/:id reports the confirmed run queued, as a button run",
                r1.status === 200 && r1.json?.id === runId && r1.json.status === "queued" && r1.json.label === "Morning brief"
                    && r1.json.trigger === "button" && r1.json.claimedAt === null, r1.json);
            const ov1 = await overviewJson(P.base);
            check("... and the brief tile shows it as the active run",
                Number(ov1?.tiles?.brief?.activeRun?.id) === runId && ov1.tiles.brief.activeRun.status === "queued", ov1?.tiles?.brief?.activeRun);
            const page1 = await call(P.base, "GET", q("/admin/os"));
            check("... with the page on the 15-second refresh", /data-active-run="queued"/.test(page1.text) && /var every = 15000\b/.test(page1.text));

            const claim = await asRunner("/claim", { runner: `int135-pc-${tag}`, skills: ["morning-brief"] });
            check("(precondition) the runner claims that run", claim.status === 200 && Number(claim.json?.run?.id) === runId, claim.json);
            const r2 = await runJson(P.base, runId);
            const ov2 = await overviewJson(P.base);
            check("once claimed, the run endpoint says running and the tile shows it running on that runner",
                r2.json?.status === "running" && r2.json.claimedAt !== null
                    && ov2?.tiles?.brief?.activeRun?.status === "running" && ov2.tiles.brief.activeRun.runner === `int135-pc-${tag}`
                    && ov2.tiles.brief.runner.online === true,
                { run: r2.json, active: ov2?.tiles?.brief?.activeRun, runner: ov2?.tiles?.brief?.runner });

            const today = centralDay(new Date());
            const done = await asRunner(`/runs/${runId}/complete`, { ok: true, summary: "brief status: ok", outputPath: `outputs/briefs/${today}.md`,
                usage: { costUsd: 0.25, inputTokens: 100, outputTokens: 10, durationMs: 60000 } });
            check("(precondition) the runner completes it", done.status === 200, done.json);
            const r3 = await runJson(P.base, runId);
            const ov3 = await overviewJson(P.base);
            check("after complete, the run endpoint says succeeded with its output path, and nothing is active",
                r3.json?.status === "succeeded" && r3.json.outputPath === `outputs/briefs/${today}.md` && r3.json.finishedAt !== null
                    && ov3?.tiles?.brief?.activeRun === null && ov3.tiles.brief.activeCount === 0,
                { run: r3.json, active: ov3?.tiles?.brief?.activeRun });
            check("... the button run joins the usage points, and lastScheduled is still the scheduled run",
                (ov3?.tiles?.usage?.points ?? []).some((p: any) => Number(p.id) === runId && p.trigger === "button")
                    && Number(ov3?.tiles?.brief?.lastScheduled?.id) === scheduledId, ov3?.tiles?.brief?.lastScheduled);
        }
    } finally {
        if (int135Runs.size) await pool.query(`DELETE FROM agent_runs WHERE id = ANY($1)`, [[...int135Runs]]).catch(() => {});
        if (int135Accounts.length) {
            await pool.query(`DELETE FROM os_asks WHERE account_id = ANY($1)`, [int135Accounts]).catch(() => {});
            await pool.query(`DELETE FROM accounts WHERE id = ANY($1)`, [int135Accounts]).catch(() => {});
        }
        int135Vault.remove();
        P.server.close();
        H.server.close();
        await pool.end();
    }

    console.log(`\n  ${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
