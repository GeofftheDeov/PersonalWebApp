import type { Queryable } from "./overview.js";
import type { AskReply, AskSource } from "./ask.js";

/**
 * The ask log, os_asks (db/migrations/2026-10-12-os-asks.sql): one row per
 * POST /admin/os/ask. A tier-3 row is also the run proposal (os/proposals.ts).
 */
export interface AskLogEntry {
    accountId: string;
    /** The injected clock's time of the ask. */
    askedAt: Date;
    text: string;
    source: AskSource;
    tier: AskReply["tier"];
    kind: AskReply["kind"];
    /** The tier-1 intent, or the tier-2 model action. */
    intent: string | null;
    error: string | null;
    latencyMs: number;
    // Tier 2 (#154): the model and what its call cost.
    model?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    costUsd?: number | null;
    // Tier 3 (#148): the proposed run.
    skill?: string | null;
    expiresAt?: Date | null;
}

/** Writes the row and returns its id. Throws if it can't: use logAsk unless the row itself matters. */
export async function insertAsk(db: Queryable, row: AskLogEntry): Promise<number> {
    const { rows } = await db.query<{ id: number }>(
        `INSERT INTO os_asks (account_id, asked_at, text, source, tier, kind, intent, error, latency_ms,
                              model, input_tokens, output_tokens, cost_usd, skill, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING id`,
        [row.accountId, row.askedAt, row.text, row.source, row.tier, row.kind, row.intent, row.error, row.latencyMs,
            row.model ?? null, row.inputTokens ?? null, row.outputTokens ?? null, row.costUsd ?? null,
            row.skill ?? null, row.expiresAt ?? null]);
    return Number(rows[0].id);
}

/**
 * Best effort, for tiers 1 and 2: a failed write (say, the migration isn't
 * applied yet) is logged and the admin still gets the answer. A tier-3
 * proposal IS its row, so it goes through insertAsk (createProposal) instead.
 */
export async function logAsk(db: Queryable, row: AskLogEntry): Promise<void> {
    try {
        await insertAsk(db, row);
    } catch (err: any) {
        console.error("[os] could not log an ask:", err?.message ?? err);
    }
}
