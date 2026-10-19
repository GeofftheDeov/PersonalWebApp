import fs from "fs";
import { describeError, ok, type Overview, type Queryable, type TileSource } from "../overview.js";
import { ago, centralDay, centralTime, esc, TIME_ZONE } from "../format.js";
import { nextScheduledRun, scheduledOn, type SkillSchedule } from "../schedule.js";
import {
    RUNNER_ONLINE_WITHIN_MS, SKILLS, STALE_AFTER, runnerLastSeen, skillSchedule,
    type AgentRun, type RunTrigger, type SkillId,
} from "../../services/agentRuns.js";
import { listBriefs, type BriefMeta } from "../../utils/briefs.js";
import { USAGE_MIGRATION } from "./usage.js";

/**
 * The Brief & runner tile.
 *
 * Part 1 (#142): when the next morning brief is due, the latest brief in the
 * local vault checkout, and a flag when today's is missing after its scheduled
 * time. The schedule is SKILLS data (services/agentRuns.ts), mirroring the PC's
 * Task Scheduler registration, which the server can't see. The latest brief is
 * read with the briefs utility (utils/briefs.ts) /admin/briefs uses.
 *
 * Part 2 (#143): whether a RUN press will be picked up, and whether the last
 * scheduled brief worked. The runner's online state is the in-memory
 * heartbeat (its last /claim; one backend task assumed), any queued or running
 * run comes from `agent_runs`, and so does the brief's last `scheduled` run,
 * which the vault wrapper reports after the fact (#138, V#10).
 *
 * The tile stays ok when the vault or the run history can't be read: the next
 * run doesn't depend on either, and `latestNote` / `runsNote` say what's
 * missing. Only a throw anywhere else makes it unavailable.
 */

/** The skill whose schedule and output this tile reports. */
export const BRIEF_SKILL: SkillId = "morning-brief";

/** The overview page reloads this often while a run is queued or running (os/page.ts reloads every 2 minutes otherwise). */
export const ACTIVE_RUN_REFRESH_MS = 15_000;

export type LatestBrief = BriefMeta;

/** The runner, from the in-memory heartbeat: its last /claim. */
export interface RunnerStatus {
    /** Polled within RUNNER_ONLINE_WITHIN_MS of now. */
    online: boolean;
    /** ISO time of its last poll; null when it hasn't polled since this server started. */
    lastSeen: string | null;
    /** The name it polled with (the PC's), or null. */
    name: string | null;
    /** now − lastSeen in ms (never negative), or null. */
    ageMs: number | null;
}

/** A queued or running run, of any skill. */
export interface ActiveRun {
    id: number;
    skill: string;
    /** The skill's SKILLS label ("Morning brief"), or its id if it's no longer runnable. */
    label: string;
    status: "queued" | "running";
    trigger: RunTrigger;
    requestedAt: string;
    /** When the runner claimed it; null while queued. */
    claimedAt: string | null;
    /** The runner that claimed it; null while queued. */
    runner: string | null;
}

/** A finished run's outcome, as recorded in agent_runs. */
export interface RunOutcome {
    id: number;
    skill: string;
    ok: boolean;
    status: "succeeded" | "failed";
    /** When it started (claimed_at), ISO; null if unknown. */
    startedAt: string | null;
    finishedAt: string | null;
    summary: string | null;
    outputPath: string | null;
    durationMs: number | null;
    costUsd: number | null;
}

export interface BriefTileData {
    /** The brief's schedule, as SKILLS carries it; null if it has none. */
    schedule: SkillSchedule | null;
    /** The next scheduled start (ISO), strictly after now; null without a schedule. */
    nextRun: string | null;
    /** Today's Central calendar day, YYYY-MM-DD: the date today's brief is named after. */
    today: string;
    /** Today's scheduled start (ISO), or null when today isn't a run day. */
    dueToday: string | null;
    /**
     * Today is a run day, its start has passed, and the vault has no brief for
     * today. A prompt to look, not proof of failure: Task Scheduler starts a run
     * missed while the PC slept once it wakes, and the vault syncs on a delay.
     */
    missingToday: boolean;
    /** The newest brief in the vault checkout, or null. */
    latest: LatestBrief | null;
    /** Why `latest` is null: no briefs yet, or the vault can't be read. Null when there is one. */
    latestNote: string | null;
    /** The runner's heartbeat (#143). Always present: it's in memory, not in the database. */
    runner: RunnerStatus;
    /**
     * The run a RUN press would wait behind (#143): the oldest running run,
     * else the oldest queued one, of any skill. A run still `running`
     * STALE_AFTER after its claim is presumed dead and isn't active. Null when
     * nothing is active or the run history can't be read.
     */
    activeRun: ActiveRun | null;
    /** How many runs are queued or running (live ones only), activeRun included. */
    activeCount: number;
    /** The brief's newest finished `scheduled` run (#143), or null when none is recorded or the history can't be read. */
    lastScheduled: RunOutcome | null;
    /** Why the run history couldn't be read (e.g. a migration not applied); null when it could. */
    runsNote: string | null;
}

/** True when the overview's brief tile has a queued or running run: the page then reloads every ACTIVE_RUN_REFRESH_MS. */
export const runActive = (overview: Overview): boolean => {
    const t = overview.tiles[briefTile.id] as { status: string; activeRun?: unknown } | undefined;
    return t?.status === "ok" && !!t.activeRun;
};

function readRunner(now: Date): RunnerStatus {
    const seen = runnerLastSeen();
    if (!seen) return { online: false, lastSeen: null, name: null, ageMs: null };
    const ageMs = Math.max(0, now.getTime() - seen.at.getTime());
    return { online: ageMs < RUNNER_ONLINE_WITHIN_MS, lastSeen: seen.at.toISOString(), name: seen.runner, ageMs };
}

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const skillLabel = (id: string) => SKILLS.find((k) => k.id === id)?.label ?? id;

/** The active runs and the brief's last scheduled run, in one round trip. Throws on a missing table or column. */
async function readRuns(db: Queryable, now: Date): Promise<Pick<BriefTileData, "activeRun" | "activeCount" | "lastScheduled">> {
    const cols = `id, skill, status, trigger, requested_at, claimed_at, finished_at, runner, summary, output_path, duration_ms, cost_usd`;
    const { rows } = await db.query<AgentRun & { kind: "active" | "scheduled"; n: number | null }>(
        `(SELECT 'active' AS kind, ${cols}, (count(*) OVER ())::int AS n
            FROM agent_runs
           WHERE status = 'queued'
              OR (status = 'running' AND (claimed_at IS NULL OR claimed_at >= $2::timestamptz - $3::interval))
           ORDER BY status = 'running' DESC, requested_at, id
           LIMIT 1)
         UNION ALL
         (SELECT 'scheduled', ${cols}, NULL
            FROM agent_runs
           WHERE skill = $1 AND trigger = 'scheduled' AND status IN ('succeeded', 'failed')
           ORDER BY finished_at DESC NULLS LAST, id DESC
           LIMIT 1)`,
        [BRIEF_SKILL, now, STALE_AFTER]);
    const active = rows.find((r) => r.kind === "active");
    const sched = rows.find((r) => r.kind === "scheduled");
    return {
        activeRun: active ? {
            id: active.id, skill: active.skill, label: skillLabel(active.skill),
            status: active.status as ActiveRun["status"], trigger: active.trigger,
            requestedAt: iso(active.requested_at)!, claimedAt: iso(active.claimed_at), runner: active.runner,
        } : null,
        activeCount: active?.n ?? 0,
        lastScheduled: sched ? {
            id: sched.id, skill: sched.skill, ok: sched.status === "succeeded", status: sched.status as RunOutcome["status"],
            startedAt: iso(sched.claimed_at), finishedAt: iso(sched.finished_at), summary: sched.summary,
            outputPath: sched.output_path, durationMs: sched.duration_ms, costUsd: sched.cost_usd,
        } : null,
    };
}

/** Why the run history is unreadable, naming the migration when one is missing. */
function runsNoteFor(err: any): string {
    const fix = err?.code === "42P01" ? "db/migrations/2026-09-26-agent-runs.sql" : err?.code === "42703" ? USAGE_MIGRATION : null;
    return `run history unavailable: ${describeError(err)}${fix ? `; apply ${fix}` : ""}`;
}

/** The newest brief, or why there's none. `known` is false when the vault couldn't be read at all. */
function readLatest(): { latest: LatestBrief | null; note: string | null; known: boolean } {
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
    if (!vaultPath) return { latest: null, note: "OBSIDIAN_VAULT_PATH is not configured on this service", known: false };
    if (!fs.existsSync(vaultPath)) return { latest: null, note: "the vault checkout isn't there (OBSIDIAN_VAULT_PATH)", known: false };
    const [latest] = listBriefs(vaultPath, 1);
    return latest ? { latest, note: null, known: true } : { latest: null, note: "no briefs yet", known: true };
}

const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "06:45" → "6:45 AM" */
function wallTime(at: string): string {
    const [h, m] = at.split(":").map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

const zoneLabel = (timeZone: string) => (timeZone === TIME_ZONE ? "CT" : timeZone);

/** "weekdays at 6:45 AM CT", "daily at …", "Mon, Thu at …". */
function describeSchedule(s: SkillSchedule): string {
    const days = [...s.days].sort().join(",");
    const which = days === "1,2,3,4,5" ? "weekdays" : days === "1,2,3,4,5,6,7" ? "daily"
        : [...s.days].sort().map((d) => WEEKDAY_NAMES[d - 1]).join(", ");
    return `${which} at ${wallTime(s.at)} ${zoneLabel(s.timeZone)}`;
}

/** A Central instant's time, "6:45 AM CT". */
const clockCentral = (d: Date) => `${d.toLocaleTimeString("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" })} CT`;
/** A Central instant's day, "Mon, Oct 12". */
const dayCentral = (d: Date) => d.toLocaleDateString("en-US", { timeZone: TIME_ZONE, weekday: "short", month: "short", day: "numeric" });

/** "Today" / "Tomorrow" / "Mon": the next run's day, relative to today (Central). */
function relativeDay(d: Date, now: Date): string {
    const day = centralDay(d), today = centralDay(now);
    if (day === today) return "Today";
    if (day === centralDay(new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000))) return "Tomorrow";
    return d.toLocaleDateString("en-US", { timeZone: TIME_ZONE, weekday: "short" });
}

/** A brief's YYYY-MM-DD as "Fri, Oct 9". */
const briefDay = (date: string) => new Date(`${date}T12:00:00Z`)
    .toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });

export const briefTile: TileSource<BriefTileData> = {
    id: "brief",
    title: "Brief & runner",
    href: "/admin/briefs",

    async build({ now, db }) {
        const schedule = skillSchedule(BRIEF_SKILL);
        const today = centralDay(now);
        const next = schedule ? nextScheduledRun(schedule, now) : null;
        const due = schedule ? scheduledOn(schedule, today) : null;
        const { latest, note, known } = readLatest();
        const haveToday = !!latest && latest.date >= today;
        let runs: Pick<BriefTileData, "activeRun" | "activeCount" | "lastScheduled">;
        let runsNote: string | null = null;
        try { runs = await readRuns(db, now); }
        catch (err) {
            runs = { activeRun: null, activeCount: 0, lastScheduled: null };
            runsNote = runsNoteFor(err);
            console.error("[os] brief tile: run history unavailable:", (err as any)?.message ?? err);
        }
        return ok({
            runner: readRunner(now),
            ...runs,
            runsNote,
            schedule,
            nextRun: next?.toISOString() ?? null,
            today,
            dueToday: due?.toISOString() ?? null,
            missingToday: known && !!due && now.getTime() >= due.getTime() && !haveToday,
            latest,
            latestNote: note,
        });
    },

    render(t, { now }) {
        const next = t.nextRun ? new Date(t.nextRun) : null;
        const nextHtml = next && t.schedule
            ? `<div class="stat-value">${esc(relativeDay(next, now))} ${esc(wallTime(t.schedule.at))}</div>
            <div class="stat-delta">${esc(dayCentral(next))} · runs ${esc(describeSchedule(t.schedule))}</div>`
            : `<div class="stat-delta">no schedule: on demand only</div>`;

        const flag = t.missingToday && t.dueToday
            ? `<div class="stat-delta warn" data-flag="brief-missing"><span aria-hidden="true">⚠</span> No brief for today yet; it was due at ${
                esc(clockCentral(new Date(t.dueToday)))}. It may still be running or syncing, or the PC was asleep and it starts late. Worth a look.</div>`
            : "";

        let latestHtml: string;
        if (t.latest) {
            const b = t.latest;
            const status = b.status === "ok" ? "ok"
                : `<span class="warn">${esc(b.status ?? "no status")}</span>`;
            const failed = b.failed.length ? ` · <span class="warn">unavailable: ${esc(b.failed.join(", "))}</span>` : "";
            const gen = b.generated && !isNaN(Date.parse(b.generated)) ? new Date(b.generated) : null;
            // The day only when it isn't the brief's own (a brief written late, or by hand).
            const generated = gen
                ? `generated ${esc(centralDay(gen) === b.date ? clockCentral(gen) : `${dayCentral(gen)}, ${clockCentral(gen)}`)}` : "";
            const meta = [generated, b.run ? `${esc(b.run)} run` : ""].filter(Boolean).join(" · ");
            latestHtml = `<div class="stat-meta" data-brief-status="${esc(b.status ?? "unknown")}">Latest brief: ${
                esc(briefDay(b.date))}${b.date === t.today ? " (today)" : ""} · ${status}${failed}</div>${
                meta ? `\n            <div class="muted">${meta}</div>` : ""}`;
        } else {
            latestHtml = `<div class="stat-meta">Latest brief: <span class="warn">none</span> · ${esc(t.latestNote ?? "no briefs yet")}</div>`;
        }

        return `
            <div class="stat-label">Next brief</div>
            ${nextHtml}
            ${flag}
            ${latestHtml}
            ${renderRunner(t, now)}`;
    },
};

/** "6:49 AM CT" today, "Oct 12, 6:49 AM CT" otherwise. */
const when = (v: string | null, now: Date) => (v ? centralTime(new Date(v), now) : "an unknown time");

/** #143: the runner, any active run, and the brief's last scheduled run, under the latest-brief lines. */
function renderRunner(t: BriefTileData, now: Date): string {
    const r = t.runner;
    const runner = r.online
        ? `<div class="stat-meta" data-runner="online"><span class="dir-up" aria-hidden="true">●</span> Runner online · ${
            esc(r.name ?? "unknown")} · polled ${esc(ago(r.ageMs ?? 0))}</div>`
        : `<div class="stat-meta" data-runner="offline"><span class="warn"><span aria-hidden="true">○</span> Runner offline</span> · ${
            r.lastSeen
                ? `last seen ${esc(ago(r.ageMs ?? 0))} (${esc(when(r.lastSeen, now))}${r.name ? `, ${esc(r.name)}` : ""})`
                : "never seen since this server started"}</div>`;

    let active = "";
    const a = t.activeRun;
    if (a) {
        const more = t.activeCount > 1 ? ` · +${t.activeCount - 1} more` : "";
        active = a.status === "running"
            ? `<div class="stat-meta" data-active-run="running">Running: ${esc(a.label)} · started ${
                esc(when(a.claimedAt, now))}${a.runner ? ` on ${esc(a.runner)}` : ""}${more}</div>`
            : `<div class="stat-meta" data-active-run="queued">Queued: ${esc(a.label)} · since ${esc(when(a.requestedAt, now))}${more}${
                r.online ? "" : ` · <span class="warn">the runner is offline, so it won't be picked up yet</span>`}</div>`;
    }

    let last: string;
    const s = t.lastScheduled;
    if (t.runsNote) {
        last = `<div class="stat-meta" data-last-scheduled="unknown"><span class="warn">${esc(t.runsNote)}</span></div>`;
    } else if (!s) {
        last = `<div class="stat-meta" data-last-scheduled="none">Last scheduled run: none recorded yet</div>`;
    } else {
        const outcome = s.ok ? "succeeded" : `<span class="warn"><span aria-hidden="true">⚠</span> failed</span>`;
        const summary = s.summary ? `\n            <div class="muted${s.ok ? "" : " warn"}">${esc(s.summary)}</div>` : "";
        last = `<div class="stat-meta${s.ok ? "" : " warn"}" data-last-scheduled="${esc(s.status)}">Last scheduled run: ${
            outcome} · ${esc(when(s.finishedAt ?? s.startedAt, now))}${summary}</div>`;
    }

    return `${runner}${active ? `\n            ${active}` : ""}
            ${last}`;
}
