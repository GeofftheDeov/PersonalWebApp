/**
 * The model client behind tier 2 of the ask router (spec #135 W3).
 *
 * createOsRouter takes one of these as `model`, so tests inject a fake that
 * returns canned decisions and usage and records the prompts it receives, and
 * production wires the real Haiku client. Tier 2 itself lands in #154, which
 * owns the real client, the prompt and the budget; until then the router never
 * calls the model (tier 1 only, no match is `not_understood`), and these types
 * are the agreed shape for #154 to fill in, not a finished API.
 */

/** One routing request: a stable system prompt first, then the context, then the ask. */
export interface ModelRequest {
    system: string;
    /** The overview JSON, the latest brief and the allowlisted vault pages (#155). */
    context: string;
    /** The ask's text as typed or spoken (trimmed). */
    question: string;
}

/** The structured routing decision (the JSON schema #154 sends as output_config.format). */
export interface ModelDecision {
    action: "answer" | "navigate" | "run_skill" | "cannot_answer";
    /** Plain prose, at most 60 words. */
    say: string;
    /** An allowlisted admin page id (os/commands.ts ADMIN_PAGES), for `navigate`. */
    page?: string;
    /** A runnable skill id (services/agentRuns.ts SKILLS), for `run_skill`. */
    skill?: string;
}

/** Token counts from the response's `usage`; the router prices them at the rate card. */
export interface ModelUsage {
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
}

export interface ModelReply {
    /** The model id that answered, logged in os_asks.model. */
    model: string;
    /** null when the reply didn't parse into a decision. */
    decision: ModelDecision | null;
    /** e.g. `end_turn`, `refusal`, `max_tokens`. */
    stopReason: string | null;
    usage: ModelUsage | null;
}

export interface OsModel {
    route(req: ModelRequest): Promise<ModelReply>;
}
