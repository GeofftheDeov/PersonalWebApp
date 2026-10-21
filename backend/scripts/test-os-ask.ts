/**
 * The agentic OS ask endpoint (POST /admin/os/ask, #146 of spec #135, W3),
 * seam: the HTTP API.
 *
 * Two harnesses over the same throwaway database loaded from db/schema.sql:
 *
 *   - "prod wiring": the real adminRoutes mounted at /admin, as server.ts
 *     does, so the gate and the mount are checked as shipped.
 *   - "harness": the router factory, createOsRouter({ now, model, commands? }),
 *     behind the real admin gate (adminGate), with an injected clock and a
 *     fake model that records every call and answers from a queue of canned
 *     replies (or errors). Tier 1 never calls the model; tier 2 (#154) calls
 *     it only when no command matches.
 *
 * Everything is asserted through HTTP responses and os_asks rows. Admin JWTs
 * are minted directly. ANTHROPIC_API_KEY is removed from the environment
 * first, so the prod wiring's tier 2 takes the "no key" path and nothing here
 * ever calls the real API. The real Haiku client is tested on its own against
 * a local fake API: scripts/test-os-haiku.ts.
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5546/t146_test npx tsx scripts/test-os-ask.ts
 *
 * Run proposals (#148) have their own "tier 3" sections: `confirm(id, who?,
 * base?)` posts to /admin/os/ask/confirm, `askRow(id)` reads one os_asks row,
 * `createdRuns()` the runs these personas queued, and `clock` is moved to
 * test expiry. The duplicate check is global per skill, so the queue must
 * start empty (checked as a precondition; the runs are deleted at the end).
 * `harness(commands?, deps?)` takes any other router dep, e.g. a failing
 * `enqueue` (the Q harness).
 *
 * Extending it: tier-1 answers (#147) add cases to the "tier 1" section and
 * seed what they read. Tier-2 cases queue canned replies (fakeModel.next,
 * built with `decided()`) and assert on fakeModel.calls: #155 (vault context)
 * checks what the prompt holds, #156 (budget) seeds tier-2 spend on days of
 * its own in November 2030 and caps a harness with the `budgetUsd` dep, and #157
 * replaces the "until #157" cases; its run_skill should produce a proposal
 * the tier-3 checks accept. Don't stop this script with `pkill -f`: it matches the shell's own command line
 * and kills the shell.
 */
import "./use-test-jwt-secret.js";
import express from "express";
import type { AddressInfo } from "net";
import crypto from "crypto";
import pool from "../db/index.js";
import adminRoutes, { adminGate } from "../routes/adminRoutes.js";
import { createOsRouter, type OsRouterDeps } from "../routes/osRoutes.js";
import type { Command } from "../os/ask.js";
import type { Queryable } from "../os/overview.js";
import type { ModelDecision, ModelReply, ModelRequest, ModelUsage, OsModel } from "../os/model.js";
import { signJwt } from "../utils/jwt.js";
import { createTempVault } from "./temp-vault.js";

// Never a real model call: the prod wiring reads the key per ask, so without it tier 2 is unavailable.
delete process.env.ANTHROPIC_API_KEY;
// The daily budget's cases set it themselves; everything else runs at the default cap.
delete process.env.OS_ASK_DAILY_BUDGET_USD;

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

/** A model that records what it was asked and answers from a queue: a reply, or an error to throw. */
const fakeModel: OsModel & { calls: ModelRequest[]; next: (ModelReply | Error)[] } = {
    calls: [],
    next: [],
    async route(req) {
        fakeModel.calls.push(req);
        const reply = fakeModel.next.shift();
        if (!reply) throw new Error("fake model: no canned reply");
        if (reply instanceof Error) throw reply;
        return reply;
    },
};

const USAGE: ModelUsage = { inputTokens: 1200, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 80 };
/** A canned model reply: a decision (null: it didn't parse), a stop reason and usage. */
const decided = (decision: ModelDecision | null, stopReason: string | null = "end_turn",
    usage: ModelUsage | null = USAGE): ModelReply => ({ model: "claude-haiku-5-5", decision, stopReason, usage });

/** The admin pages navigation may reach (an independent list: the nav's admin links). */
const ALLOWED = new Set(["/admin/os", "/admin", "/db", "/admin/cloud-claw", "/admin/obsidian", "/admin/briefs",
    "/admin/alpaca", "/admin/paperclip", "/admin/person-sync", "/admin/profile"]);

async function main() {
    let clock = new Date("2026-10-12T14:00:00Z");

    const prod = express();
    prod.use(express.json());
    prod.use("/admin", adminRoutes);

    /** The router factory behind the real gate; `deps` overrides anything else (e.g. #148's `enqueue`). */
    const harness = (commands?: readonly Command[], deps: OsRouterDeps = {}) => {
        const app = express();
        app.use(express.json());
        app.use("/admin/os", ...adminGate,
            createOsRouter({ now: () => clock, model: fakeModel, ...(commands ? { commands } : {}), ...deps }));
        return listen(app);
    };

    // Two commands that both match "open alpaca": the first must win. One that throws.
    const firstWins: Command[] = [
        { pattern: /^open alpaca$/, intent: "test.first", handler: () => ({ kind: "answer", say: "first" }) },
        { pattern: /^open alpaca$/, intent: "test.second", handler: () => ({ kind: "answer", say: "second" }) },
        { pattern: /^explode$/, intent: "test.explode", handler: () => { throw new Error("handler exploded"); } },
    ];

    // A queue that's down: confirming must not use up the proposal.
    const queueDown = harness(undefined, { enqueue: async () => { throw new Error("queue down"); } });

    const P = await listen(prod), H = await harness(), F = await harness(firstWins), Q = await queueDown;
    // No ANTHROPIC_API_KEY: the router gets no model client.
    const N = await harness(undefined, { model: null });

    const post = async (base: string, path: string, body: unknown, token?: string) => {
        const res = await fetch(`${base}${path}${token ? `?token=${encodeURIComponent(token)}` : ""}`, {
            method: "POST", redirect: "manual",
            headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        const text = await res.text();
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* HTML */ }
        return { status: res.status, body: text, json };
    };
    const get = async (base: string, path: string, token: string) => {
        const res = await fetch(`${base}${path}?token=${encodeURIComponent(token)}`, { redirect: "manual" });
        return { status: res.status, body: await res.text() };
    };

    const tag = crypto.randomBytes(4).toString("hex");
    const created: string[] = [];
    let renamed = false;

    try {
        // ── personas ────────────────────────────────────────────────────────
        let personas = 0;
        const persona = async (role: "admin" | "user") => {
            const n = ++personas;
            const { rows: [row] } = await pool.query(
                `INSERT INTO accounts (id, name, email, password, app_role, app_role_source, is_verified)
                 VALUES (gen_random_uuid(), $1, $2, 'x', $3, 'manual', true) RETURNING id, email`,
                [`t146 ${role} ${n} ${tag}`, `t146-${role}-${n}-${tag}@example.test`, role]);
            created.push(row.id);
            return { id: row.id as string, token: signJwt({ id: row.id, type: "User", email: row.email }) };
        };
        const admin = await persona("admin");
        const user = await persona("user");
        const asks = async () => (await pool.query(
            `SELECT * FROM os_asks WHERE account_id = $1 ORDER BY id`, [admin.id])).rows;
        const ask = (text: unknown, source: unknown = "typed", base = H.base) =>
            post(base, "/admin/os/ask", { text, source }, admin.token);

        // ── tier 1: navigation ──────────────────────────────────────────────
        const navCases: [string, string][] = [
            ["open alpaca", "/admin/alpaca"],
            ["Show the briefs.", "/admin/briefs"],
            ["go to the vault", "/admin/obsidian"],
            ["open obsidian", "/admin/obsidian"],
            ["take me to my profile", "/admin/profile"],
            ["open paperclip", "/admin/paperclip"],
            ["Open Cloud-Claw", "/admin/cloud-claw"],
            ["go to the dashboard", "/admin"],
            ["show person sync", "/admin/person-sync"],
            ["open the shop", "/db"],
            ["go home", "/admin/os"],
            ["  PLEASE, open ALPACA!!  ", "/admin/alpaca"],
            ["can you pull up the trading page", "/admin/alpaca"],
        ];
        const navigatedTo: unknown[] = [];
        for (const [text, url] of navCases) {
            const r = await ask(text, text.startsWith("go") ? "voice" : "typed");
            navigatedTo.push(r.json?.url);
            check(`"${text}" navigates to ${url} at tier 1, with something to say`,
                r.status === 200 && r.json?.tier === 1 && r.json.kind === "navigate" && r.json.url === url
                    && typeof r.json.say === "string" && r.json.say.length > 0 && !("confirmation" in r.json),
                { status: r.status, json: r.json });
        }

        check("no tier-1 match called the model", fakeModel.calls.length === 0, fakeModel.calls.length);

        // ── no match: tier 2, and still nowhere off the allowlist ───────────
        const unmatched = ["what's the weather", "open google.com", "go to evil.example.com/admin",
            "open /etc/passwd", "open", "navigate to https://example.com", "run", "run the weather", "run alpaca"];
        for (const text of unmatched) {
            fakeModel.next.push(decided({ action: "cannot_answer", say: "I can't help with that from here." }));
            const r = await ask(text);
            check(`"${text}" goes to tier 2, which can't answer it, with no url`,
                r.status === 200 && r.json?.tier === 2 && r.json.kind === "not_understood" && !("url" in r.json)
                    && r.json.say === "I can't help with that from here.", r.json);
        }
        check("each unmatched ask called the model once, with its own text as the question",
            fakeModel.calls.length === unmatched.length
                && fakeModel.calls.every((c, i) => c.question === unmatched[i]), fakeModel.calls.map((c) => c.question));

        // ── the ask log ─────────────────────────────────────────────────────
        const rows = await asks();
        const total = navCases.length + unmatched.length;
        check("every ask wrote one os_asks row for the asking account", rows.length === total,
            `${rows.length} rows for ${total} asks`);
        check("every row has its tier, kind, a non-negative latency and the injected clock's time",
            rows.every((r) => r.tier === (unmatched.includes(r.text) ? 2 : 1) && Number.isInteger(r.latency_ms)
                && r.latency_ms >= 0 && new Date(r.asked_at).getTime() === clock.getTime()),
            rows.map((r) => ({ tier: r.tier, latency: r.latency_ms, at: r.asked_at })));
        const alpaca = rows.find((r) => r.text === "PLEASE, open ALPACA!!");
        check("the row keeps the trimmed text as asked, the source, the kind and the navigation intent",
            alpaca?.source === "typed" && alpaca.kind === "navigate" && alpaca.intent === "navigate.alpaca"
                && alpaca.error === null && alpaca.model === null && alpaca.skill === null, alpaca);
        check("a voice ask is logged as voice", rows.find((r) => r.text === "go to the vault")?.source === "voice");
        const none = rows.find((r) => r.text === "what's the weather");
        check("an unmatched ask the model can't answer is logged as tier 2 not_understood, with the model's action",
            none?.tier === 2 && none.kind === "not_understood" && none.intent === "model.cannot_answer"
                && none.model === "claude-haiku-5-5" && none.error === null, none);
        check("every navigate response's url is an allowlisted admin page",
            navigatedTo.every((u) => typeof u === "string" && ALLOWED.has(u)), navigatedTo);

        // ── validation: not an ask, so no row ───────────────────────────────
        const before = (await asks()).length;
        const bad: [string, unknown, unknown][] = [
            ["empty text", "", "typed"],
            ["blank text", "   ", "typed"],
            ["text that isn't a string", 42, "typed"],
            ["text over 500 characters", "a".repeat(501), "typed"],
            ["an unknown source", "open alpaca", "shout"],
            ["no source", "open alpaca", undefined],
        ];
        for (const [name, text, source] of bad) {
            const r = await post(H.base, "/admin/os/ask", { text, source }, admin.token);
            check(`${name} is a 400 with a JSON error`, r.status === 400 && typeof r.json?.error === "string",
                { status: r.status, body: r.body.slice(0, 120) });
        }
        // The x's match no command, so this one reaches tier 2. (The emoji normalise away: "open alpaca".)
        fakeModel.next.push(decided({ action: "cannot_answer", say: "No." }));
        const exactly500 = await ask(`open alpaca ${"x".repeat(488)}`);
        check("500 characters is accepted", exactly500.status === 200, exactly500.status);
        // 500 characters, but 988 UTF-16 units: counted as characters, as os_asks counts them.
        const emoji500 = await ask(`open alpaca ${"\u{1F600}".repeat(488)}`);
        check("500 characters of emoji is accepted too", emoji500.status === 200, emoji500);
        const emoji501 = await ask(`open alpaca ${"\u{1F600}".repeat(489)}`);
        check("501 characters of emoji is a 400", emoji501.status === 400, emoji501.status);
        check("rejected asks wrote no row (the two 500-character ones did)", (await asks()).length === before + 2);

        // ── the command table: first match wins; a failing handler degrades ─
        const first = await ask("open alpaca", "typed", F.base);
        check("with two commands matching, the first one in the table answers",
            first.json?.kind === "answer" && first.json.say === "first" && first.json.tier === 1, first.json);
        const boom = await ask("explode", "typed", F.base);
        const boomRow = (await asks()).at(-1);
        check("a handler that throws gives `unavailable` at tier 1, not a 500",
            boom.status === 200 && boom.json?.kind === "unavailable" && boom.json.tier === 1
                && typeof boom.json.say === "string", { status: boom.status, json: boom.json });
        check("... and its row records the error", boomRow?.kind === "unavailable" && boomRow.intent === "test.explode"
            && /handler exploded/.test(boomRow.error ?? ""), boomRow);

        // ── the ask log can't take navigation down ──────────────────────────
        await pool.query(`ALTER TABLE os_asks RENAME TO os_asks_t146_renamed`);
        renamed = true;
        const noLog = await ask("open alpaca");
        check("with the ask log missing (migration not applied), navigation still answers",
            noLog.status === 200 && noLog.json?.kind === "navigate" && noLog.json.url === "/admin/alpaca", noLog);
        // A proposal IS its row: with nowhere to keep it, there's nothing to confirm, so the ask fails.
        const noProposal = await ask("run the brief");
        check("with the ask log missing, a run ask fails as `unavailable` with no confirmation to tap",
            noProposal.status === 200 && noProposal.json?.kind === "unavailable" && noProposal.json.tier === 1
                && !("confirmation" in noProposal.json) && typeof noProposal.json.say === "string", noProposal.json);
        await pool.query(`ALTER TABLE os_asks_t146_renamed RENAME TO os_asks`);
        renamed = false;

        // ── gate ────────────────────────────────────────────────────────────
        const beforeGate = (await pool.query(`SELECT count(*)::int AS n FROM os_asks`)).rows[0].n;
        for (const [label, base] of [["prod wiring", P.base], ["harness", H.base]] as const) {
            const anon = await post(base, "/admin/os/ask", { text: "open alpaca", source: "typed" });
            const nonAdmin = await post(base, "/admin/os/ask", { text: "open alpaca", source: "typed" }, user.token);
            check(`${label}: no token is redirected to login`, anon.status === 302, anon.status);
            check(`${label}: a non-admin JWT gets the gate's 403 and no answer`,
                nonAdmin.status === 403 && nonAdmin.json === null && !/navigate/.test(nonAdmin.body),
                { status: nonAdmin.status, body: nonAdmin.body.slice(0, 120) });
        }
        check("turned-away asks wrote no row",
            (await pool.query(`SELECT count(*)::int AS n FROM os_asks`)).rows[0].n === beforeGate);
        const shipped = await ask("show the briefs", "typed", P.base);
        check("the shipped admin router serves the ask endpoint at /admin/os/ask",
            shipped.status === 200 && shipped.json?.kind === "navigate" && shipped.json.url === "/admin/briefs", shipped.json);

        // ── the page ────────────────────────────────────────────────────────
        const page = await get(H.base, "/admin/os", admin.token);
        check("the overview has an ask box (a form, a 500-character text input and a reply area)",
            page.status === 200 && /<form[^>]*id="ask-form"/.test(page.body)
                && /<input[^>]*id="ask-text"[^>]*maxlength="500"/.test(page.body)
                && /id="ask-reply"[^>]*aria-live="polite"/.test(page.body), page.status);
        check("the page posts asks to /admin/os/ask and speaks replies with speechSynthesis, with no CDN scripts",
            /\/admin\/os\/ask/.test(page.body) && /speechSynthesis/.test(page.body) && !/<script[^>]+src=/.test(page.body));

        // ── tier 3: run proposals (#148) ────────────────────────────────────
        const callsBeforeTier3 = fakeModel.calls.length;
        // The duplicate check is global per skill, so the queue must start empty.
        const live = (await pool.query(`SELECT skill FROM agent_runs WHERE status IN ('queued','running')`)).rows;
        check("(precondition) no run is queued or running", live.length === 0, live);
        const createdRuns = async () => (await pool.query(
            `SELECT * FROM agent_runs WHERE requested_by = ANY($1::text[]) ORDER BY id`, [created])).rows;
        const askRow = async (id: unknown) => (await pool.query(`SELECT * FROM os_asks WHERE id = $1`, [id])).rows[0];
        const confirm = (id: unknown, who: { token: string } = admin, base = H.base) =>
            post(base, "/admin/os/ask/confirm", { id }, who.token);
        const TTL_MS = 2 * 60_000;

        const runCases: [string, string, string, string][] = [
            ["run my morning brief", "morning-brief", "Morning brief", "Run the morning brief?"],
            ["Run the brief", "morning-brief", "Morning brief", "Run the morning brief?"],
            ["run morning brief", "morning-brief", "Morning brief", "Run the morning brief?"],
            ["Run ingest debrief.", "ingest-debrief", "Ingest debrief", "Run the ingest debrief?"],
            ["run the lint wiki", "lint-wiki", "Lint wiki", "Run the lint wiki?"],
            ["please run the weekly review", "weekly-review", "Weekly review", "Run the weekly review?"],
            ["Can you run my weekly review?", "weekly-review", "Weekly review", "Run the weekly review?"],
        ];
        clock = new Date("2026-10-12T15:00:00Z");
        const proposals: Record<string, any> = {};
        for (const [text, skill, label, say] of runCases) {
            const r = await ask(text, "voice");
            const c = r.json?.confirmation;
            const row = c ? await askRow(c.id) : null;
            proposals[text] = c;
            check(`"${text}" proposes ${skill} at tier 3 and asks "${say}"`,
                r.status === 200 && r.json?.tier === 3 && r.json.kind === "confirm_run" && r.json.say === say
                    && !("url" in r.json) && Number.isInteger(c?.id) && c.skill === skill && c.label === label
                    && new Date(c.expiresAt).getTime() === clock.getTime() + TTL_MS, r.json);
            check(`... and its os_asks row is the proposal (${skill}, 2-minute expiry, unconfirmed)`,
                row?.account_id === admin.id && row.tier === 3 && row.kind === "confirm_run" && row.skill === skill
                    && row.intent === `run.${skill}` && row.source === "voice" && row.text === text
                    && new Date(row.expires_at).getTime() === clock.getTime() + TTL_MS
                    && row.confirmed_at === null && row.run_id === null && row.error === null, row);
        }
        check("proposing queues nothing", (await createdRuns()).length === 0, await createdRuns());

        // ── tier 3: confirmation ────────────────────────────────────────────
        // Confirm at 1:59 of the 2 minutes: still good.
        clock = new Date(clock.getTime() + TTL_MS - 1000);
        const brief = proposals["Run the brief"];
        const queued = await confirm(brief.id);
        const briefRow = await askRow(brief.id);
        check("confirming queues the run and returns it (201, created)",
            queued.status === 201 && queued.json?.created === true && queued.json.run?.skill === "morning-brief"
                && queued.json.run.status === "queued" && typeof queued.json.say === "string", queued.json);
        check("... records confirmed_at (the injected clock) and run_id on the proposal",
            briefRow?.run_id === queued.json?.run?.id && new Date(briefRow.confirmed_at).getTime() === clock.getTime(), briefRow);
        const again = await confirm(brief.id);
        check("a second confirm of the same proposal gets 409", again.status === 409 && typeof again.json?.error === "string", again);
        check("... and the run was queued exactly once",
            (await createdRuns()).filter((r) => r.skill === "morning-brief").length === 1, await createdRuns());

        // Same skill, still queued: the RUN button's duplicate check hands back the queued run.
        const other = proposals["run my morning brief"];
        const dup = await confirm(other.id);
        check("confirming a skill that's already queued returns the existing run (200, not created)",
            dup.status === 200 && dup.json?.created === false && dup.json.run?.id === queued.json?.run?.id, dup.json);
        check("... and links that run to the proposal", (await askRow(other.id))?.run_id === queued.json?.run?.id);
        check("... and still only one morning-brief run exists",
            (await createdRuns()).filter((r) => r.skill === "morning-brief").length === 1);

        // The RUN button and a confirm share the queue: a run queued by the button is the one a confirm returns.
        const button = await post(P.base, "/admin/briefs/runs", { skill: "lint-wiki" }, admin.token);
        const lint = await confirm(proposals["run the lint wiki"].id);
        check("a run queued by the RUN button is the one a confirm returns",
            button.status === 201 && lint.status === 200 && lint.json?.created === false
                && lint.json.run?.id === button.json?.run?.id, { button: button.json, lint: lint.json });

        // Another admin can't confirm (or see) this admin's proposal.
        const otherAdmin = await persona("admin");
        const ingest = proposals["Run ingest debrief."];
        const foreign = await confirm(ingest.id, otherAdmin);
        check("another admin's proposal id gets 404", foreign.status === 404 && typeof foreign.json?.error === "string", foreign);
        check("... and doesn't use it up", (await askRow(ingest.id))?.confirmed_at === null);

        // The queue is down: 500, and the proposal is still there to confirm.
        const down = await confirm(ingest.id, admin, Q.base);
        check("when the enqueue fails, confirm is a 500 and the proposal stays unconfirmed",
            down.status === 500 && (await askRow(ingest.id))?.confirmed_at === null, { status: down.status, json: down.json });
        const ingestOk = await confirm(ingest.id);
        check("... so a retry confirms it", ingestOk.status === 201 && ingestOk.json?.run?.skill === "ingest-debrief", ingestOk.json);

        // Exactly two minutes on: expired.
        clock = new Date(new Date("2026-10-12T15:00:00Z").getTime() + TTL_MS);
        const weekly = proposals["please run the weekly review"];
        const expired = await confirm(weekly.id);
        check("an expired proposal gets 410", expired.status === 410 && typeof expired.json?.error === "string", expired);
        check("... queues nothing and stays unconfirmed",
            !(await createdRuns()).some((r) => r.skill === "weekly-review") && (await askRow(weekly.id))?.confirmed_at === null);
        check("a confirmed proposal confirmed again after expiry is still 409", (await confirm(brief.id)).status === 409);

        // Ids that aren't this admin's proposals.
        const navRow = (await asks()).find((r) => r.kind === "navigate");
        for (const [name, id, status] of [
            ["an unknown id", 999_999_999, 404], ["a navigation ask's id", navRow?.id, 404],
            ["a missing id", undefined, 400], ["a non-numeric id", "abc", 400], ["a fractional id", 1.5, 400],
            ["a negative id", -1, 400],
        ] as const) {
            const r = await confirm(id);
            check(`confirming ${name} is a ${status} with a JSON error`, r.status === status && typeof r.json?.error === "string",
                { status: r.status, body: r.body.slice(0, 120) });
        }

        // Gate on the confirm endpoint.
        // Proposed through the shipped router, on the real clock, so it is still live when confirmed there.
        const fresh = (await ask("run the lint wiki", "typed", P.base)).json?.confirmation;
        for (const [label, base] of [["prod wiring", P.base], ["harness", H.base]] as const) {
            const anon = await post(base, "/admin/os/ask/confirm", { id: fresh?.id });
            const nonAdmin = await confirm(fresh?.id, user, base);
            check(`${label}: confirm with no token is redirected to login`, anon.status === 302, anon.status);
            check(`${label}: confirm as a non-admin gets the gate's 403`, nonAdmin.status === 403 && nonAdmin.json === null, nonAdmin.status);
        }
        check("... and neither used up the proposal", (await askRow(fresh?.id))?.confirmed_at === null);
        const shippedConfirm = await confirm(fresh?.id, admin, P.base);
        check("the shipped admin router serves POST /admin/os/ask/confirm",
            shippedConfirm.status === 200 && shippedConfirm.json?.run?.skill === "lint-wiki", shippedConfirm.json);

        // "Yes" with nothing pending in the page reaches the router.
        for (const text of ["yes", "Yes!", "confirm", "do it"]) {
            const r = await ask(text, "voice");
            check(`"${text}" answers "Nothing to confirm" at tier 1`,
                r.status === 200 && r.json?.tier === 1 && r.json.kind === "answer" && /^Nothing to confirm\.?$/.test(r.json.say)
                    && !("confirmation" in r.json), r.json);
        }

        // The page: Confirm and Cancel for a pending proposal.
        const withConfirm = await get(H.base, "/admin/os", admin.token);
        check("the page has Confirm and Cancel buttons and posts confirmations to /admin/os/ask/confirm",
            /<button[^>]*id="ask-confirm-yes"/.test(withConfirm.body) && /<button[^>]*id="ask-confirm-no"/.test(withConfirm.body)
                && /\/admin\/os\/ask\/confirm/.test(withConfirm.body));

        check("no tier-3 ask called the model", fakeModel.calls.length === callsBeforeTier3, fakeModel.calls.length);

        // ── tier 2: an answer ───────────────────────────────────────────────
        const lastRow = async () => (await asks()).at(-1);
        const near = (a: unknown, b: number) => Math.abs(Number(a) - b) < 1e-9;
        fakeModel.calls.length = 0;
        // The overview the model will see, read first: afterwards the usage tile's tier-2 spend includes this ask.
        const overviewJson = await (await fetch(`${H.base}/admin/os/api/overview?token=${encodeURIComponent(admin.token)}`)).text();
        fakeModel.next.push(decided({ action: "answer", say: "Two tasks are due today." }, "end_turn",
            { inputTokens: 10_000, cacheReadTokens: 20_000, cacheWriteTokens: 4_000, outputTokens: 1_000 }));
        const answered = await ask("  What's due today?  ", "voice");
        const answeredRow = await lastRow();
        check("an open question gets the model's answer, to speak and show, at tier 2",
            answered.status === 200 && answered.json?.tier === 2 && answered.json.kind === "answer"
                && answered.json.say === "Two tasks are due today." && !("url" in answered.json)
                && !("confirmation" in answered.json), answered.json);
        check("its row: tier 2, kind answer, the model's action as the intent, the model id, no error",
            answeredRow?.tier === 2 && answeredRow.kind === "answer" && answeredRow.intent === "model.answer"
                && answeredRow.model === "claude-haiku-5-5" && answeredRow.error === null
                && answeredRow.source === "voice" && answeredRow.text === "What's due today?", answeredRow);
        // $0.10/MTok input, cache reads at 0.1x, cache writes at 1.25x, $0.50/MTok output:
        // 0.001 + 0.0002 + 0.0005 + 0.0005.
        check("its cost is priced from usage at the rate card: $0.0022", near(answeredRow?.cost_usd, 0.0022),
            answeredRow?.cost_usd);
        check("its tokens are logged: input counts uncached, cache reads and cache writes (34,000), output 1,000",
            Number(answeredRow?.input_tokens) === 34_000 && Number(answeredRow?.output_tokens) === 1_000,
            { input: answeredRow?.input_tokens, output: answeredRow?.output_tokens });
        check("its latency is logged", Number.isInteger(answeredRow?.latency_ms) && answeredRow.latency_ms >= 0);

        // ── tier 2: the prompt ──────────────────────────────────────────────
        const firstCall = fakeModel.calls.at(-1)!;
        check("the model gets the trimmed question, a system prompt and the overview JSON as its context",
            fakeModel.calls.length === 1 && firstCall.question === "What's due today?" && firstCall.system.length > 0
                && firstCall.context.includes(overviewJson), { question: firstCall.question, context: firstCall.context.slice(0, 300) });
        const earlier = clock;
        clock = new Date(clock.getTime() + 3_600_000);
        fakeModel.next.push(decided({ action: "answer", say: "Flat." }));
        await ask("how is the book doing");
        const laterCall = fakeModel.calls.at(-1)!;
        check("the system prompt is stable: the same an hour later for another question, and holds neither",
            laterCall.system === firstCall.system && !firstCall.system.includes("due today")
                && !firstCall.system.includes(earlier.toISOString()) && laterCall.context !== firstCall.context);
        clock = earlier;

        fakeModel.next.push(decided({ action: "answer", say: "Long." }, "end_turn",
            { inputTokens: 150_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2_000 }));
        await ask("summarise everything");
        // Over 100K prompt tokens: $0.50/MTok input and $2.50/MTok output. 0.075 + 0.005.
        check("a prompt over 100K tokens is priced at the long-prompt rate card: $0.08",
            near((await lastRow())?.cost_usd, 0.08), (await lastRow())?.cost_usd);

        // ── tier 2: navigate and run_skill wait for #157 ────────────────────
        const until157: [string, ModelDecision][] = [
            ["navigate", { action: "navigate", say: "Opening Alpaca.", page: "alpaca" }],
            ["run_skill", { action: "run_skill", say: "Running the morning brief.", skill: "morning-brief" }],
        ];
        for (const [action, decision] of until157) {
            fakeModel.next.push(decided(decision));
            const r = await ask(`could you maybe do the ${action} thing`);
            const row = await lastRow();
            check(`until #157, a ${action} decision is answered as can't-answer: no url, no proposal, not its say`,
                r.json?.tier === 2 && r.json.kind === "not_understood" && !("url" in r.json) && !("confirmation" in r.json)
                    && r.json.say !== decision.say, r.json);
            check(`... and logged with the model's action`, row?.intent === `model.${action}` && row.skill === null
                && row.expires_at === null && row.error === null, row);
        }

        // ── tier 2: failures ────────────────────────────────────────────────
        const failures: [string, ModelReply | Error, RegExp, boolean][] = [
            ["a refusal", decided(null, "refusal"), /refusal/, true],
            ["running out of tokens", decided(null, "max_tokens"), /max_tokens/, true],
            ["a timeout", Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" }), /timed out/i, false],
            ["output that didn't parse", decided(null), /malformed/, true],
            ["a page off the allowlist", decided({ action: "navigate", say: "Opening.", page: "evil" } as any), /malformed/, true],
            ["a skill that isn't runnable", decided({ action: "run_skill", say: "Running.", skill: "rm-rf" } as any), /malformed/, true],
            ["an action outside the schema", decided({ action: "delete_everything", say: "Done." } as any), /malformed/, true],
            ["an empty answer", decided({ action: "answer", say: "   " }), /malformed/, true],
        ];
        for (const [name, canned, error, billed] of failures) {
            fakeModel.next.push(canned);
            const r = await ask(`what about ${name}`);
            const row = await lastRow();
            check(`${name} gives "I couldn't answer that", unavailable at tier 2`,
                r.status === 200 && r.json?.tier === 2 && r.json.kind === "unavailable"
                    && /couldn.t answer that/i.test(r.json.say) && !("url" in r.json), r.json);
            check(`... and is logged with its error${billed ? " and what it cost" : ""}`,
                row?.tier === 2 && row.kind === "unavailable" && error.test(row.error ?? "")
                    && (billed ? row.model === "claude-haiku-5-5" && Number(row.cost_usd) > 0 : row.cost_usd === null), row);
        }

        // ── tier 2 without an API key ───────────────────────────────────────
        const callsBefore = fakeModel.calls.length;
        const noKeyNav = await ask("open alpaca", "typed", N.base);
        check("without an API key, tier 1 still works", noKeyNav.json?.tier === 1 && noKeyNav.json.kind === "navigate"
            && noKeyNav.json.url === "/admin/alpaca", noKeyNav.json);
        const noKey = await ask("what's due today", "typed", N.base);
        const noKeyRow = await lastRow();
        check("without an API key, an open question gets tier 2 `unavailable`, with something to say",
            noKey.status === 200 && noKey.json?.tier === 2 && noKey.json.kind === "unavailable"
                && typeof noKey.json.say === "string" && noKey.json.say.length > 0, noKey.json);
        check("... logged with the missing key as its error, and no model or cost", noKeyRow?.tier === 2
            && /ANTHROPIC_API_KEY/.test(noKeyRow.error ?? "") && noKeyRow.model === null && noKeyRow.cost_usd === null, noKeyRow);
        const shippedNoKey = await ask("what's due today", "typed", P.base);
        check("the shipped router reads the key: with it unset, tier 2 is unavailable",
            shippedNoKey.json?.tier === 2 && shippedNoKey.json.kind === "unavailable", shippedNoKey.json);
        check("no model was called without a key", fakeModel.calls.length === callsBefore);

        // ── tier 2: the daily budget (#156) ─────────────────────────────────
        // Spend is every priced model call logged in os_asks on the ask's
        // Central day, whoever asked. Each case sits on its own November 2030
        // day, far from the cases above (Oct 12) and from the real clock, so
        // seeded spend never leaks between them. B caps at $0.05.
        const B = await harness(undefined, { budgetUsd: 0.05 });
        try {
            const spend = (at: Date, cost: number, accountId = admin.id, tier = 2) => pool.query(
                `INSERT INTO os_asks (account_id, asked_at, text, source, tier, kind, intent, latency_ms, model, cost_usd)
                 VALUES ($1, $2, 't156 seeded spend', 'typed', $3, 'answer', 'model.answer', 0, 'claude-haiku-5-5', $4)`,
                [accountId, at, tier, cost]);
            const budgetAsk = (text: string, base = B.base) => ask(text, "typed", base);
            const reachedReply = (r: any) => r.status === 200 && r.json?.tier === 2 && r.json.kind === "unavailable"
                && /budget/i.test(r.json.say) && /reached/i.test(r.json.say) && !("url" in r.json);

            // Tue Nov 19, 2030 (CST, UTC-6): the Central day is 06:00Z to 06:00Z.
            clock = new Date("2030-11-19T18:00:00Z");
            // Under the cap: $0.04 today, from both admins' asks (spend is global, not per account).
            await spend(new Date("2030-11-19T06:00:00Z"), 0.03, user.id);
            await spend(new Date("2030-11-19T17:00:00Z"), 0.01);
            // Yesterday (23:59:59 CST on the 18th) doesn't count, however big.
            await spend(new Date("2030-11-19T05:59:59Z"), 5);
            let calls = fakeModel.calls.length;
            // (This call reports no usage, so it adds nothing: the seeded rows are today's whole spend.)
            fakeModel.next.push(decided({ action: "answer", say: "Under budget." }, "end_turn", null));
            const under = await budgetAsk("how much budget is left");
            check("under the cap ($0.04 of $0.05 today; yesterday's $5 doesn't count), tier 2 calls the model",
                under.json?.tier === 2 && under.json.kind === "answer" && under.json.say === "Under budget."
                    && fakeModel.calls.length === calls + 1, under.json);

            // At the cap exactly: below is required, so $0.05 of $0.05 is reached.
            await spend(new Date("2030-11-19T17:30:00Z"), 0.01);
            const today = (await pool.query(
                `SELECT sum(cost_usd)::float8 AS s FROM os_asks WHERE asked_at >= '2030-11-19T06:00:00Z' AND asked_at < '2030-11-20T06:00:00Z'`)).rows[0].s;
            calls = fakeModel.calls.length;
            const reached = await budgetAsk("what is the meaning of life");
            const reachedRow = await lastRow();
            check(`with seeded spend at the cap ($${today} of $0.05), tier 2 isn't called and the reply is "budget reached"`,
                Math.abs(today - 0.05) < 1e-12 && reachedReply(reached) && fakeModel.calls.length === calls,
                { today, reply: reached.json, calls: fakeModel.calls.length - calls });
            check("... logged as tier 2 unavailable with the budget as its error, and no model or cost",
                reachedRow?.tier === 2 && reachedRow.kind === "unavailable" && /budget/i.test(reachedRow.error ?? "")
                    && /\$0\.05/.test(reachedRow.error ?? "") && reachedRow.model === null && reachedRow.cost_usd === null
                    && reachedRow.text === "what is the meaning of life", reachedRow);
            const reachedNav = await budgetAsk("open alpaca");
            check("with the budget reached, tier 1 still works",
                reachedNav.json?.tier === 1 && reachedNav.json.kind === "navigate" && reachedNav.json.url === "/admin/alpaca"
                    && fakeModel.calls.length === calls, reachedNav.json);
            await spend(new Date("2030-11-19T17:45:00Z"), 0.5);
            check("over the cap it stays reached", reachedReply(await budgetAsk("and now?")) && fakeModel.calls.length === calls);

            // Reset at the Central day boundary, across the end of DST: Sun Nov 3, 2030 began at
            // 05:00Z (CDT) and ended at Mon Nov 4 06:00Z (CST), a 25-hour day.
            await spend(new Date("2030-11-03T05:00:00Z"), 0.05);
            calls = fakeModel.calls.length;
            clock = new Date("2030-11-03T04:59:59Z");
            fakeModel.next.push(decided({ action: "answer", say: "Saturday night." }));
            const satNight = await budgetAsk("is it still saturday");
            check("the last second of Sat Nov 2 (Central) doesn't see Sunday's spend",
                satNight.json?.kind === "answer" && fakeModel.calls.length === calls + 1, satNight.json);
            clock = new Date("2030-11-04T05:30:00Z"); // 23:30 CST on Sunday: a fixed UTC-5 day would have reset already
            calls = fakeModel.calls.length;
            check("23:30 Central on the 25-hour DST day is still that day: the budget stays reached",
                reachedReply(await budgetAsk("is it still sunday")) && fakeModel.calls.length === calls);
            clock = new Date("2030-11-04T06:00:00Z"); // Central midnight: Monday
            fakeModel.next.push(decided({ action: "answer", say: "A new day." }));
            const monday = await budgetAsk("is it monday yet");
            check("at Central midnight the spend resets and tier 2 calls the model again",
                monday.json?.tier === 2 && monday.json.kind === "answer" && monday.json.say === "A new day."
                    && fakeModel.calls.length === calls + 1, monday.json);

            // The model's own logged calls fill the budget, with no seeding: Nov 24.
            const tight = await harness(undefined, { budgetUsd: 0.001 });
            try {
                clock = new Date("2030-11-24T18:00:00Z");
                // 5,000 input at $0.10/MTok + 200 output at $0.50/MTok = $0.0006 a call.
                const pricey: ModelUsage = { inputTokens: 5_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 200 };
                calls = fakeModel.calls.length;
                const kinds: string[] = [];
                for (let i = 1; i <= 3; i++) {
                    if (i < 3) fakeModel.next.push(decided({ action: "answer", say: `Answer ${i}.` }, "end_turn", pricey));
                    const r = await ask(`question number ${i}`, "typed", tight.base);
                    kinds.push(r.json?.kind);
                }
                check("logged model calls count against the cap: $0 and $0.0006 are under $0.001, $0.0012 isn't",
                    kinds.join() === "answer,answer,unavailable" && fakeModel.calls.length === calls + 2, kinds);
            } finally { tight.server.close(); }

            // The default and the env var, resolved per ask: Nov 25.
            const D = await harness();
            try {
                clock = new Date("2030-11-25T18:00:00Z");
                await spend(new Date("2030-11-25T12:00:00Z"), 0.24);
                calls = fakeModel.calls.length;
                delete process.env.OS_ASK_DAILY_BUDGET_USD;
                fakeModel.next.push(decided({ action: "answer", say: "Fine." }, "end_turn", null));
                const def = await ask("under the default", "typed", D.base);
                await spend(new Date("2030-11-25T12:01:00Z"), 0.01);
                const atDefault = await ask("at the default", "typed", D.base);
                check("the default cap is $0.25: $0.24 is under it, $0.25 reaches it",
                    def.json?.kind === "answer" && reachedReply(atDefault) && fakeModel.calls.length === calls + 1,
                    { def: def.json, atDefault: atDefault.json });
                process.env.OS_ASK_DAILY_BUDGET_USD = "0.50";
                fakeModel.next.push(decided({ action: "answer", say: "Raised." }, "end_turn", null));
                const raised = await ask("with a raised cap", "typed", D.base);
                check("OS_ASK_DAILY_BUDGET_USD raises the cap, read on each ask",
                    raised.json?.kind === "answer" && fakeModel.calls.length === calls + 2, raised.json);
                process.env.OS_ASK_DAILY_BUDGET_USD = "0";
                check("OS_ASK_DAILY_BUDGET_USD=0 turns tier 2 off",
                    reachedReply(await ask("with no budget", "typed", D.base)) && fakeModel.calls.length === calls + 2);
                for (const bad of ["lots", "-1", "Infinity", ""]) {
                    process.env.OS_ASK_DAILY_BUDGET_USD = bad;
                    check(`a malformed OS_ASK_DAILY_BUDGET_USD (${JSON.stringify(bad)}) falls back to the $0.25 default`,
                        reachedReply(await ask(`with a cap of ${bad || "nothing"}`, "typed", D.base))
                            && fakeModel.calls.length === calls + 2);
                }
            } finally {
                delete process.env.OS_ASK_DAILY_BUDGET_USD;
                D.server.close();
            }

            // Spend that can't be read is spend that can't be capped: tier 2 stays shut. Nov 27.
            clock = new Date("2030-11-27T18:00:00Z");
            await pool.query(`ALTER TABLE os_asks RENAME TO os_asks_t156_renamed`);
            renamed = true;
            calls = fakeModel.calls.length;
            const unread = await budgetAsk("can you check the budget");
            check("with the ask log missing, tier 2 isn't called and says it's unavailable",
                unread.status === 200 && unread.json?.tier === 2 && unread.json.kind === "unavailable"
                    && typeof unread.json.say === "string" && unread.json.say.length > 0 && fakeModel.calls.length === calls, unread.json);
            await pool.query(`ALTER TABLE os_asks_t156_renamed RENAME TO os_asks`);
            renamed = false;

            // A cost that isn't a number (numeric takes NaN, and the CHECK lets it through): still shut.
            await spend(new Date("2030-11-27T12:00:00Z"), NaN);
            const nanSpend = await budgetAsk("is the budget a number");
            check("with a NaN cost in today's log, tier 2 isn't called and says it's unavailable",
                nanSpend.json?.tier === 2 && nanSpend.json.kind === "unavailable" && fakeModel.calls.length === calls
                    && /budget check failed/.test((await lastRow())?.error ?? ""), nanSpend.json);

            // A priced call whose row doesn't get written still counts (held in memory). Nov 28.
            const insertsFail: Queryable = {
                query: (text: string, params?: unknown[]) => /^\s*INSERT INTO os_asks/.test(text)
                    ? Promise.reject(new Error("t156: os_asks insert refused"))
                    : pool.query(text, params as any[]),
            } as Queryable;
            const unlogged = await harness(undefined, { budgetUsd: 0.001, db: insertsFail });
            try {
                clock = new Date("2030-11-28T18:00:00Z");
                const pricey: ModelUsage = { inputTokens: 5_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 200 };
                const kinds: string[] = [];
                for (let i = 1; i <= 3; i++) {
                    if (i < 3) fakeModel.next.push(decided({ action: "answer", say: `Unlogged ${i}.` }, "end_turn", pricey));
                    kinds.push((await ask(`unlogged question ${i}`, "typed", unlogged.base)).json?.kind);
                }
                const rowsThatDay = (await pool.query(
                    `SELECT count(*)::int AS n FROM os_asks WHERE asked_at >= '2030-11-28T06:00:00Z' AND asked_at < '2030-11-29T06:00:00Z'`)).rows[0].n;
                check("priced calls whose ask row fails to write still count against the cap",
                    kinds.join() === "answer,answer,unavailable" && rowsThatDay === 0 && fakeModel.calls.length === calls + 2,
                    { kinds, rowsThatDay });
            } finally { unlogged.server.close(); }
        } finally {
            B.server.close();
        }

        // ── the brief, read aloud (#152) ────────────────────────────────────
        // Fixture briefs in a temporary vault, on days of their own in March 2031.
        const sayVault = createTempVault("t152");
        const sayVaultBefore = process.env.OBSIDIAN_VAULT_PATH;
        const sayClockBefore = clock;
        process.env.OBSIDIAN_VAULT_PATH = sayVault.dir;
        try {
            const SAY_PROSE = "Good morning. First, the deploy is red. Second, reply to Sam. Third, PPI lands at 8:30.";
            const SAY_CANARY = "t152-say-canary";
            const TOP3 = "## Top 3\n"
                + "1. **Overdue: ship the [invite button](https://example.com/x).** Still *in progress*\n"
                + "   since May.\n"
                + "2. Rotate `VAULT_TOKEN` before [[projects/personal-web-app/index|PersonalWebApp]] sync breaks.\n"
                + "   - a sub-point, folded into its item\n"
                + "3. Check [[projects/alpaca-trading-bot/market-state]] _today_!\n";
            const TOP3_SPOKEN = "Overdue: ship the invite button. Still in progress since May.\n"
                + "Rotate VAULT_TOKEN before PersonalWebApp sync breaks. a sub-point, folded into its item.\n"
                + "Check market-state today!";
            // Today (Central) is 2031-03-10: a Say block written the way V#11 writes it (last, after a blank line).
            sayVault.writeBrief("2031-03-10", { status: "ok" },
                `# Morning Brief\n\n${TOP3}\n## Calendar\n- Nothing today.\n\n## Say\n\n`
                + `Good morning. First, the deploy is red.\nSecond, reply to Sam. Third, PPI lands at 8:30.\n\n<!-- ${SAY_CANARY} -->\n`);
            // No Say block: the Top 3 fallback.
            sayVault.writeBrief("2031-03-07", { status: "partial" }, `# Morning Brief\n\n${TOP3}\n## Calendar\n- Lunch.\n`);
            // Neither.
            sayVault.writeBrief("2031-03-06", {}, "# Morning Brief\n\n## Calendar\n- Lunch.\n");
            // A Say block in the middle (other case, CRLF) ends at the next heading; one with two paragraphs.
            sayVault.writeBrief("2031-03-05", {},
                "# Morning Brief\r\n\r\n## say\r\nShort and sweet.\r\nStill the same paragraph.\r\n\r\nA second paragraph.\r\n## Calendar\r\n- t152 calendar after say\r\n");
            // An empty Say section falls back to the Top 3.
            sayVault.writeBrief("2031-03-04", {}, `# Morning Brief\n\n${TOP3}\n## Say\n\n`);

            clock = new Date("2031-03-10T15:00:00Z");
            const sayGet = async (query: string, token = admin.token, base = H.base) => {
                const res = await fetch(`${base}/admin/os/api/brief/say?token=${encodeURIComponent(token)}${query}`, { redirect: "manual" });
                const text = await res.text();
                let json: any = null;
                try { json = JSON.parse(text); } catch { /* HTML */ }
                return { status: res.status, type: res.headers.get("content-type") ?? "", json, text };
            };

            // The endpoint.
            const sayToday = await sayGet("&date=2031-03-10");
            check("the Say endpoint returns the brief's ## Say section as JSON, as one plain paragraph",
                sayToday.status === 200 && /application\/json/.test(sayToday.type) && sayToday.json?.source === "say"
                    && sayToday.json.text === SAY_PROSE && sayToday.json.date === "2031-03-10" && sayToday.json.status === "ok",
                sayToday);
            check("... without HTML comments or anything else markdown-only", !sayToday.text.includes(SAY_CANARY));
            const sayDefault = await sayGet("");
            check("with no date it reads today's brief (the injected clock's Central day)",
                sayDefault.status === 200 && sayDefault.json?.date === "2031-03-10" && sayDefault.json.text === SAY_PROSE, sayDefault.json);
            const sayLate = await (async () => { clock = new Date("2031-03-11T04:30:00Z"); try { return await sayGet(""); } finally { clock = new Date("2031-03-10T15:00:00Z"); } })();
            check("... where today is the Central day, not the UTC one (23:30 CDT is still the 10th)",
                sayLate.json?.date === "2031-03-10", sayLate.json);
            const sayFallback = await sayGet("&date=2031-03-07");
            check("a brief without a Say block falls back to its Top 3 as plain text, one line per item",
                sayFallback.status === 200 && sayFallback.json?.source === "top3" && sayFallback.json.text === TOP3_SPOKEN,
                sayFallback.json);
            const sayEmpty = await sayGet("&date=2031-03-04");
            check("an empty Say section falls back to the Top 3 too",
                sayEmpty.json?.source === "top3" && sayEmpty.json.text === TOP3_SPOKEN, sayEmpty.json);
            const sayMid = await sayGet("&date=2031-03-05");
            check("a Say section ends at the next heading; its paragraphs are kept apart",
                sayMid.json?.source === "say" && sayMid.json.text === "Short and sweet. Still the same paragraph.\n\nA second paragraph.",
                sayMid.json);
            const sayNone = await sayGet("&date=2031-03-06");
            check("a brief with neither a Say block nor a Top 3 is 200 with source 'none' and no text",
                sayNone.status === 200 && sayNone.json?.source === "none" && sayNone.json.text === "", sayNone.json);
            const sayMissing = await sayGet("&date=2031-03-09");
            check("no brief that day gives 404 { error: 'no brief', date }",
                sayMissing.status === 404 && sayMissing.json?.error === "no brief" && sayMissing.json.date === "2031-03-09", sayMissing);
            const sayBad = await Promise.all(["&date=2031-3-9", "&date=../../etc", "&date=2031-03-10&date=2031-03-07"].map((q) => sayGet(q)));
            check("a malformed date gives 400", sayBad.every((r) => r.status === 400), sayBad.map((r) => r.status));
            const sayGated = await sayGet("&date=2031-03-10", user.token);
            check("a non-admin can't read the Say endpoint", sayGated.status === 403 && !sayGated.text.includes("Good morning"), sayGated.status);
            const sayShipped = await sayGet("&date=2031-03-10", admin.token, P.base);
            check("the shipped admin router serves it at /admin/os/api/brief/say",
                sayShipped.status === 200 && sayShipped.json?.text === SAY_PROSE, sayShipped.status);

            // The briefs page.
            const sayPage = await fetch(`${P.base}/admin/briefs?date=2031-03-10&token=${encodeURIComponent(admin.token)}`).then((r) => r.text());
            check("the briefs page renders the brief but not its Say block",
                sayPage.includes("Nothing today.") && sayPage.includes("Overdue") && !sayPage.includes("reply to Sam")
                    && !/<h2[^>]*>\s*Say\s*<\/h2>/i.test(sayPage) && !sayPage.includes(SAY_CANARY));
            const sayPageMid = await fetch(`${P.base}/admin/briefs?date=2031-03-05&token=${encodeURIComponent(admin.token)}`).then((r) => r.text());
            check("... and keeps the sections after a mid-brief Say block",
                sayPageMid.includes("t152 calendar after say") && !sayPageMid.includes("Short and sweet"));

            // "Read the brief": tier 1, never the model.
            const sayCalls = fakeModel.calls.length;
            const readAsks = ["read the brief", "Read me today's brief.", "please read my morning brief aloud",
                "can you read out the briefing", "read brief"];
            for (const text of readAsks) {
                const r = await ask(text, "voice");
                check(`"${text}" speaks today's Say block at tier 1`,
                    r.status === 200 && r.json?.tier === 1 && r.json.kind === "answer" && r.json.say === SAY_PROSE, r.json);
            }
            const readRows = (await asks()).slice(-readAsks.length);
            check("... logged as tier 1, intent brief.read",
                readRows.every((row) => row.tier === 1 && row.intent === "brief.read" && row.kind === "answer"), readRows.map((row) => row.intent));
            clock = new Date("2031-03-07T15:00:00Z");
            const readFallback = await ask("read the brief");
            check("on a day whose brief has no Say block it speaks the Top 3",
                readFallback.json?.tier === 1 && readFallback.json.say === TOP3_SPOKEN && typeof readFallback.json.display === "string",
                readFallback.json);
            clock = new Date("2031-03-09T15:00:00Z");
            const readMissing = await ask("read the brief");
            check("with no brief today it says so (and when the latest is from)",
                readMissing.json?.tier === 1 && readMissing.json.kind === "answer"
                    && /no brief for today/i.test(readMissing.json.say) && /latest is from Friday, March 7/.test(readMissing.json.say),
                readMissing.json);
            clock = new Date("2031-03-06T15:00:00Z");
            const readNone = await ask("read the brief");
            check("a brief with nothing to read says so", readNone.json?.tier === 1 && /nothing to read/i.test(readNone.json.say), readNone.json);
            delete process.env.OBSIDIAN_VAULT_PATH;
            const readNoVault = await ask("read the brief");
            const sayNoVault = await sayGet("&date=2031-03-10");
            process.env.OBSIDIAN_VAULT_PATH = sayVault.dir;
            check("without a vault the ask is tier-1 unavailable and the endpoint 503",
                readNoVault.json?.tier === 1 && readNoVault.json.kind === "unavailable" && sayNoVault.status === 503,
                { ask: readNoVault.json, status: sayNoVault.status });
            check("no \"read the brief\" ask called the model", fakeModel.calls.length === sayCalls, fakeModel.calls.length - sayCalls);
            const readShipped = await ask("read the brief", "typed", P.base);
            check("the shipped command table has \"read the brief\" at tier 1", readShipped.json?.tier === 1, readShipped.json);
        } finally {
            clock = sayClockBefore;
            if (sayVaultBefore === undefined) delete process.env.OBSIDIAN_VAULT_PATH;
            else process.env.OBSIDIAN_VAULT_PATH = sayVaultBefore;
            sayVault.remove();
        }

        check("every canned model reply was used", fakeModel.next.length === 0, fakeModel.next.length);
    } finally {
        if (renamed) {
            for (const name of ["os_asks_t146_renamed", "os_asks_t156_renamed"]) {
                await pool.query(`ALTER TABLE ${name} RENAME TO os_asks`).catch(() => {});
            }
        }
        // Runs these admins queued (requested_by has no FK), then the accounts;
        // os_asks rows go with their account (ON DELETE CASCADE).
        await pool.query(`DELETE FROM agent_runs WHERE requested_by = ANY($1::text[])`, [created]).catch(() => {});
        for (const id of created) await pool.query(`DELETE FROM accounts WHERE id = $1`, [id]);
        P.server.close(); H.server.close(); F.server.close(); Q.server.close(); N.server.close();
    }

    console.log(`\n  ${pass} passed, ${fail} failed\n`);
    await pool.end();
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
