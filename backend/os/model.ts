import { ADMIN_PAGES } from "./commands.js";
import { SKILLS } from "../services/agentRuns.js";

/**
 * The model client behind tier 2 of the ask router (spec #135 W3, #154).
 *
 * createOsRouter takes an OsModel as `model`: tests inject a fake that returns
 * canned decisions and usage and records the prompts it receives, and
 * production wires the Haiku client (os/haiku.ts), or nothing when
 * ANTHROPIC_API_KEY isn't set. The tier-2 flow that calls it (prompt, context,
 * failure handling, pricing) is os/tier2.ts.
 *
 * This module owns the contract both sides share: the request, the reply, the
 * decision schema the model must answer in, the decision validator, and the
 * rate card the router prices usage with.
 */

/** One routing request: a stable system prompt first, then the context, then the ask. */
export interface ModelRequest {
    system: string;
    /** The overview JSON, and from #155 the latest brief and the allowlisted vault pages. */
    context: string;
    /** The ask's text as typed or spoken (trimmed). */
    question: string;
}

export const DECISION_ACTIONS = ["answer", "navigate", "run_skill", "cannot_answer"] as const;
export type DecisionAction = typeof DECISION_ACTIONS[number];

/** The structured routing decision (DECISION_SCHEMA, sent as output_config.format). */
export interface ModelDecision {
    action: DecisionAction;
    /** Plain prose to speak, at most MAX_SAY_WORDS words. */
    say: string;
    /** An ADMIN_PAGES id (os/commands.ts), for `navigate`. */
    page?: string;
    /** A SKILLS id (services/agentRuns.ts), for `run_skill`. */
    skill?: string;
}

/** Token counts from the response's `usage`; the router prices them at the rate card. */
export interface ModelUsage {
    /** Uncached input tokens (the API's `input_tokens`). */
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
}

export interface ModelReply {
    /** The model id that answered, logged in os_asks.model. */
    model: string;
    /** null when the reply didn't parse into a valid decision (see parseDecision). */
    decision: ModelDecision | null;
    /** e.g. `end_turn`, `refusal`, `max_tokens`. */
    stopReason: string | null;
    /** null only if the response carried none. */
    usage: ModelUsage | null;
}

/**
 * Throws on a failed call (timeout, connection, API error) after the client's
 * own retry; the router turns that into `unavailable`. A response that came
 * back resolves, however bad, so its usage is still priced and logged.
 */
export interface OsModel {
    route(req: ModelRequest): Promise<ModelReply>;
}

// ── the decision schema ──────────────────────────────────────────────────

/** `say` is spoken: the prompt and schema ask for at most this many words. */
export const MAX_SAY_WORDS = 60;
/**
 * A `say` past this many words is a runaway reply, treated as malformed. The
 * slack over MAX_SAY_WORDS keeps a slightly long but good answer.
 */
const MAX_SAY_WORDS_HARD = MAX_SAY_WORDS * 2;

const PAGE_IDS: readonly string[] = ADMIN_PAGES.map((p) => p.id);
const SKILL_IDS: readonly string[] = SKILLS.map((s) => s.id);

/**
 * The JSON schema of a decision. `page` and `skill` are enums of the
 * allowlist, so an off-allowlist value can't validate. Strict-mode ready:
 * every object closes with additionalProperties: false, and nothing uses a
 * keyword structured outputs doesn't support (the word cap is in the
 * description, and parseDecision enforces a hard ceiling).
 */
export const DECISION_SCHEMA = {
    type: "object",
    properties: {
        action: {
            type: "string",
            enum: [...DECISION_ACTIONS],
            description: "answer: the context answers the question. navigate: the admin wants to open one of the pages. "
                + "run_skill: the admin wants to run one of the runnable skills. cannot_answer: anything else.",
        },
        say: {
            type: "string",
            description: `What to say aloud: plain prose, at most ${MAX_SAY_WORDS} words, no markdown, lists, links or code.`,
        },
        page: { type: "string", enum: [...PAGE_IDS], description: "For navigate only: the page to open." },
        skill: { type: "string", enum: [...SKILL_IDS], description: "For run_skill only: the skill to propose running." },
    },
    required: ["action", "say"],
    additionalProperties: false,
} as const;

/**
 * A decision from untrusted model output, or null if it doesn't fit
 * DECISION_SCHEMA: unknown action or keys, an empty or runaway `say`, a page
 * or skill off the allowlist, or navigate/run_skill without its target. The
 * Haiku client parses with it, and the router re-checks every reply with it,
 * so no model client can hand the router an off-allowlist target.
 */
export function parseDecision(raw: unknown): ModelDecision | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    if (Object.keys(o).some((k) => !(k in DECISION_SCHEMA.properties))) return null;
    const { action, say, page, skill } = o;
    if (!DECISION_ACTIONS.includes(action as DecisionAction)) return null;
    if (typeof say !== "string" || !say.trim()) return null;
    if (say.trim().split(/\s+/).length > MAX_SAY_WORDS_HARD) return null;
    if (page !== undefined && (typeof page !== "string" || !PAGE_IDS.includes(page))) return null;
    if (skill !== undefined && (typeof skill !== "string" || !SKILL_IDS.includes(skill))) return null;
    if (action === "navigate" && page === undefined) return null;
    if (action === "run_skill" && skill === undefined) return null;
    const decision: ModelDecision = { action: action as DecisionAction, say: say.trim() };
    if (action === "navigate") decision.page = page as string;
    if (action === "run_skill") decision.skill = skill as string;
    return decision;
}

// ── pricing ──────────────────────────────────────────────────────────────

/** The default tier-2 model; OS_ASK_MODEL overrides it. */
export const DEFAULT_OS_MODEL = "claude-haiku-5-5";

/**
 * Claude Haiku 5.5's rate card, USD per million tokens. Two cards, chosen by
 * the prompt's total input tokens (uncached + cache reads + cache writes).
 * Cache reads cost 0.1x and (5-minute) cache writes 1.25x the input rate.
 */
export const RATE_CARD = {
    longPromptAbove: 100_000,
    short: { inputPerMTok: 0.10, outputPerMTok: 0.50 },
    long: { inputPerMTok: 0.50, outputPerMTok: 2.50 },
    cacheReadMultiplier: 0.1,
    cacheWriteMultiplier: 1.25,
} as const;

/** All the input a call was billed for: uncached, cache reads and cache writes (os_asks.input_tokens). */
export const promptTokens = (u: ModelUsage) => u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;

/** The call's cost in USD, from its usage at RATE_CARD. */
export function costUsd(u: ModelUsage): number {
    const card = promptTokens(u) > RATE_CARD.longPromptAbove ? RATE_CARD.long : RATE_CARD.short;
    const input = u.inputTokens
        + u.cacheReadTokens * RATE_CARD.cacheReadMultiplier
        + u.cacheWriteTokens * RATE_CARD.cacheWriteMultiplier;
    return (input * card.inputPerMTok + u.outputTokens * card.outputPerMTok) / 1_000_000;
}
