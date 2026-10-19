import { query } from '../db/index.js';
import type { Queryable } from '../os/overview.js';
import { TIME_ZONE } from '../os/format.js';
import type { SkillSchedule } from '../os/schedule.js';

/**
 * The skill-run queue (db/migrations/2026-09-26-agent-runs.sql).
 *
 * The admin page enqueues; the runner on Geoff's PC claims and completes over
 * /api/runner (routes/runnerRoutes.ts). Nothing here executes a skill.
 */

/**
 * The ISO 8601 week of a calendar day, as `YYYY-Www`. The year is the week's
 * own, which differs from the day's near New Year: 2027-01-01 is 2026-W53 and
 * 2024-12-30 is 2025-W01.
 */
export function isoWeek(day: string): string {
    const date = new Date(`${day}T00:00:00Z`);
    // The round trip rejects timestamps and impossible days like 2026-02-30.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day) {
        throw new RangeError(`not a YYYY-MM-DD day: ${day}`);
    }
    // The Thursday of this day's week (weeks run Monday to Sunday) is always in the week's year.
    date.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
    const year = date.getUTCFullYear();
    const week = Math.floor((date.getTime() - Date.UTC(year, 0, 1)) / (7 * 86_400_000)) + 1;
    return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * What may be enqueued: the runnable skills. The runner keeps its own list of
 * what it will run, and claims only those; a queued run of a skill no runner
 * lists waits (and holds off a second press of that skill) until one does.
 *
 * `label` is the RUN button's text (upper-cased) and the "run <label>" voice
 * phrase. `output` is where the vault skill writes, given the run's calendar
 * day (YYYY-MM-DD); the wrapper declares the same path. `schedule`, when
 * present, is when the PC's Task Scheduler also starts it (os/schedule.ts);
 * the rest are on demand only. Read it through skillSchedule().
 */
export interface Skill {
    id: string;
    label: string;
    output: (day: string) => string;
    schedule?: SkillSchedule;
}
export const SKILLS = [
    {
        id: 'morning-brief', label: 'Morning brief', output: (d: string) => `outputs/briefs/${d}.md`,
        // Mirrors the vault's Task Scheduler registration (scripts/register_morning_brief.ps1:
        // weekdays at 06:45 PC time, StartWhenAvailable), which the server can't see. Change both together.
        schedule: { days: [1, 2, 3, 4, 5], at: '06:45', timeZone: TIME_ZONE },
    },
    // Refreshes the trading wiki from the Notion debriefs; one page, rewritten in place.
    { id: 'ingest-debrief', label: 'Ingest debrief', output: (_d: string) => 'projects/alpaca-trading-bot/market-state.md' },
    { id: 'lint-wiki', label: 'Lint wiki', output: (d: string) => `outputs/lint/${d}.md` },
    { id: 'weekly-review', label: 'Weekly review', output: (d: string) => `outputs/reviews/${isoWeek(d)}.md` },
] as const satisfies readonly Skill[];
export type SkillId = typeof SKILLS[number]['id'];
export const isSkill = (s: unknown): s is SkillId => SKILLS.some(k => k.id === s);
/** A skill's Task Scheduler schedule, or null when it's on demand only. */
export const skillSchedule = (id: SkillId): SkillSchedule | null =>
    (SKILLS as readonly Skill[]).find(k => k.id === id)?.schedule ?? null;

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
export async function completeRun(id: number, result: RunResult): Promise<AgentRun | null> {
    const { rows } = await query<AgentRun>(
        `UPDATE agent_runs SET status = $2, finished_at = now(), summary = $3, output_path = $4,
                cost_usd = $5, input_tokens = $6, output_tokens = $7, duration_ms = $8
          WHERE id = $1 AND status = 'running' RETURNING *`,
        [id, ...resultColumns(`run ${id}`, result)]);
    return rows[0] ?? null;
}

/** A finished run's outcome as the runner reports it, on complete or on record. */
export interface RunResult {
    ok: boolean;
    summary?: string;
    outputPath?: string;
    /** As sent, unchecked; see readUsage. */
    usage?: unknown;
}

/** RunResult as column values: status, summary, output_path, cost_usd, input_tokens, output_tokens, duration_ms. */
function resultColumns(subject: string, result: RunResult) {
    const usage = readUsage(result.usage);
    const dropped = droppedUsage(result.usage, usage);
    if (dropped.length) console.warn(`[runner] ${subject}: usage stored as null for ${dropped.join(', ')}`);
    return [result.ok ? 'succeeded' : 'failed', result.summary?.slice(0, 500) ?? null, result.outputPath?.slice(0, 300) ?? null,
        usage.costUsd, usage.inputTokens, usage.outputTokens, usage.durationMs] as const;
}

/** The triggers a run recorded after the fact can carry: button runs always go through the queue. */
export const RECORDED_TRIGGERS = ['scheduled', 'manual'] as const satisfies readonly RunTrigger[];
export type RecordedTrigger = typeof RECORDED_TRIGGERS[number];
export const isRecordedTrigger = (t: unknown): t is RecordedTrigger => RECORDED_TRIGGERS.some(k => k === t);

/** How far back a recorded run's start may be; an older (or future) start is a bad clock, not a long run. */
const RECORDED_START_WINDOW = '24 hours';

/**
 * An ISO 8601 instant with an explicit offset (`Z` or `±HH:MM`), as the vault
 * wrapper writes it (`yyyy-MM-ddTHH:mm:ss.fffZ`). Anything else, a bare date,
 * a time with no offset, PowerShell 5.1's `/Date(…)/`, epoch numbers, is not a
 * start time we can place, so it reads as null.
 */
function readInstant(raw: unknown): Date | null {
    const m = typeof raw === 'string'
        ? /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.exec(raw) : null;
    if (!m) return null;
    // Date rolls 2026-02-30 over to March 2; the day must exist in its month.
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const day = new Date(Date.UTC(y, mo - 1, d));
    if (day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return null;
    const at = new Date(raw as string);
    return isNaN(at.getTime()) ? null : at;
}

/**
 * Record a run that already finished outside the queue (#138): a scheduled
 * 6:45 brief or one started from a terminal, reported once by its wrapper.
 * The row goes in finished (`succeeded` or `failed`), so claimNext and
 * enqueueRun's duplicate check, which look only at queued and running rows,
 * never see it, and completeRun refuses it.
 *
 * `claimed_at` (and `requested_at`, so the history lists the run when it
 * started) is `startedAt` when that is a readable instant within the last 24
 * hours and not in the future, by the database clock; otherwise now (with a
 * log line, since the wrapper gets no error). `finished_at` is now. The result
 * is read exactly as on completeRun. Not idempotent: each call is a new row.
 */
export async function recordFinishedRun(input: RunResult & {
    skill: SkillId;
    trigger: RecordedTrigger;
    runner?: string;
    /** As sent, unchecked: an ISO 8601 instant with an offset, or it's ignored. */
    startedAt?: unknown;
}): Promise<AgentRun> {
    const subject = `recorded ${input.trigger} ${input.skill} run`;
    const { rows: [run] } = await query<AgentRun>(
        `WITH s AS (
           SELECT CASE WHEN $3::timestamptz BETWEEN now() - interval '${RECORDED_START_WINDOW}' AND now()
                       THEN $3::timestamptz ELSE now() END AS started
         )
         INSERT INTO agent_runs (skill, trigger, status, requested_at, claimed_at, finished_at, runner,
                                 summary, output_path, cost_usd, input_tokens, output_tokens, duration_ms)
         SELECT $1, $2, $5, s.started, s.started, now(), $4, $6, $7, $8, $9, $10, $11 FROM s
         RETURNING *`,
        [input.skill, input.trigger, readInstant(input.startedAt), input.runner?.slice(0, 100) || null,
            ...resultColumns(subject, input)]);
    if (input.startedAt !== undefined && input.startedAt !== null
        && new Date(run.claimed_at!).getTime() === new Date(run.finished_at!).getTime()) {
        console.warn(`[runner] ${subject} ${run.id}: startedAt ${JSON.stringify(input.startedAt)?.slice(0, 60)} `
            + `is unreadable, in the future or over ${RECORDED_START_WINDOW} old; recorded as starting now`);
    }
    return run;
}

/** One finished run that reported usage: a point on the usage tile's sparkline (#145). */
export interface UsagePoint {
    id: number;
    finishedAt: string;            // ISO
    skill: string;
    trigger: RunTrigger;
    ok: boolean;
    costUsd: number;               // a point always has a cost; see summariseUsage
    inputTokens: number | null;
    outputTokens: number | null;
    durationMs: number | null;
}

/** Usage over a window of Central calendar days. */
export interface UsageSummary {
    /** The window, [from, to), ISO: the Central midnight `days - 1` days before `now`'s day, to the Central midnight after it. */
    from: string;
    to: string;
    days: number;
    /** Finished runs (succeeded or failed) in the window. */
    runs: number;
    /** Runs that reported a cost; only these are in the totals and the points. */
    runsWithUsage: number;
    /** Runs that didn't: counted here, never added to the totals as zero. */
    runsWithoutUsage: number;
    /** Sums over the runs with usage; null when there are none (empty is not $0). */
    costUsd: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    /** The newest `maxPoints` runs with usage, oldest first. */
    points: UsagePoint[];
}

/**
 * Summarise run usage over the `days` Central calendar days ending with `now`'s
 * day (today included). Runs count by when they finished; queued and running
 * runs have no usage yet and aren't counted. This only reads: a dead `running`
 * run counts once listRuns or claimNext expires it, on the day it was expired.
 *
 * A run "has usage" when it reported a cost, the headline number. A run
 * without one (an older runner, an unreadable result, an expired run) is
 * counted in runsWithoutUsage and left out of every total and point, so missing
 * data never looks free. Token totals sum what the runs with usage reported; a
 * run whose cost was dropped as malformed but whose tokens were kept counts as
 * without usage, and its tokens aren't added.
 *
 * Reads through `db`, so an overview tile runs it on its own budgeted
 * connection. Throws on a missing table or column (an unapplied migration);
 * the caller decides what that means.
 */
export async function summariseUsage(
    db: Queryable,
    { now, days, maxPoints }: { now: Date; days: number; maxPoints: number },
): Promise<UsageSummary> {
    // Central midnights computed in Postgres, which knows the DST rules: the
    // window's two ends can carry different UTC offsets.
    const { rows: [t] } = await db.query(
        `WITH w AS (
           SELECT (date_trunc('day', $1::timestamptz AT TIME ZONE $3) - make_interval(days => $2 - 1)) AT TIME ZONE $3 AS from_ts,
                  (date_trunc('day', $1::timestamptz AT TIME ZONE $3) + interval '1 day') AT TIME ZONE $3 AS to_ts
         )
         SELECT w.from_ts, w.to_ts,
                count(r.id)::int                                           AS runs,
                count(r.id) FILTER (WHERE r.cost_usd IS NOT NULL)::int     AS runs_with_usage,
                sum(r.cost_usd)                                            AS cost_usd,
                sum(r.input_tokens)  FILTER (WHERE r.cost_usd IS NOT NULL) AS input_tokens,
                sum(r.output_tokens) FILTER (WHERE r.cost_usd IS NOT NULL) AS output_tokens
           FROM w LEFT JOIN agent_runs r ON r.finished_at >= w.from_ts AND r.finished_at < w.to_ts
          GROUP BY w.from_ts, w.to_ts`,
        [now, days, TIME_ZONE]);
    const { rows: points } = await db.query(
        `SELECT id, finished_at, skill, trigger, status, cost_usd, input_tokens, output_tokens, duration_ms
           FROM agent_runs
          WHERE finished_at >= $1 AND finished_at < $2 AND cost_usd IS NOT NULL
          ORDER BY finished_at DESC, id DESC
          LIMIT $3`,
        [t.from_ts, t.to_ts, maxPoints]);
    return {
        from: new Date(t.from_ts).toISOString(),
        to: new Date(t.to_ts).toISOString(),
        days,
        runs: t.runs,
        runsWithUsage: t.runs_with_usage,
        runsWithoutUsage: t.runs - t.runs_with_usage,
        costUsd: t.cost_usd,
        inputTokens: t.input_tokens,
        outputTokens: t.output_tokens,
        points: points.reverse().map((r): UsagePoint => ({
            id: r.id,
            finishedAt: new Date(r.finished_at).toISOString(),
            skill: r.skill,
            trigger: r.trigger,
            ok: r.status === 'succeeded',
            costUsd: r.cost_usd,
            inputTokens: r.input_tokens,
            outputTokens: r.output_tokens,
            durationMs: r.duration_ms,
        })),
    };
}
