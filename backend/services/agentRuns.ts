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

/** What started a run: the RUN button (through the queue), the Task Scheduler, or a hand-run wrapper. */
export const TRIGGERS = ['button', 'scheduled', 'manual'] as const;
export type RunTrigger = typeof TRIGGERS[number];

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
    // Usage, from Claude Code's JSON result (db/migrations/2026-10-12-agent-run-usage.sql).
    // null is unknown, never 0.
    cost_usd: number | null;       // API-equivalent; subscription runs aren't billed
    input_tokens: number | null;   // uncached + cache reads + cache writes
    output_tokens: number | null;
    duration_ms: number | null;    // the `claude -p` call only
    trigger: RunTrigger;
}

/** A run's usage as stored: each field a sane number, or null when unknown or malformed. */
export interface RunUsage {
    costUsd: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    durationMs: number | null;
}

// Sanity ceilings: past these a report is garbage, not an expensive run.
const MAX_COST_USD = 1_000;
const MAX_TOKENS = 1_000_000_000;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

const sane = (v: unknown, max: number): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null;
const whole = (v: number | null) => (v === null ? null : Math.round(v));
const asObject = (raw: unknown) =>
    (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;

/**
 * Read a usage block as the runner sent it: `{ costUsd, inputTokens,
 * outputTokens, durationMs }`, any of them missing. Each field is checked on
 * its own (a finite, non-negative number, not a numeric string, at most its
 * ceiling) and becomes null if it fails, so one bad field never costs the
 * others. Token counts and the duration go into integer columns and are
 * rounded. Anything that isn't an object is no usage. Never throws: usage must
 * not be the reason a run fails to record.
 */
export function readUsage(raw: unknown): RunUsage {
    const u = asObject(raw);
    return {
        costUsd: sane(u.costUsd, MAX_COST_USD),
        inputTokens: whole(sane(u.inputTokens, MAX_TOKENS)),
        outputTokens: whole(sane(u.outputTokens, MAX_TOKENS)),
        durationMs: whole(sane(u.durationMs, MAX_DURATION_MS)),
    };
}

/** Fields the runner sent a value for that readUsage dropped: worth a log line, since the runner gets no error. */
function droppedUsage(raw: unknown, usage: RunUsage): string[] {
    const u = asObject(raw);
    return (Object.keys(usage) as (keyof RunUsage)[])
        .filter(k => u[k] !== undefined && u[k] !== null && usage[k] === null)
        .map(k => `${k}=${(typeof u[k] === 'number' ? String(u[k]) : JSON.stringify(u[k]))?.slice(0, 40)}`); // String: Infinity
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

/**
 * Only a `running` row can be completed, so a late or repeated report cannot rewrite history.
 * `usage` is the runner's usage block as sent, unchecked; see readUsage. A runner
 * that sends none (every runner before #137) leaves the run's usage null.
 */
export async function completeRun(
    id: number,
    result: { ok: boolean; summary?: string; outputPath?: string; usage?: unknown },
): Promise<AgentRun | null> {
    const usage = readUsage(result.usage);
    const dropped = droppedUsage(result.usage, usage);
    if (dropped.length) console.warn(`[runner] run ${id}: usage stored as null for ${dropped.join(', ')}`);
    const { rows } = await query<AgentRun>(
        `UPDATE agent_runs SET status = $2, finished_at = now(), summary = $3, output_path = $4,
                cost_usd = $5, input_tokens = $6, output_tokens = $7, duration_ms = $8
          WHERE id = $1 AND status = 'running' RETURNING *`,
        [id, result.ok ? 'succeeded' : 'failed', result.summary?.slice(0, 500) ?? null, result.outputPath?.slice(0, 300) ?? null,
            usage.costUsd, usage.inputTokens, usage.outputTokens, usage.durationMs]);
    return rows[0] ?? null;
}
