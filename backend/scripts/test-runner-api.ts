/**
 * The runner API (/api/runner), driven the way the PC runner and the admin
 * page drive it (spec #135; started by #137, later tickets extend it: #138
 * records runs that finished outside the queue, #159 adds the W4 skills).
 *
 * Mounts the real admin router (which carries /admin/briefs, where the RUN
 * button enqueues) and the real runner router, then drives them over HTTP: the
 * admin with a JWT, the runner with RUNNER_TOKEN. Asserts on responses and on
 * agent_runs rows, against a throwaway database loaded from db/schema.sql.
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-runner-api.ts
 *
 * It inserts and deletes its own rows, but claim takes the oldest queued run
 * of a skill, so give it a database no other test is using at the same time.
 */
import "./use-test-jwt-secret.js";
import express from "express";
import type { AddressInfo } from "net";
import crypto from "crypto";
import pool from "../db/index.js";
import adminRoutes from "../routes/adminRoutes.js";
import runnerRoutes from "../routes/runnerRoutes.js";
import { SKILLS } from "../services/agentRuns.js";
import { signJwt } from "../utils/jwt.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
    console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
    process.exit(2);
}

// The runner token is whatever this process says it is; the vault pull that
// a completion triggers must find no vault, not Geoff's.
process.env.RUNNER_TOKEN = `t-${crypto.randomBytes(16).toString("hex")}`;
delete process.env.OBSIDIAN_VAULT_PATH;

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
    const d = typeof detail === "string" ? detail : JSON.stringify(detail);
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !d ? "" : `\n          ${d}`}`);
    ok ? pass++ : fail++;
}

const SKILL = "morning-brief";

async function main() {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use("/admin", adminRoutes);
    app.use("/api/runner", runnerRoutes);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const tag = crypto.randomBytes(4).toString("hex");
    let adminId = "";
    let adminToken = "";

    const send = async (method: string, path: string, headers: Record<string, string>, body?: unknown) => {
        const res = await fetch(`${base}${path}`, {
            method, redirect: "manual",
            headers: { "content-type": "application/json", ...headers },
            body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        });
        const text = await res.text();
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        return { status: res.status, json };
    };
    const asRunner = (path: string, body?: unknown) =>
        send("POST", `/api/runner${path}`, { authorization: `Bearer ${process.env.RUNNER_TOKEN}` }, body);
    const asAdmin = (path: string, body?: unknown) =>
        send("POST", `/admin${path}?token=${encodeURIComponent(adminToken)}`, {}, body);

    const row = async (id: number) =>
        (await pool.query(`SELECT * FROM agent_runs WHERE id = $1`, [id])).rows[0];

    /** The admin presses RUN and the runner claims it: a run in `running`, as the complete call finds it. */
    const runningRun = async (): Promise<number> => {
        const enq = await asAdmin("/briefs/runs", { skill: SKILL });
        if (enq.status !== 201) throw new Error(`enqueue: ${enq.status} ${JSON.stringify(enq.json)}`);
        const claim = await asRunner("/claim", { runner: `t137-${tag}`, skills: [SKILL] });
        if (claim.status !== 200 || claim.json?.run?.id !== enq.json.run.id) {
            throw new Error(`claim: ${claim.status} ${JSON.stringify(claim.json)} (enqueued ${enq.json.run.id})`);
        }
        return Number(claim.json.run.id);
    };
    const complete = (id: number, body: unknown) => asRunner(`/runs/${id}/complete`, body);

    try {
        // Nothing else may be queued for a runnable skill, or claim would hand that over instead.
        const { rows: busy } = await pool.query(
            `SELECT id, skill FROM agent_runs WHERE skill = ANY($1) AND status IN ('queued','running')`, [SKILLS.map((k) => k.id)]);
        if (busy.length) throw new Error(`database already has runs in flight (${busy.map((r) => `${r.skill} ${r.id}`)}); use a fresh one`);

        const email = `t137-admin-${tag}@example.test`;
        const { rows: [admin] } = await pool.query(
            `INSERT INTO accounts (id, handle, email, app_role, app_role_source) VALUES (gen_random_uuid(), $1, $2, 'admin', 'manual') RETURNING id`,
            [`t137_${tag}`, email]);
        adminId = admin.id;
        adminToken = signJwt({ id: adminId, email }, { expiresIn: "1h" });

        // ── a run the button made, before any usage is reported ────────────────
        {
            const id = await runningRun();
            const r = await row(id);
            check("a button run reads trigger = 'button' with null usage",
                r.trigger === "button" && r.cost_usd === null && r.input_tokens === null
                && r.output_tokens === null && r.duration_ms === null, r);
            // Rows written before the usage columns existed get the same defaults;
            // an insert that names none of the new columns is what they look like.
            const { rows: [old] } = await pool.query(
                `INSERT INTO agent_runs (skill, status, requested_at, claimed_at, finished_at, summary)
                 VALUES ($1, 'succeeded', now() - interval '3 days', now() - interval '3 days', now() - interval '3 days', $2)
                 RETURNING *`, [SKILL, `t137 legacy ${tag}`]);
            check("a row that names no usage columns reads as a button run with null usage",
                old.trigger === "button" && old.cost_usd === null && old.input_tokens === null
                && old.output_tokens === null && old.duration_ms === null, old);
            await pool.query(`DELETE FROM agent_runs WHERE id = $1`, [old.id]);
            const bad = await pool.query(`UPDATE agent_runs SET trigger = 'cron' WHERE id = $1`, [id]).then(() => null, (e) => e);
            check("trigger accepts only button, scheduled or manual", bad?.code === "23514", bad?.message ?? "update succeeded");
            await complete(id, { ok: true });
        }

        // ── full usage ─────────────────────────────────────────────────────────
        {
            const id = await runningRun();
            const res = await complete(id, {
                ok: true, summary: "brief ok", outputPath: "outputs/briefs/2026-10-12.md",
                usage: { costUsd: 0.4321, inputTokens: 1_234_567, outputTokens: 8_910, durationMs: 95_432 },
            });
            const r = await row(id);
            check("complete with full usage answers 200 with the run", res.status === 200 && Number(res.json?.run?.id) === id, res);
            check("full usage is stored on the run",
                r.cost_usd === 0.4321 && r.input_tokens === 1_234_567 && r.output_tokens === 8_910 && r.duration_ms === 95_432,
                r);
            check("the run carries its real outcome alongside the usage",
                r.status === "succeeded" && r.summary === "brief ok" && r.output_path === "outputs/briefs/2026-10-12.md"
                && r.finished_at !== null && r.trigger === "button", r);
            check("the response carries the stored usage",
                res.json?.run?.cost_usd === 0.4321 && res.json?.run?.input_tokens === 1_234_567
                && res.json?.run?.output_tokens === 8_910 && res.json?.run?.duration_ms === 95_432, res.json?.run);
        }

        // ── zero is a real value, not "unknown" ────────────────────────────────
        {
            const id = await runningRun();
            await complete(id, { ok: true, usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 } });
            const r = await row(id);
            check("zeros are stored as zeros",
                r.cost_usd === 0 && r.input_tokens === 0 && r.output_tokens === 0 && r.duration_ms === 0, r);
        }

        // ── malformed fields become null, the rest are kept ────────────────────
        const malformed: [string, Record<string, unknown>, Record<string, number | null>][] = [
            ["negative values",
                { costUsd: -0.01, inputTokens: -1, outputTokens: 50, durationMs: -5 },
                { cost_usd: null, input_tokens: null, output_tokens: 50, duration_ms: null }],
            ["strings, even numeric ones",
                { costUsd: "0.12", inputTokens: "100", outputTokens: 7, durationMs: "1000" },
                { cost_usd: null, input_tokens: null, output_tokens: 7, duration_ms: null }],
            ["values over the ceiling",
                { costUsd: 1500, inputTokens: 2e9, outputTokens: 1e10, durationMs: 2 * 86_400_000 },
                { cost_usd: null, input_tokens: null, output_tokens: null, duration_ms: null }],
            ["null, booleans and objects",
                { costUsd: null, inputTokens: true, outputTokens: { value: 12 }, durationMs: [3] },
                { cost_usd: null, input_tokens: null, output_tokens: null, duration_ms: null }],
            ["a mix, where the good fields survive",
                { costUsd: 1.25, inputTokens: "lots", outputTokens: 300, durationMs: 4_000 },
                { cost_usd: 1.25, input_tokens: null, output_tokens: 300, duration_ms: 4_000 }],
            ["fractional counts, which are rounded rather than dropped",
                { costUsd: 0.0001, inputTokens: 1234.0000001, outputTokens: 12.5, durationMs: 1234.4 },
                { cost_usd: 0.0001, input_tokens: 1234, output_tokens: 13, duration_ms: 1234 }],
            ["missing fields",
                { costUsd: 0.05 },
                { cost_usd: 0.05, input_tokens: null, output_tokens: null, duration_ms: null }],
        ];
        for (const [label, usage, want] of malformed) {
            const id = await runningRun();
            const res = await complete(id, { ok: false, summary: `failed: ${label}`, usage });
            const r = await row(id);
            const got = { cost_usd: r.cost_usd, input_tokens: r.input_tokens, output_tokens: r.output_tokens, duration_ms: r.duration_ms };
            check(`malformed usage (${label}): 200, stored as null field by field`,
                res.status === 200 && JSON.stringify(got) === JSON.stringify(want), { status: res.status, got, want });
            check(`malformed usage (${label}): the run still completes with its real outcome`,
                r.status === "failed" && r.summary === `failed: ${label}` && r.finished_at !== null, r);
        }

        // JSON has no NaN or Infinity (express.json() rejects a body that spells
        // them out, before any route runs), so the only non-finite number a
        // request can carry is one too large for a double: 1e400 parses as Infinity.
        {
            const id = await runningRun();
            const res = await complete(id, `{"ok":true,"usage":{"costUsd":1e400,"inputTokens":5,"outputTokens":-1e400}}`);
            const r = await row(id);
            check("a non-finite number (1e400 parses as Infinity) is stored as null and the run completes",
                res.status === 200 && r.status === "succeeded" && r.cost_usd === null && r.input_tokens === 5
                && r.output_tokens === null, { status: res.status, r });
        }

        // ── a usage block that isn't an object ─────────────────────────────────
        for (const usage of ["0.5", 42, [0.5, 1, 2, 3], null, true]) {
            const id = await runningRun();
            const res = await complete(id, { ok: true, usage });
            const r = await row(id);
            check(`usage of ${JSON.stringify(usage)} is ignored: 200, succeeded, all usage null`,
                res.status === 200 && r.status === "succeeded"
                && r.cost_usd === null && r.input_tokens === null && r.output_tokens === null && r.duration_ms === null,
                { status: res.status, r });
        }

        // ── the old runner: no usage at all ────────────────────────────────────
        {
            const id = await runningRun();
            const res = await complete(id, { ok: true, summary: "complete", outputPath: "outputs/briefs/2026-10-12.md" });
            const r = await row(id);
            check("complete without usage answers 200 with the run, as before",
                res.status === 200 && Number(res.json?.run?.id) === id && res.json?.run?.status === "succeeded", res);
            check("complete without usage stores the outcome and leaves usage null",
                r.status === "succeeded" && r.summary === "complete" && r.output_path === "outputs/briefs/2026-10-12.md"
                && r.cost_usd === null && r.input_tokens === null && r.output_tokens === null && r.duration_ms === null
                && r.trigger === "button", r);

            const id2 = await runningRun();
            const res2 = await complete(id2, { ok: "yes" });
            check("anything but ok: true is still a failure", res2.status === 200 && (await row(id2)).status === "failed", res2);
        }

        // ── completing a run that isn't running ────────────────────────────────
        {
            const id = await runningRun();
            await complete(id, { ok: true, usage: { costUsd: 0.1, inputTokens: 10, outputTokens: 20, durationMs: 30 } });
            const again = await complete(id, { ok: false, summary: "late", usage: { costUsd: 9, inputTokens: 9, outputTokens: 9, durationMs: 9 } });
            const r = await row(id);
            check("completing a finished run gets 409", again.status === 409, again);
            check("a 409 leaves the finished run's outcome and usage alone",
                r.status === "succeeded" && r.summary === null && r.cost_usd === 0.1 && r.input_tokens === 10
                && r.output_tokens === 20 && r.duration_ms === 30, r);

            const enq = await asAdmin("/briefs/runs", { skill: SKILL });
            const queuedId = Number(enq.json?.run?.id);
            const q = await complete(queuedId, { ok: true, usage: { costUsd: 0.1 } });
            check("completing a queued (unclaimed) run gets 409", q.status === 409 && (await row(queuedId)).status === "queued", q);
            await pool.query(`DELETE FROM agent_runs WHERE id = $1`, [queuedId]);

            const unknown = await complete(2_000_000_000, { ok: true, usage: { costUsd: 0.1 } });
            check("completing an unknown run gets 409", unknown.status === 409, unknown);
        }

        // ── auth is unchanged ──────────────────────────────────────────────────
        {
            const res = await send("POST", "/api/runner/runs/1/complete", { authorization: "Bearer wrong" }, { ok: true });
            check("complete without the runner token gets 401", res.status === 401, res);
        }

        // ══ #138: recording a run that finished outside the queue ══════════════
        // POST /api/runner/runs, called once by a vault wrapper after a scheduled
        // (Task Scheduler) or manual (terminal) run. No retry, so no idempotency.
        const runner138 = `t138-${tag}`;
        const record = (body: unknown) => asRunner("/runs", body);
        const recordedCount = async () =>
            Number((await pool.query(`SELECT count(*) FROM agent_runs WHERE runner = $1`, [runner138])).rows[0].count);
        const ms = (v: unknown) => (v === null || v === undefined ? NaN : new Date(v as string).getTime());
        const near = (v: unknown, at: number, slackMs = 15_000) => Math.abs(ms(v) - at) <= slackMs;

        // ── auth ───────────────────────────────────────────────────────────────
        {
            const before = await recordedCount();
            const body = { skill: SKILL, trigger: "scheduled", ok: true, runner: runner138 };
            const none = await send("POST", "/api/runner/runs", {}, body);
            const wrong = await send("POST", "/api/runner/runs", { authorization: "Bearer wrong" }, body);
            const bare = await send("POST", "/api/runner/runs", { authorization: process.env.RUNNER_TOKEN! }, body);
            check("recording without the runner token gets 401", none.status === 401, none);
            check("recording with a wrong token gets 401", wrong.status === 401, wrong);
            check("recording with the token but no Bearer prefix gets 401", bare.status === 401, bare);
            const adminTry = await send("POST", "/api/runner/runs", { authorization: `Bearer ${adminToken}` }, body);
            check("an admin JWT is not a runner token (401)", adminTry.status === 401, adminTry);
            check("a refused record writes no row", (await recordedCount()) === before, await recordedCount());
        }

        // ── validation: the skill and the trigger ──────────────────────────────
        {
            const before = await recordedCount();
            const ok = { skill: SKILL, trigger: "scheduled", ok: true, runner: runner138 };
            const refused: [string, unknown][] = [
                ["an unknown skill", { ...ok, skill: "t138-not-a-skill" }],
                ["a skill in the wrong case", { ...ok, skill: "Morning-Brief" }],
                ["a skill with trailing space", { ...ok, skill: "morning-brief " }],
                ["a missing skill", { trigger: "scheduled", ok: true, runner: runner138 }],
                ["a non-string skill", { ...ok, skill: ["morning-brief"] }],
                ["trigger 'button' (button runs go through the queue)", { ...ok, trigger: "button" }],
                ["a missing trigger", { skill: SKILL, ok: true, runner: runner138 }],
                ["an unknown trigger", { ...ok, trigger: "cron" }],
                ["a trigger in the wrong case", { ...ok, trigger: "Scheduled" }],
                ["a null trigger", { ...ok, trigger: null }],
                ["a body that's an array", [ok]],
            ];
            for (const [label, body] of refused) {
                const res = await record(body);
                check(`recording with ${label} gets 400 with an error`, res.status === 400 && typeof res.json?.error === "string", res);
            }
            check("a 400 writes no row", (await recordedCount()) === before, await recordedCount());
        }

        // ── a scheduled run with everything ────────────────────────────────────
        {
            const startedAt = new Date(Date.now() - 20 * 60_000);
            startedAt.setUTCMilliseconds(123);
            const res = await record({
                skill: SKILL, trigger: "scheduled", ok: true, runner: runner138, startedAt: startedAt.toISOString(),
                summary: "brief status: ok", outputPath: "outputs/briefs/2026-10-18.md",
                usage: { costUsd: 0.4321, inputTokens: 1_234_567, outputTokens: 8_910, durationMs: 95_432 },
            });
            const id = Number(res.json?.run?.id);
            const r = id ? await row(id) : null;
            check("recording a scheduled run answers 201 with { run }", res.status === 201 && id > 0, res);
            check("the row is a succeeded scheduled run, never queued or running",
                r?.skill === SKILL && r?.status === "succeeded" && r?.trigger === "scheduled" && r?.runner === runner138, r);
            check("claimed_at is the startedAt it sent (in the last 24 hours)", ms(r?.claimed_at) === startedAt.getTime(),
                { claimed_at: r?.claimed_at, startedAt });
            check("finished_at is now", near(r?.finished_at, Date.now()), r?.finished_at);
            check("requested_at is the start too, so the history lists it when it started",
                ms(r?.requested_at) === startedAt.getTime(), r?.requested_at);
            check("the usage is stored",
                r?.cost_usd === 0.4321 && r?.input_tokens === 1_234_567 && r?.output_tokens === 8_910 && r?.duration_ms === 95_432, r);
            check("the summary and output path are stored",
                r?.summary === "brief status: ok" && r?.output_path === "outputs/briefs/2026-10-18.md", r);
            check("the response's run is the stored row",
                res.json?.run?.status === "succeeded" && res.json?.run?.trigger === "scheduled" && res.json?.run?.cost_usd === 0.4321
                && ms(res.json?.run?.claimed_at) === startedAt.getTime(), res.json?.run);
        }

        // ── a failed manual run, with the PowerShell wrapper's own timestamp format ──
        {
            const startedAt = new Date(Date.now() - 3 * 60_000);
            const ps = startedAt.toISOString();   // the wrapper writes yyyy-MM-ddTHH:mm:ss.fffZ, which is this
            const res = await record({ skill: "lint-wiki", trigger: "manual", ok: false, runner: runner138, startedAt: ps,
                summary: "lint_wiki.ps1 exited 1" });
            const r = await row(Number(res.json?.run?.id));
            check("ok: false records a failed manual run (201)",
                res.status === 201 && r?.status === "failed" && r?.trigger === "manual" && r?.skill === "lint-wiki"
                && ms(r?.claimed_at) === startedAt.getTime(), { status: res.status, r });
            check("a run that reports no usage stores null usage, never 0",
                r?.cost_usd === null && r?.input_tokens === null && r?.output_tokens === null && r?.duration_ms === null, r);

            const offset = new Date(Date.now() - 10 * 60_000);
            offset.setUTCMilliseconds(0);
            const local = new Date(offset.getTime() - 5 * 3_600_000).toISOString().slice(0, 19) + "-05:00";
            const res2 = await record({ skill: SKILL, trigger: "manual", ok: true, runner: runner138, startedAt: local });
            check("a startedAt with a UTC offset is read as that instant",
                res2.status === 201 && ms((await row(Number(res2.json?.run?.id)))?.claimed_at) === offset.getTime(),
                { local, json: res2.json });

            const yes = await record({ skill: SKILL, trigger: "manual", ok: "yes", runner: runner138 });
            check("anything but ok: true is recorded as failed, as on complete",
                yes.status === 201 && (await row(Number(yes.json?.run?.id)))?.status === "failed", yes);
        }

        // ── startedAt outside the window, in the future or unreadable: now ─────
        {
            const H = 3_600_000;
            const fallbacks: [string, unknown][] = [
                ["25 hours ago", new Date(Date.now() - 25 * H).toISOString()],
                ["a week ago", new Date(Date.now() - 7 * 24 * H).toISOString()],
                ["an hour in the future", new Date(Date.now() + H).toISOString()],
                ["a minute in the future", new Date(Date.now() + 60_000).toISOString()],
                ["missing", undefined],
                ["null", null],
                ["not a date", "yesterday"],
                ["an impossible day", "2026-02-30T06:45:00Z"],
                ["a date with no time", new Date().toISOString().slice(0, 10)],
                ["a time with no offset (whose clock?)", new Date(Date.now() - H).toISOString().slice(0, 19)],
                ["a US-style date", "10/18/2026 06:45"],
                ["PowerShell 5.1's DateTime JSON", `/Date(${Date.now() - H})/`],
                ["epoch milliseconds", Date.now() - H],
                ["an object", { value: new Date(Date.now() - H).toISOString() }],
            ];
            for (const [label, startedAt] of fallbacks) {
                const res = await record({ skill: SKILL, trigger: "scheduled", ok: true, runner: runner138, startedAt });
                const r = res.json?.run?.id ? await row(Number(res.json.run.id)) : null;
                check(`startedAt ${label}: still 201, and claimed_at falls back to now (= finished_at)`,
                    res.status === 201 && r?.claimed_at && ms(r.claimed_at) === ms(r.finished_at) && near(r.claimed_at, Date.now()),
                    { status: res.status, r });
            }
            const edge = new Date(Date.now() - 24 * H + 5 * 60_000);
            const res = await record({ skill: SKILL, trigger: "scheduled", ok: true, runner: runner138, startedAt: edge.toISOString() });
            check("startedAt just inside 24 hours is kept",
                res.status === 201 && ms((await row(Number(res.json?.run?.id)))?.claimed_at) === edge.getTime(), res.json);
        }

        // ── usage, summary and output path are read as on complete ─────────────
        for (const [label, usage, want] of malformed) {
            const res = await record({ skill: SKILL, trigger: "manual", ok: true, runner: runner138, usage });
            const r = res.json?.run?.id ? await row(Number(res.json.run.id)) : null;
            const got = r && { cost_usd: r.cost_usd, input_tokens: r.input_tokens, output_tokens: r.output_tokens, duration_ms: r.duration_ms };
            check(`recorded malformed usage (${label}): 201, stored as null field by field`,
                res.status === 201 && JSON.stringify(got) === JSON.stringify(want), { status: res.status, got, want });
        }
        for (const usage of ["0.5", 42, [0.5, 1, 2, 3], null, true]) {
            const res = await record({ skill: SKILL, trigger: "manual", ok: true, runner: runner138, usage });
            const r = res.json?.run?.id ? await row(Number(res.json.run.id)) : null;
            check(`recorded usage of ${JSON.stringify(usage)} is ignored: 201, all usage null`,
                res.status === 201 && r?.cost_usd === null && r?.input_tokens === null && r?.output_tokens === null
                && r?.duration_ms === null, { status: res.status, r });
        }
        {
            const res = await record({ skill: SKILL, trigger: "manual", ok: true, runner: runner138,
                summary: "s".repeat(600), outputPath: "p".repeat(400) });
            const r = await row(Number(res.json?.run?.id));
            check("a long summary and output path are truncated (500 and 300), as on complete",
                res.status === 201 && r?.summary === "s".repeat(500) && r?.output_path === "p".repeat(300), { status: res.status });
            const res2 = await record({ skill: SKILL, trigger: "manual", ok: true, runner: runner138, summary: 42, outputPath: ["x"] });
            const r2 = await row(Number(res2.json?.run?.id));
            check("a non-string summary or output path is stored as null",
                res2.status === 201 && r2?.summary === null && r2?.output_path === null, { status: res2.status, r2 });
        }

        // ── runner is optional ─────────────────────────────────────────────────
        {
            const res = await record({ skill: SKILL, trigger: "manual", ok: true, summary: `t138 no runner ${tag}` });
            const id = Number(res.json?.run?.id);
            const r = id ? await row(id) : null;
            check("recording without a runner is 201 with a null runner", res.status === 201 && r?.runner === null, { status: res.status, r });
            if (id) await pool.query(`DELETE FROM agent_runs WHERE id = $1`, [id]);
            const empty = await record({ skill: SKILL, trigger: "manual", ok: true, runner: "", summary: `t138 no runner ${tag}` });
            const er = empty.json?.run?.id ? await row(Number(empty.json.run.id)) : null;
            check("an empty runner name is stored as null", empty.status === 201 && er?.runner === null, { status: empty.status, er });
            if (er) await pool.query(`DELETE FROM agent_runs WHERE id = $1`, [er.id]);
            const long = await record({ skill: SKILL, trigger: "manual", ok: true, runner: runner138 + "x".repeat(200) });
            const lr = await row(Number(long.json?.run?.id));
            check("a long runner name is cut to 100 characters, as on claim",
                long.status === 201 && lr?.runner === (runner138 + "x".repeat(200)).slice(0, 100), lr?.runner);
            if (lr) await pool.query(`DELETE FROM agent_runs WHERE id = $1`, [lr.id]);
        }

        // ── not idempotent: a second post is a second row ──────────────────────
        {
            const body = { skill: SKILL, trigger: "scheduled", ok: true, runner: runner138, startedAt: new Date(Date.now() - 60_000).toISOString() };
            const a = await record(body);
            const b = await record(body);
            check("posting the same run twice records two rows",
                a.status === 201 && b.status === 201 && Number(a.json?.run?.id) !== Number(b.json?.run?.id), { a: a.json, b: b.json });
        }

        // ── a recorded run never touches the queue ─────────────────────────────
        {
            const rec = await record({ skill: SKILL, trigger: "scheduled", ok: true, runner: runner138 });
            const recId = Number(rec.json?.run?.id);
            const claim = await asRunner("/claim", { runner: runner138, skills: SKILLS.map((k) => k.id) });
            check("with only recorded runs in the table, claim finds nothing (204)", claim.status === 204, claim);
            const enq = await asAdmin("/briefs/runs", { skill: SKILL });
            check("a recorded run doesn't block an enqueue of the same skill (201, created)",
                enq.status === 201 && enq.json?.created === true && Number(enq.json?.run?.id) !== recId, enq);
            const got = await asRunner("/claim", { runner: `t137-${tag}`, skills: [SKILL] });
            check("the claim then gets the enqueued run, not the recorded one",
                got.status === 200 && Number(got.json?.run?.id) === Number(enq.json?.run?.id), got);
            const late = await complete(recId, { ok: false, summary: "late" });
            check("a recorded run can't be completed (409), so its outcome stands",
                late.status === 409 && (await row(recId))?.status === "succeeded", late);
            await complete(Number(got.json?.run?.id), { ok: true });
            const recordedFailed = await record({ skill: SKILL, trigger: "manual", ok: false, runner: runner138 });
            const enq2 = await asAdmin("/briefs/runs", { skill: SKILL });
            check("nor does a recorded failed run (201, created)",
                recordedFailed.status === 201 && enq2.status === 201 && enq2.json?.created === true, enq2);
            const got2 = await asRunner("/claim", { runner: `t137-${tag}`, skills: [SKILL] });
            await complete(Number(got2.json?.run?.id), { ok: true });
        }

        // ══ W4 (#159): ingest-debrief, lint-wiki and weekly-review are runnable ══
        const NEW_SKILLS = [
            { id: "ingest-debrief", label: "Ingest debrief", output: "projects/alpaca-trading-bot/market-state.md" },
            { id: "lint-wiki", label: "Lint wiki", output: "outputs/lint/2026-10-12.md" },
            { id: "weekly-review", label: "Weekly review", output: "outputs/reviews/2026-W42.md" },
        ];
        const runner159 = `t159-${tag}`;
        const claimAs = (skills: unknown) => asRunner("/claim", { runner: runner159, skills });

        // ── the briefs page has a RUN button for each ──────────────────────────
        {
            const res = await fetch(`${base}/admin/briefs?token=${encodeURIComponent(adminToken)}`, { redirect: "manual" });
            const html = await res.text();
            for (const s of NEW_SKILLS) {
                check(`/admin/briefs has a RUN ${s.label.toUpperCase()} button for ${s.id}`,
                    res.status === 200 && html.includes(`data-skill="${s.id}"`) && html.includes(`RUN ${s.label.toUpperCase()}</button>`),
                    { status: res.status });
            }
        }

        // ── each can be enqueued and claimed by a runner that lists it ─────────
        for (const s of NEW_SKILLS) {
            const enq = await asAdmin("/briefs/runs", { skill: s.id });
            check(`${s.id}: RUN enqueues a queued button run (201)`,
                enq.status === 201 && enq.json?.created === true && enq.json?.run?.skill === s.id
                && enq.json?.run?.status === "queued" && enq.json?.run?.trigger === "button", enq);
            const id = Number(enq.json?.run?.id);

            const again = await asAdmin("/briefs/runs", { skill: s.id });
            check(`${s.id}: a second press while it's queued returns the same run (200, not created)`,
                again.status === 200 && again.json?.created === false && Number(again.json?.run?.id) === id, again);

            const claim = await claimAs([s.id]);
            check(`${s.id}: a runner that lists it claims it`,
                claim.status === 200 && Number(claim.json?.run?.id) === id && claim.json?.run?.skill === s.id, claim);
            const r = await row(id);
            check(`${s.id}: the claimed run is running under that runner`,
                r?.status === "running" && r?.runner === runner159 && r?.claimed_at !== null, r);

            const done = await complete(id, {
                ok: true, summary: `${s.id} ok`, outputPath: s.output,
                usage: { costUsd: 0.25, inputTokens: 1000, outputTokens: 200, durationMs: 60_000 },
            });
            const after = await row(id);
            check(`${s.id}: the runner completes it with its output path and usage`,
                done.status === 200 && after.status === "succeeded" && after.output_path === s.output
                && after.cost_usd === 0.25 && after.output_tokens === 200, { status: done.status, after });
        }

        // ── a runner that doesn't list a skill skips it ────────────────────────
        {
            const lint = await asAdmin("/briefs/runs", { skill: "lint-wiki" });
            const lintId = Number(lint.json?.run?.id);
            const none = await claimAs(["morning-brief"]);
            check("a runner listing only morning-brief gets nothing while only lint-wiki is queued (204)", none.status === 204, none);
            const bare = await claimAs("morning-brief");
            check("so does an old runner sending the list as a bare string (204)", bare.status === 204, bare);
            const empty = await claimAs([]);
            check("and a runner listing nothing (204)", empty.status === 204, empty);
            check("the skipped run stays queued and unclaimed",
                (await row(lintId)).status === "queued" && (await row(lintId)).runner === null, await row(lintId));

            // A newer morning-brief is claimed past the older, unlisted lint-wiki.
            const brief = await asAdmin("/briefs/runs", { skill: "morning-brief" });
            const briefId = Number(brief.json?.run?.id);
            const got = await claimAs(["morning-brief"]);
            check("a runner listing only morning-brief claims the newer brief, not the older lint-wiki",
                got.status === 200 && Number(got.json?.run?.id) === briefId && got.json?.run?.skill === "morning-brief", got);
            await complete(briefId, { ok: true });

            const other = await claimAs(["weekly-review", "ingest-debrief"]);
            check("a runner listing other new skills still skips lint-wiki (204)", other.status === 204, other);

            const lintClaim = await claimAs(["lint-wiki"]);
            check("the lint-wiki run waits for a runner that lists it",
                lintClaim.status === 200 && Number(lintClaim.json?.run?.id) === lintId, lintClaim);
            await complete(lintId, { ok: false, summary: "t159 cleanup" });
        }

        // ── the server still refuses what isn't runnable ───────────────────────
        for (const skill of ["Lint-Wiki", "weekly_review", "ingest", "lint-wiki ", ""]) {
            const res = await asAdmin("/briefs/runs", { skill });
            check(`enqueueing ${JSON.stringify(skill)} gets 400`, res.status === 400, res);
        }

        // ── output paths, as the SKILLS entries give them ──────────────────────
        {
            const outputOf = (id: string, day: string) => SKILLS.find((k) => k.id === id)?.output(day);
            check("ingest-debrief's output is the market-state page, whatever the day",
                outputOf("ingest-debrief", "2026-10-12") === "projects/alpaca-trading-bot/market-state.md"
                && outputOf("ingest-debrief", "2027-01-01") === "projects/alpaca-trading-bot/market-state.md");
            check("lint-wiki's output is outputs/lint/YYYY-MM-DD.md",
                outputOf("lint-wiki", "2026-10-12") === "outputs/lint/2026-10-12.md", outputOf("lint-wiki", "2026-10-12"));
            check("morning-brief's output is unchanged",
                outputOf("morning-brief", "2026-10-12") === "outputs/briefs/2026-10-12.md", outputOf("morning-brief", "2026-10-12"));

            // Reference values from Python's date.isocalendar().
            const weeks: [string, string][] = [
                ["2026-10-12", "2026-W42"],   // Monday
                ["2026-03-08", "2026-W10"],   // Sunday ends its week
                ["2025-12-28", "2025-W52"],   // Sunday
                ["2025-12-29", "2026-W01"],   // Monday: week 1 of 2026 starts in 2025
                ["2026-01-01", "2026-W01"],   // Thursday
                ["2026-12-28", "2026-W53"],   // 2026 has 53 weeks (it starts on a Thursday)
                ["2027-01-01", "2026-W53"],   // Friday: still 2026's week 53
                ["2027-01-03", "2026-W53"],   // Sunday
                ["2027-01-04", "2027-W01"],   // Monday
                ["2027-12-31", "2027-W52"],   // Friday: 2027 has 52
                ["2028-01-01", "2027-W52"],   // Saturday
                ["2028-01-03", "2028-W01"],   // Monday
                ["2024-12-30", "2025-W01"],   // Monday in 2024, week 1 of 2025
                ["2020-12-31", "2020-W53"],   // Thursday
                ["2021-01-03", "2020-W53"],   // Sunday in 2021, 2020's last week
            ];
            for (const [day, week] of weeks) {
                const got = outputOf("weekly-review", day);
                check(`weekly-review on ${day} writes outputs/reviews/${week}.md`, got === `outputs/reviews/${week}.md`, got);
            }
            for (const bad of ["2026-02-30", "2026-10-12T04:00:00Z", "2026-W42", ""]) {
                let threw = false;
                try { outputOf("weekly-review", bad); } catch { threw = true; }
                check(`weekly-review's output refuses ${JSON.stringify(bad)} rather than guessing a week`, threw);
            }
        }

        // ── the record-a-finished-run endpoint (#138) accepts the new skills ───
        {
            // A body any version of the endpoint must refuse; its runner is ours, so cleanup finds a stray row.
            const probe = await asRunner("/runs", { skill: "t159-not-a-skill", trigger: "manual", ok: true, runner: runner159 });
            if (probe.status === 404) {
                console.log("  SKIP  POST /api/runner/runs isn't on this branch yet (#138): recording the new skills is unchecked");
            } else {
                check("POST /runs refuses a skill that isn't runnable (400)", probe.status === 400, probe);
                for (const s of NEW_SKILLS) {
                    const res = await asRunner("/runs", {
                        skill: s.id, trigger: "manual", ok: true, runner: runner159, outputPath: s.output,
                        usage: { costUsd: 0.1, inputTokens: 10, outputTokens: 5, durationMs: 1000 },
                    });
                    const r = res.json?.run?.id ? await row(Number(res.json.run.id)) : null;
                    check(`POST /runs records a finished ${s.id} run (201)`,
                        res.status === 201 && r?.skill === s.id && r?.status === "succeeded" && r?.trigger === "manual"
                        && r?.output_path === s.output, { status: res.status, json: res.json, r });
                }
            }
        }

        // ── GET /admin/os/api/runs/:id: the page polls a confirmed run (#153) ──
        {
            const t153Accounts: string[] = [];
            const t153Get = async (id: string | number, token: string | null = adminToken) => {
                const res = await fetch(`${base}/admin/os/api/runs/${id}${token === null ? "" : `?token=${encodeURIComponent(token)}`}`,
                    { redirect: "manual" });
                const text = await res.text();
                let json: any = null;
                try { json = JSON.parse(text); } catch { /* HTML */ }
                return { status: res.status, json, text, cacheControl: res.headers.get("cache-control"), type: res.headers.get("content-type") ?? "" };
            };
            const t153Account = async (role: "admin" | "user") => {
                const n = t153Accounts.length + 1;
                const email = `t153-${role}-${n}-${tag}@example.test`;
                const { rows: [acct] } = await pool.query(
                    `INSERT INTO accounts (id, handle, email, app_role, app_role_source) VALUES (gen_random_uuid(), $1, $2, $3, 'manual') RETURNING id`,
                    [`t153_${role}_${n}_${tag}`, email, role]);
                t153Accounts.push(acct.id);
                return { id: acct.id as string, email };
            };
            try {
                const t153Enq = await asAdmin("/briefs/runs", { skill: SKILL });
                const t153Id = Number(t153Enq.json?.run?.id);
                const t153Queued = await t153Get(t153Id);
                check("a queued run reads 200 { id, skill, label, status: 'queued', trigger, outputPath: null, finishedAt: null }",
                    t153Queued.status === 200 && t153Queued.json?.id === t153Id && t153Queued.json.skill === SKILL
                        && t153Queued.json.label === "Morning brief" && t153Queued.json.status === "queued"
                        && t153Queued.json.trigger === "button" && t153Queued.json.outputPath === null
                        && t153Queued.json.summary === null && t153Queued.json.finishedAt === null
                        && typeof t153Queued.json.requestedAt === "string" && t153Queued.json.claimedAt === null, t153Queued.json);
                check("... as JSON that's never cached", /application\/json/.test(t153Queued.type) && t153Queued.cacheControl === "no-store",
                    { type: t153Queued.type, cache: t153Queued.cacheControl });
                check("... with only the fields the page needs (no usage, no requester)",
                    JSON.stringify(Object.keys(t153Queued.json ?? {}).sort())
                        === JSON.stringify(["claimedAt", "finishedAt", "id", "label", "outputPath", "requestedAt", "skill", "status", "summary", "trigger"]),
                    Object.keys(t153Queued.json ?? {}));

                const t153Claim = await asRunner("/claim", { runner: `t137-${tag}`, skills: [SKILL] });
                const t153Running = await t153Get(t153Id);
                check("once claimed it reads 'running', with claimedAt",
                    Number(t153Claim.json?.run?.id) === t153Id && t153Running.json?.status === "running"
                        && typeof t153Running.json.claimedAt === "string" && t153Running.json.finishedAt === null, t153Running.json);

                await complete(t153Id, { ok: true, summary: "brief status: ok", outputPath: "outputs/briefs/2026-10-22.md" });
                const t153Done = await t153Get(t153Id);
                check("a finished run reads 'succeeded' with its output path, summary and finishedAt",
                    t153Done.status === 200 && t153Done.json?.status === "succeeded"
                        && t153Done.json.outputPath === "outputs/briefs/2026-10-22.md" && t153Done.json.summary === "brief status: ok"
                        && !Number.isNaN(Date.parse(t153Done.json.finishedAt)), t153Done.json);

                const t153FailedId = await runningRun();
                await complete(t153FailedId, { ok: false, summary: "morning_brief.ps1 exited 1; see private\\logs\\x.log" });
                const t153Failed = await t153Get(t153FailedId);
                check("a failed run reads 'failed' with its summary (the reason) and no output path",
                    t153Failed.json?.status === "failed" && t153Failed.json.summary === "morning_brief.ps1 exited 1; see private\\logs\\x.log"
                        && t153Failed.json.outputPath === null, t153Failed.json);

                const { rows: [{ max: t153Max }] } = await pool.query(`SELECT coalesce(max(id), 0)::bigint AS max FROM agent_runs`);
                const t153Missing = await t153Get(Number(t153Max) + 1000);
                check("an unknown run id is 404 { error }", t153Missing.status === 404 && typeof t153Missing.json?.error === "string", t153Missing);
                const t153Bad = await Promise.all(["abc", "0", "-1", "1.5", "1e3", "+7", "007", "99999999999999999999", "%20"].map((s) => t153Get(s)));
                check("a malformed run id is 400 { error }", t153Bad.every((r) => r.status === 400 && typeof r.json?.error === "string"),
                    t153Bad.map((r) => r.status));

                // The gate, as for every /admin/os/api route: a redirect to login or the HTML 403, never the run.
                const t153Anon = await t153Get(t153FailedId, null);
                const t153Expired = await t153Get(t153FailedId, signJwt({ id: adminId, email: `t137-admin-${tag}@example.test`,
                    exp: Math.floor(Date.now() / 1000) - 60 }));
                const t153User = await t153Account("user");
                const t153NonAdmin = await t153Get(t153FailedId, signJwt({ id: t153User.id, email: t153User.email }, { expiresIn: "1h" }));
                check("no token is redirected to login", t153Anon.status === 302, t153Anon.status);
                check("an expired token is redirected to login", t153Expired.status === 302, t153Expired.status);
                check("a non-admin gets the gate's HTML 403, without the run",
                    t153NonAdmin.status === 403 && t153NonAdmin.json === null && !t153NonAdmin.text.includes("morning_brief.ps1"),
                    { status: t153NonAdmin.status, body: t153NonAdmin.text.slice(0, 120) });

                // A single-admin app: any admin may read any run, as /admin/briefs lists every run to every admin.
                const t153Other = await t153Account("admin");
                const t153OtherRead = await t153Get(t153Id, signJwt({ id: t153Other.id, email: t153Other.email }, { expiresIn: "1h" }));
                check("another admin can read the run too (runs aren't per account)",
                    t153OtherRead.status === 200 && t153OtherRead.json?.id === t153Id, t153OtherRead.status);
            } finally {
                for (const id of t153Accounts) await pool.query(`DELETE FROM accounts WHERE id = $1`, [id]);
            }
        }
    } finally {
        await pool.query(`DELETE FROM agent_runs WHERE runner = ANY($1) OR summary = ANY($2) OR runner LIKE $3`,
            [[`t137-${tag}`, `t159-${tag}`], [`t137 legacy ${tag}`, `t138 no runner ${tag}`], `t138-${tag}%`]);
        if (adminId) {
            await pool.query(`DELETE FROM agent_runs WHERE requested_by = $1`, [adminId]);
            await pool.query(`DELETE FROM accounts WHERE id = $1`, [adminId]);
        }
        server.close();
    }

    console.log(`\n  ${pass} passed, ${fail} failed\n`);
    await pool.end();
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
