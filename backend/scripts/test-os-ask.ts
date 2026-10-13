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
 * checks what the prompt holds, #156 (budget) seeds tier-2 spend, and #157
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
import type { ModelDecision, ModelReply, ModelRequest, ModelUsage, OsModel } from "../os/model.js";
import { signJwt } from "../utils/jwt.js";

// Never a real model call: the prod wiring reads the key per ask, so without it tier 2 is unavailable.
delete process.env.ANTHROPIC_API_KEY;

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
        const overviewJson = await (await fetch(`${H.base}/admin/os/api/overview?token=${encodeURIComponent(admin.token)}`)).text();
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
        check("every canned model reply was used", fakeModel.next.length === 0, fakeModel.next.length);
    } finally {
        if (renamed) await pool.query(`ALTER TABLE os_asks_t146_renamed RENAME TO os_asks`).catch(() => {});
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
