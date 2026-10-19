import Anthropic from "@anthropic-ai/sdk";
import { DECISION_SCHEMA, DEFAULT_OS_MODEL, parseDecision, type ModelDecision, type OsModel } from "./model.js";

/**
 * The real tier-2 model client (#154): Claude Haiku 5.5 over the Messages API.
 *
 * One non-streaming `messages.parse` call per ask, with structured outputs
 * (`output_config.format`, DECISION_SCHEMA), not a forced tool call; adaptive
 * thinking at effort `low`; `max_tokens` with room for the thinking; a 10 s
 * client timeout with at most one retry. Content blocks are read by type, by
 * the SDK's parser.
 *
 * The decision parser never throws: a reply cut off by max_tokens, a refusal
 * or text that isn't a valid decision comes back as `decision: null` with its
 * stop reason and usage, so the router can still price and log it.
 */

/** Room for adaptive thinking at effort low plus a decision of at most ~120 words. */
export const OS_MODEL_MAX_TOKENS = 2_000;
export const OS_MODEL_TIMEOUT_MS = 10_000;
export const OS_MODEL_MAX_RETRIES = 1;

export interface HaikuModelOptions {
    apiKey: string;
    /** Default DEFAULT_OS_MODEL (claude-haiku-5-5). */
    model?: string;
    /** For tests only: a local fake of the API. */
    baseURL?: string;
    timeoutMs?: number;
    maxRetries?: number;
}

function decisionFromText(text: string): ModelDecision | null {
    try {
        return parseDecision(JSON.parse(text));
    } catch {
        return null;
    }
}

/**
 * The output format for messages.parse: the decision schema, parsed by
 * parseDecision. (The SDK's own JSON-schema helper throws on bad JSON, which
 * would lose the response's stop reason and usage.)
 */
const DECISION_FORMAT = {
    type: "json_schema" as const,
    schema: DECISION_SCHEMA as unknown as Record<string, unknown>,
    parse: decisionFromText,
};

export function createHaikuModel({
    apiKey, model = DEFAULT_OS_MODEL, baseURL,
    timeoutMs = OS_MODEL_TIMEOUT_MS, maxRetries = OS_MODEL_MAX_RETRIES,
}: HaikuModelOptions): OsModel {
    const client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries, ...(baseURL ? { baseURL } : {}) });
    return {
        async route({ system, context, question }) {
            const message = await client.messages.parse({
                model,
                max_tokens: OS_MODEL_MAX_TOKENS,
                // Stable, so it leads the prompt; the context and question follow in the user turn.
                system,
                thinking: { type: "adaptive" },
                output_config: { effort: "low", format: DECISION_FORMAT },
                messages: [{
                    role: "user",
                    content: [
                        { type: "text", text: context },
                        { type: "text", text: `<question>\n${question}\n</question>` },
                    ],
                }],
            });
            const u = message.usage;
            return {
                model: message.model,
                decision: message.parsed_output ?? null,
                stopReason: message.stop_reason,
                usage: {
                    inputTokens: u.input_tokens ?? 0,
                    cacheReadTokens: u.cache_read_input_tokens ?? 0,
                    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
                    outputTokens: u.output_tokens ?? 0,
                },
            };
        },
    };
}

let cached: { apiKey: string; model: string; client: OsModel } | null = null;

/**
 * The production model client, read from the environment on each ask (so a
 * key set after start-up, or loaded by dotenv after the imports, counts):
 * null without ANTHROPIC_API_KEY, which makes tier 2 unavailable while tier 1
 * keeps working. OS_ASK_MODEL overrides the model id.
 */
export function modelFromEnv(env: NodeJS.ProcessEnv = process.env): OsModel | null {
    const apiKey = env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) return null;
    const model = env.OS_ASK_MODEL?.trim() || DEFAULT_OS_MODEL;
    if (cached?.apiKey !== apiKey || cached.model !== model) {
        cached = { apiKey, model, client: createHaikuModel({ apiKey, model }) };
    }
    return cached.client;
}
