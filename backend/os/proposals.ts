import type { Queryable } from "./overview.js";
import type { AskReply } from "./ask.js";
import { insertAsk, type AskLogEntry } from "./askLog.js";
import { SKILLS, enqueueRun, isSkill, type AgentRun, type SkillId } from "../services/agentRuns.js";

/**
 * Tier 3 of the ask router (spec #135 W3, #148): run proposals and their
 * confirmation.
 *
 * Nothing is queued when the admin asks to run a skill. The ask becomes a
 * proposal, an os_asks row with the skill and a 2-minute expiry, and only
 * POST /admin/os/ask/confirm { id } queues the run, through the same enqueue
 * (and duplicate check) as the RUN button. The state lives in Postgres, so a
 * confirm can land on a different backend task from the ask.
 */

/** How long a proposal can be confirmed for. */
export const PROPOSAL_TTL_MS = 2 * 60_000;

const label = (skill: SkillId) => SKILLS.find((k) => k.id === skill)!.label;

/** What a proposal says: "Run the morning brief?" */
export const proposalSay = (skill: SkillId) => `Run the ${label(skill).toLowerCase()}?`;

/**
 * Records a proposal to run `skill` and returns the tier-3 reply that carries
 * it. The row IS the proposal, so unlike logAsk this throws when the insert
 * fails: the caller must answer `unavailable`, never a confirmation it can't
 * honour.
 *
 * Every tier-3 ask comes through here, however the intent was recognised: a
 * tier-1 "run <label>" command, or a tier-2 `run_skill` decision (#157, which
 * passes its model, tokens and cost in `entry`; check the skill with isSkill
 * first).
 */
export async function createProposal(
    db: Queryable,
    entry: Omit<AskLogEntry, "tier" | "kind" | "skill" | "expiresAt">,
    skill: SkillId,
): Promise<AskReply> {
    const expiresAt = new Date(entry.askedAt.getTime() + PROPOSAL_TTL_MS);
    const id = await insertAsk(db, { ...entry, tier: 3, kind: "confirm_run", skill, expiresAt });
    return {
        tier: 3, kind: "confirm_run", say: proposalSay(skill),
        confirmation: { id, skill, label: label(skill), expiresAt: expiresAt.toISOString() },
    };
}

/** The RUN button's enqueue: queue `skill`, or hand back the run already queued or running. */
export type Enqueue = (skill: SkillId, requestedBy: string | null) => Promise<{ run: AgentRun; created: boolean }>;

export type ConfirmOutcome =
    | { status: "confirmed"; run: AgentRun; created: boolean; say: string }
    /** Unknown id, another account's, or not a proposal. */
    | { status: "not_found" }
    | { status: "already_confirmed" }
    | { status: "expired" }
    /** The proposed skill has since left SKILLS. */
    | { status: "not_runnable" };

/**
 * Confirms the account's proposal `id` at `now`: queues the run through
 * `enqueue` and records confirmed_at and run_id. A proposal confirms at most
 * once, even with two confirms racing (the UPDATE claims it). If the enqueue
 * throws, the claim is undone so the admin can try again, and the error is
 * rethrown.
 */
export async function confirmProposal(
    db: Queryable,
    { id, accountId, now, enqueue = enqueueRun }: { id: number; accountId: string; now: Date; enqueue?: Enqueue },
): Promise<ConfirmOutcome> {
    const claimed = await db.query<{ skill: string }>(
        `UPDATE os_asks SET confirmed_at = $3
          WHERE id = $1 AND account_id = $2 AND kind = 'confirm_run' AND skill IS NOT NULL
            AND confirmed_at IS NULL AND expires_at > $3
          RETURNING skill`, [id, accountId, now]);
    if (!claimed.rows[0]) {
        const { rows: [p] } = await db.query<{ confirmed_at: Date | null }>(
            `SELECT confirmed_at FROM os_asks
              WHERE id = $1 AND account_id = $2 AND kind = 'confirm_run' AND skill IS NOT NULL`, [id, accountId]);
        if (!p) return { status: "not_found" };
        return { status: p.confirmed_at ? "already_confirmed" : "expired" };
    }

    const unclaim = () => db.query(`UPDATE os_asks SET confirmed_at = NULL WHERE id = $1 AND run_id IS NULL`, [id])
        .catch((err) => console.error(`[os] proposal ${id}: could not undo the claim:`, err?.message ?? err));

    const skill = claimed.rows[0].skill;
    if (!isSkill(skill)) {
        await unclaim();
        return { status: "not_runnable" };
    }
    let queued: Awaited<ReturnType<Enqueue>>;
    try {
        queued = await enqueue(skill, accountId);
    } catch (err) {
        await unclaim();
        throw err;
    }
    // The run is queued whatever happens next: a lost link is logged, not an error.
    await db.query(`UPDATE os_asks SET run_id = $2 WHERE id = $1`, [id, queued.run.id])
        .catch((err) => console.error(`[os] proposal ${id}: could not record run ${queued.run.id}:`, err?.message ?? err));

    const name = label(skill).toLowerCase();
    const say = queued.created ? `Queued the ${name}.`
        : `The ${name} is already ${queued.run.status === "running" ? "running" : "queued"}.`;
    return { status: "confirmed", run: queued.run, created: queued.created, say };
}
