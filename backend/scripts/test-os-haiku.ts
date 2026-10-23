/**
 * The tier-2 Haiku client (os/haiku.ts, #154 of spec #135), seam: the
 * Messages API as the real SDK speaks it.
 *
 * A local HTTP server stands in for the API. The real client (the real
 * @anthropic-ai/sdk underneath) is pointed at it, so the test sees the request
 * the SDK actually sends and feeds back the responses the API can give:
 * answers, refusals, replies cut off by max_tokens, off-schema output, server
 * errors and a server that never answers. Nothing here reaches the real API:
 * ANTHROPIC_BASE_URL points at the fake before anything runs, and the only key
 * is a fake one. No database.
 *
 *   npx tsx scripts/test-os-haiku.ts
 */
import http from "http";
import type { AddressInfo } from "net";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail: unknown = "") {
    const d = typeof detail === "string" ? detail : JSON.stringify(detail);
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !d ? "" : `\n          ${d}`}`);
    cond ? pass++ : fail++;
}

const FAKE_KEY = "t154-fake-key";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

/** What the fake API does with the next request: answer, or never answer. */
type Canned = { status: number; body: unknown } | "hang";
const queue: Canned[] = [];
const seen: { path: string; key: string | undefined; body: any }[] = [];

const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
        let body: any = null;
        try { body = JSON.parse(raw); } catch { /* recorded as null */ }
        seen.push({ path: req.url ?? "", key: req.headers["x-api-key"] as string | undefined, body });
        const next = queue.shift() ?? { status: 500, body: { type: "error", error: { type: "api_error", message: "fake API: nothing queued" } } };
        if (next === "hang") return; // never answers; the client's timeout has to end it
        res.writeHead(next.status, { "content-type": "application/json" }).end(JSON.stringify(next.body));
    });
});

/** A Messages API response body. */
const message = (content: unknown[], stop_reason: string, usage: Record<string, number> = {}) => ({
    id: "msg_t154", type: "message", role: "assistant", model: "claude-haiku-5-5", content, stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage },
});
const text = (t: string) => ({ type: "text", text: t, citations: null });
const ok = (body: unknown): Canned => ({ status: 200, body });

async function main() {
    server.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // Before the client module loads: every client the SDK builds talks to the fake.
    process.env.ANTHROPIC_BASE_URL = base;
    const { createHaikuModel, modelFromEnv } = await import("../os/haiku.js");

    const model = createHaikuModel({ apiKey: FAKE_KEY });
    const req = { system: "SYSTEM t154", context: "CONTEXT t154", question: "QUESTION t154" };

    try {
        // ── an answer, and the request that asked for it ────────────────────
        queue.push(ok(message([
            { type: "thinking", thinking: "", signature: "sig-t154" },
            text(JSON.stringify({ action: "answer", say: "Two tasks are due today." })),
        ], "end_turn", { input_tokens: 900, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: 120 })));
        const answered = await model.route(req);
        check("an answer comes back as a decision, read past the thinking block",
            answered.decision?.action === "answer" && answered.decision.say === "Two tasks are due today.", answered.decision);
        check("with the model id, the stop reason and all four usage counts",
            answered.model === "claude-haiku-5-5" && answered.stopReason === "end_turn"
                && answered.usage?.inputTokens === 900 && answered.usage.cacheReadTokens === 100
                && answered.usage.cacheWriteTokens === 50 && answered.usage.outputTokens === 120, answered);

        const sent = seen.at(-1)!;
        const b = sent.body ?? {};
        check("it's one POST to /v1/messages carrying the key", seen.length === 1 && sent.path === "/v1/messages"
            && sent.key === FAKE_KEY);
        check("the model is claude-haiku-5-5 by default", b.model === "claude-haiku-5-5", b.model);
        check("adaptive thinking at effort low, with max_tokens around 2,000",
            b.thinking?.type === "adaptive" && b.output_config?.effort === "low"
                && b.max_tokens >= 1_500 && b.max_tokens <= 2_500, { thinking: b.thinking, oc: b.output_config?.effort, max: b.max_tokens });
        check("structured outputs, not a tool call: output_config.format is a JSON schema, and no tools are sent",
            b.output_config?.format?.type === "json_schema" && typeof b.output_config.format.schema === "object"
                && b.tools === undefined && b.tool_choice === undefined, { format: b.output_config?.format?.type, tools: b.tools });
        const schema = b.output_config?.format?.schema ?? {};
        const sorted = (v: unknown) => JSON.stringify([...((v as string[]) ?? [])].sort());
        check("the schema's actions are answer, navigate, run_skill and cannot_answer",
            sorted(schema.properties?.action?.enum) === sorted(["answer", "navigate", "run_skill", "cannot_answer"]), schema.properties?.action);
        check("its page enum is exactly the allowlisted admin pages",
            sorted(schema.properties?.page?.enum) === sorted(["os", "dashboard", "shop", "cloud-claw", "obsidian", "briefs",
                "alpaca", "paperclip", "person-sync", "profile"]), schema.properties?.page?.enum);
        check("its skill enum is exactly the runnable skills",
            sorted(schema.properties?.skill?.enum) === sorted(["morning-brief", "ingest-debrief", "lint-wiki", "weekly-review"]),
            schema.properties?.skill?.enum);
        check("it requires action and say, and allows nothing else",
            sorted(schema.required) === sorted(["action", "say"]) && schema.additionalProperties === false
                && sorted(Object.keys(schema.properties ?? {})) === sorted(["action", "say", "page", "skill"]), schema);
        const userText = (b.messages?.[0]?.content ?? []).map((c: any) => c.text ?? "").join("\n");
        check("the system prompt is the system parameter; one user turn holds the context, then the question",
            b.system === "SYSTEM t154" && b.messages?.length === 1 && b.messages[0].role === "user"
                && userText.indexOf("CONTEXT t154") >= 0 && userText.indexOf("CONTEXT t154") < userText.indexOf("QUESTION t154"),
            { system: b.system, messages: b.messages });
        check("no sampling parameters (Haiku 5.5 rejects them) and no prefill",
            b.temperature === undefined && b.top_p === undefined && b.top_k === undefined
                && b.messages?.at(-1)?.role === "user");

        // ── responses that can't be used still come back, with usage ────────
        const unusable: [string, Canned, string][] = [
            ["a refusal", ok(message([], "refusal")), "refusal"],
            ["a reply cut off by max_tokens", ok(message([text('{"action":"answer","say":"Two ta')], "max_tokens")), "max_tokens"],
            ["text that isn't JSON", ok(message([text("Sure! Two tasks are due.")], "end_turn")), "end_turn"],
            ["a page off the allowlist", ok(message([text(JSON.stringify({ action: "navigate", say: "Opening.", page: "evil" }))], "end_turn")), "end_turn"],
            ["a skill that isn't runnable", ok(message([text(JSON.stringify({ action: "run_skill", say: "Running.", skill: "rm-rf" }))], "end_turn")), "end_turn"],
            ["an extra field", ok(message([text(JSON.stringify({ action: "answer", say: "Hi.", url: "https://evil.example" }))], "end_turn")), "end_turn"],
            ["navigate without a page", ok(message([text(JSON.stringify({ action: "navigate", say: "Opening." }))], "end_turn")), "end_turn"],
        ];
        for (const [name, canned, stop] of unusable) {
            queue.push(canned);
            let r: Awaited<ReturnType<typeof model.route>> | null = null, threw: unknown = null;
            try { r = await model.route(req); } catch (e) { threw = e; }
            check(`${name} resolves with no decision, its stop reason and its usage`,
                !threw && r?.decision === null && r.stopReason === stop && r.usage?.inputTokens === 900
                    && r.usage.outputTokens === 120, threw ? String(threw) : r);
        }
        queue.push(ok(message([text(JSON.stringify({ action: "navigate", say: "Opening Alpaca.", page: "alpaca" }))], "end_turn")));
        const nav = await model.route(req);
        check("an allowlisted navigate decision parses with its page", nav.decision?.action === "navigate"
            && nav.decision.page === "alpaca", nav.decision);

        // ── failures throw, after at most one retry ─────────────────────────
        const quick = createHaikuModel({ apiKey: FAKE_KEY, timeoutMs: 300 });
        let before = seen.length;
        queue.push("hang", "hang");
        const t0 = Date.now();
        let timedOut: unknown = null;
        try { await quick.route(req); } catch (e) { timedOut = e; }
        check("a server that never answers times out and throws", timedOut !== null && /time/i.test(String((timedOut as any)?.message ?? timedOut)),
            String(timedOut));
        check("... after exactly one retry", seen.length - before === 2, seen.length - before);
        check("... within the two attempts' timeouts plus backoff", Date.now() - t0 < 5_000, Date.now() - t0);

        before = seen.length;
        const overloaded = { status: 529, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } };
        queue.push(overloaded, overloaded);
        let failed: unknown = null;
        try { await model.route(req); } catch (e) { failed = e; }
        check("an API error that persists throws after one retry", failed !== null && seen.length - before === 2,
            { tries: seen.length - before, err: String(failed) });

        before = seen.length;
        queue.push(overloaded, ok(message([text(JSON.stringify({ action: "cannot_answer", say: "I can't see that." }))], "end_turn")));
        const retried = await model.route(req);
        check("one failure then a good reply: the retry's decision", retried.decision?.action === "cannot_answer"
            && seen.length - before === 2, retried);

        // ── the production wiring reads the environment ─────────────────────
        check("no ANTHROPIC_API_KEY, no model", modelFromEnv({}) === null && modelFromEnv({ ANTHROPIC_API_KEY: "  " }) === null);
        const fromEnv = modelFromEnv({ ANTHROPIC_API_KEY: FAKE_KEY, OS_ASK_MODEL: "claude-haiku-t154" });
        queue.push(ok(message([text(JSON.stringify({ action: "answer", say: "Yes." }))], "end_turn")));
        const viaEnv = await fromEnv!.route(req);
        check("with a key, a model; OS_ASK_MODEL picks the model id",
            viaEnv.decision?.say === "Yes." && seen.at(-1)?.body?.model === "claude-haiku-t154" && seen.at(-1)?.key === FAKE_KEY,
            seen.at(-1)?.body?.model);
        check("the client is reused while the environment is unchanged",
            modelFromEnv({ ANTHROPIC_API_KEY: FAKE_KEY, OS_ASK_MODEL: "claude-haiku-t154" }) === fromEnv);
        check("every canned response was used", queue.length === 0, queue.length);
    } finally {
        server.closeAllConnections();
        server.close();
    }

    console.log(`\n  ${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
