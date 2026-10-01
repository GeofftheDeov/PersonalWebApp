import { query } from '../db/index.js';

/**
 * The skill-run queue (db/migrations/2026-09-26-agent-runs.sql).
 *
 * The admin page enqueues; the runner on Geoff's PC claims and completes over
 * /api/runner (routes/runnerRoutes.ts). Nothing here executes a skill.
 */

/** What may be enqueued. The runner keeps its own list of what it will run. */
export const SKILLS = [
    { id: 'morning-brief', label: 'Morning brief', output: (d: string) => `outputs/briefs/${d}.md` },
] as const;
export type SkillId = typeof SKILLS[number]['id'];
export const isSkill = (s: unknown): s is SkillId => SKILLS.some(k => k.id === s);

/** A run still `running` after this long is presumed dead (PC slept, runner killed). */
const STALE_AFTER = '45 minutes';

export interface AgentRun {
    id: number;
    skill: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed';
    requested_at: string;
    claimed_at: string | null;
    finished_at: string | null;
    runner: string | null;
    summary: string | null;
    output_path: string | null;
}

// The runner calls /claim every ~30s, so its last call doubles as a heartbeat.
// In memory: a restart just shows "offline" until the next poll.
let lastSeen: { at: Date; runner: string } | null = null;
export function runnerLastSeen() { return lastSeen; }
export function runnerOnline(): boolean {
    return !!lastSeen && Date.now() - lastSeen.at.getTime() < 2 * 60 * 1000;
}

/**
 * Enqueue, unless the same skill is already queued or running — pressing the
 * button twice should not run the brief twice. Returns the run either way.
 */
export async function enqueueRun(skill: SkillId, requestedBy: string | null): Promise<{ run: AgentRun; created: boolean }> {
    const existing = await query<AgentRun>(
        `SELECT * FROM agent_runs WHERE skill = $1 AND status IN ('queued','running')
          ORDER BY requested_at DESC LIMIT 1`, [skill]);
    if (existing.rows[0]) return { run: existing.rows[0], created: false };
    const { rows } = await query<AgentRun>(
        `INSERT INTO agent_runs (skill, requested_by) VALUES ($1, $2) RETURNING *`, [skill, requestedBy]);
    return { run: rows[0], created: true };
}

async function expireStale(): Promise<void> {
    await query(
        `UPDATE agent_runs SET status = 'failed', finished_at = now(),
                summary = 'no result from runner within ${STALE_AFTER}'
          WHERE status = 'running' AND claimed_at < now() - interval '${STALE_AFTER}'`);
}

export async function listRuns(limit = 10): Promise<AgentRun[]> {
    await expireStale();
    const { rows } = await query<AgentRun>(
        `SELECT * FROM agent_runs ORDER BY requested_at DESC LIMIT $1`, [limit]);
    return rows;
}

/**
 * Atomically hand the oldest queued run whose skill the runner supports to that
 * runner. SKIP LOCKED makes two concurrent claims take different rows (or one
 * gets nothing) instead of both taking the same run.
 */
export async function claimNext(runner: string, supported: string[]): Promise<AgentRun | null> {
    lastSeen = { at: new Date(), runner };
    await expireStale();
    if (supported.length === 0) return null;
    const { rows } = await query<AgentRun>(
        `UPDATE agent_runs SET status = 'running', claimed_at = now(), runner = $1
          WHERE id = (SELECT id FROM agent_runs
                       WHERE status = 'queued' AND skill = ANY($2::text[])
                       ORDER BY requested_at LIMIT 1
                       FOR UPDATE SKIP LOCKED)
          RETURNING *`, [runner, supported]);
    return rows[0] ?? null;
}

/** Only a `running` row can be completed, so a late or repeated report cannot rewrite history. */
export async function completeRun(
    id: number,
    result: { ok: boolean; summary?: string; outputPath?: string },
): Promise<AgentRun | null> {
    const { rows } = await query<AgentRun>(
        `UPDATE agent_runs SET status = $2, finished_at = now(), summary = $3, output_path = $4
          WHERE id = $1 AND status = 'running' RETURNING *`,
        [id, result.ok ? 'succeeded' : 'failed', result.summary?.slice(0, 500) ?? null, result.outputPath?.slice(0, 300) ?? null]);
    return rows[0] ?? null;
}
