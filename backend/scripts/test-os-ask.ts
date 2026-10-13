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
 *     fake model that records every call. Tier 1 never calls the model, so
 *     the fake must end the run uncalled.
 *
 * Everything is asserted through HTTP responses and os_asks rows. Admin JWTs
 * are minted directly.
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5546/t146_test npx tsx scripts/test-os-ask.ts
 *
 * Extending it: tier-1 answers (#147) and run proposals (#148) add cases to
 * the "tier 1" section and seed what they read; tier 2 (#154) gives the fake
 * model canned replies (fakeModel.next) and asserts on fakeModel.calls. Don't
 * stop this script with `pkill -f`: it matches the shell's own command line
 * and kills the shell.
 */
import "./use-test-jwt-secret.js";
import express from "express";
import type { AddressInfo } from "net";
import crypto from "crypto";
import pool from "../db/index.js";
import adminRoutes, { adminGate } from "../routes/adminRoutes.js";
import { createOsRouter } from "../routes/osRoutes.js";
import type { Command } from "../os/ask.js";
import type { ModelReply, ModelRequest, OsModel } from "../os/model.js";
import { signJwt } from "../utils/jwt.js";

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

/** A model that records what it was asked and answers from a queue (#154 fills `next`). */
const fakeModel = {
    calls: [] as ModelRequest[],
    next: [] as ModelReply[],
    async route(req: ModelRequest): Promise<ModelReply> {
        this.calls.push(req);
        const reply = this.next.shift();
        if (!reply) throw new Error("fake model: no canned reply");
        return reply;
    },
} satisfies OsModel & Record<string, unknown>;

/** The admin pages navigation may reach (an independent list: the nav's admin links). */
const ALLOWED = new Set(["/admin/os", "/admin", "/db", "/admin/cloud-claw", "/admin/obsidian", "/admin/briefs",
    "/admin/alpaca", "/admin/paperclip", "/admin/person-sync", "/admin/profile"]);

async function main() {
    let clock = new Date("2026-10-12T14:00:00Z");

    const prod = express();
    prod.use(express.json());
    prod.use("/admin", adminRoutes);

    const harness = (commands?: readonly Command[]) => {
        const app = express();
        app.use(express.json());
        app.use("/admin/os", ...adminGate,
            createOsRouter({ now: () => clock, model: fakeModel, ...(commands ? { commands } : {}) }));
        return listen(app);
    };

    // Two commands that both match "open alpaca": the first must win. One that throws.
    const firstWins: Command[] = [
        { pattern: /^open alpaca$/, intent: "test.first", handler: () => ({ kind: "answer", say: "first" }) },
        { pattern: /^open alpaca$/, intent: "test.second", handler: () => ({ kind: "answer", say: "second" }) },
        { pattern: /^explode$/, intent: "test.explode", handler: () => { throw new Error("handler exploded"); } },
    ];

    const P = await listen(prod), H = await harness(), F = await harness(firstWins);

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
        const persona = async (role: "admin" | "user") => {
            const { rows: [row] } = await pool.query(
                `INSERT INTO accounts (id, name, email, password, app_role, app_role_source, is_verified)
                 VALUES (gen_random_uuid(), $1, $2, 'x', $3, 'manual', true) RETURNING id, email`,
                [`t146 ${role} ${tag}`, `t146-${role}-${tag}@example.test`, role]);
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
        for (const [text, url] of navCases) {
            const r = await ask(text, text.startsWith("go") ? "voice" : "typed");
            check(`"${text}" navigates to ${url} at tier 1, with something to say`,
                r.status === 200 && r.json?.tier === 1 && r.json.kind === "navigate" && r.json.url === url
                    && typeof r.json.say === "string" && r.json.say.length > 0 && !("confirmation" in r.json),
                { status: r.status, json: r.json });
        }

        // ── tier 1: allowlist and no match ──────────────────────────────────
        const unmatched = ["what's the weather", "open google.com", "go to evil.example.com/admin",
            "open /etc/passwd", "open", "navigate to https://example.com", "yes"];
        for (const text of unmatched) {
            const r = await ask(text);
            check(`"${text}" is not_understood at tier 1, with no url`,
                r.status === 200 && r.json?.tier === 1 && r.json.kind === "not_understood" && !("url" in r.json)
                    && typeof r.json.say === "string" && r.json.say.length > 0, r.json);
        }

        // ── the ask log ─────────────────────────────────────────────────────
        const rows = await asks();
        const total = navCases.length + unmatched.length;
        check("every ask wrote one os_asks row for the asking account", rows.length === total,
            `${rows.length} rows for ${total} asks`);
        check("every row has its tier, kind, a non-negative latency and the injected clock's time",
            rows.every((r) => r.tier === 1 && Number.isInteger(r.latency_ms) && r.latency_ms >= 0
                && new Date(r.asked_at).getTime() === clock.getTime()),
            rows.map((r) => ({ tier: r.tier, latency: r.latency_ms, at: r.asked_at })));
        const alpaca = rows.find((r) => r.text === "PLEASE, open ALPACA!!");
        check("the row keeps the trimmed text as asked, the source, the kind and the navigation intent",
            alpaca?.source === "typed" && alpaca.kind === "navigate" && alpaca.intent === "navigate.alpaca"
                && alpaca.error === null && alpaca.model === null && alpaca.skill === null, alpaca);
        check("a voice ask is logged as voice", rows.find((r) => r.text === "go to the vault")?.source === "voice");
        const none = rows.find((r) => r.text === "what's the weather");
        check("an unmatched ask is logged as not_understood with no intent", none?.kind === "not_understood"
            && none.intent === null, none);
        check("every navigate response's url is an allowlisted admin page",
            rows.filter((r) => r.kind === "navigate").length === navCases.length);

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
        const exactly500 = await ask(`open alpaca ${"x".repeat(488)}`);
        check("500 characters is accepted", exactly500.status === 200, exactly500.status);
        check("rejected asks wrote no row (the 500-character one did)", (await asks()).length === before + 1);

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

        // ── the model ───────────────────────────────────────────────────────
        check("the fake model was never called", fakeModel.calls.length === 0, fakeModel.calls.length);
    } finally {
        if (renamed) await pool.query(`ALTER TABLE os_asks_t146_renamed RENAME TO os_asks`).catch(() => {});
        // os_asks rows go with their account (ON DELETE CASCADE).
        for (const id of created) await pool.query(`DELETE FROM accounts WHERE id = $1`, [id]);
        P.server.close(); H.server.close(); F.server.close();
    }

    console.log(`\n  ${pass} passed, ${fail} failed\n`);
    await pool.end();
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
