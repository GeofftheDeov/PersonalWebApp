/**
 * The runner API (/api/runner), driven the way the PC runner and the admin
 * page drive it (spec #135; started by #137, later tickets extend it).
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
        // Nothing else may be queued for the skill, or claim would hand that over instead.
        const { rows: busy } = await pool.query(
            `SELECT id FROM agent_runs WHERE skill = $1 AND status IN ('queued','running')`, [SKILL]);
        if (busy.length) throw new Error(`database already has ${SKILL} runs in flight (${busy.map((r) => r.id)}); use a fresh one`);

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
            ["null, booleans, objects and fractional token counts",
                { costUsd: null, inputTokens: true, outputTokens: 12.5, durationMs: { ms: 3 } },
                { cost_usd: null, input_tokens: null, output_tokens: null, duration_ms: null }],
            ["a mix, where the good fields survive",
                { costUsd: 1.25, inputTokens: "lots", outputTokens: 300, durationMs: 4_000 },
                { cost_usd: 1.25, input_tokens: null, output_tokens: 300, duration_ms: 4_000 }],
            ["a fractional duration, which is rounded to the ms rather than dropped",
                { costUsd: 0.0001, inputTokens: 1, outputTokens: 2, durationMs: 1234.6 },
                { cost_usd: 0.0001, input_tokens: 1, output_tokens: 2, duration_ms: 1235 }],
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
    } finally {
        await pool.query(`DELETE FROM agent_runs WHERE runner = $1 OR summary LIKE $2`, [`t137-${tag}`, `t137 legacy ${tag}`]);
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
