import type { Overview, Queryable } from "./overview.js";

/**
 * The ask router's contract (spec #135 W3): what POST /admin/os/ask answers,
 * and the shape of tier 1's command table.
 *
 * An ask is answered at the cheapest tier that can:
 *   tier 1  the command table (os/commands.ts), no model
 *   tier 2  a Haiku call (#154), only when no command matches
 *   tier 3  a proposal to run a runnable skill (#148), however it was recognised
 *
 * The router itself lives in routes/osRoutes.ts; it validates the body, runs
 * the first matching command, and logs every ask to os_asks.
 */

export const ASK_SOURCES = ["voice", "typed"] as const;
export type AskSource = typeof ASK_SOURCES[number];

export const ASK_KINDS = ["answer", "navigate", "confirm_run", "not_understood", "unavailable"] as const;
export type AskKind = typeof ASK_KINDS[number];

/** The longest ask, after trimming (os_asks.text has the same CHECK). */
export const MAX_ASK_CHARS = 500;

/** A tier-3 proposal waiting for the admin's "yes" (#148). */
export interface AskConfirmation {
    /** The proposal's os_asks id; POST /admin/os/ask/confirm takes it. */
    id: number;
    skill: string;
    /** The skill's SKILLS label, e.g. "Morning brief". */
    label: string;
    expiresAt: string;
}

/** The response body of POST /admin/os/ask. */
export interface AskReply {
    tier: 1 | 2 | 3;
    kind: AskKind;
    /** What the page speaks (and shows). Plain prose, written for speech. */
    say: string;
    /** Optional extra text the page shows but doesn't speak. */
    display?: string;
    /** For `navigate`: an allowlisted admin path, without the token. */
    url?: string;
    /** For `confirm_run`. */
    confirmation?: AskConfirmation;
}

/** What a command's handler returns; the router sets the tier (and, from #148, the confirmation). */
export type CommandReply = Omit<AskReply, "tier" | "confirmation">;

/** Everything a command's handler gets. Handlers read the clock from here, never `new Date()`. */
export interface AskContext {
    now: Date;
    db: Queryable;
    /** The asking admin's accounts.id. */
    accountId: string;
    /** The ask as received, trimmed. */
    text: string;
    /** normaliseAsk(text): what the pattern matched. */
    normalised: string;
    /** The pattern's match on `normalised` (capture groups included). */
    match: RegExpMatchArray;
    /** The overview, built on first call and shared within the ask (#147's answers read it). */
    overview(): Promise<Overview>;
}

/**
 * One row of the tier-1 command table. `pattern` is tested against the
 * normalised ask (lowercase, no punctuation, single spaces); the first command
 * whose pattern matches answers. `intent` is logged in os_asks.intent.
 */
export interface Command {
    pattern: RegExp;
    intent: string;
    handler(ctx: AskContext): CommandReply | Promise<CommandReply>;
}

/**
 * Lowercase, apostrophes dropped ("what's" -> "whats"), every other
 * punctuation mark a space, whitespace collapsed.
 */
export function normaliseAsk(text: string): string {
    return text.toLowerCase()
        .replace(/['‘’`]/g, "")
        .replace(/[^\p{L}\p{N}\s]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** The first command whose pattern matches, or null. */
export function matchCommand(commands: readonly Command[], normalised: string) {
    for (const command of commands) {
        const match = normalised.match(command.pattern);
        if (match) return { command, match };
    }
    return null;
}
