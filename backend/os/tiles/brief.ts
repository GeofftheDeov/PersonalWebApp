import fs from "fs";
import { ok, type TileSource } from "../overview.js";
import { centralDay, esc, TIME_ZONE } from "../format.js";
import { nextScheduledRun, scheduledOn, type SkillSchedule } from "../schedule.js";
import { skillSchedule, type SkillId } from "../../services/agentRuns.js";
import { listBriefs, type BriefMeta } from "../../utils/briefs.js";

/**
 * The Brief & runner tile (#142, part 1): when the next morning brief is due,
 * the latest brief in the local vault checkout, and a flag when today's is
 * missing after its scheduled time.
 *
 * The schedule is SKILLS data (services/agentRuns.ts), mirroring the PC's Task
 * Scheduler registration, which the server can't see. The latest brief is read
 * with the briefs utility (utils/briefs.ts) /admin/briefs uses.
 *
 * The tile stays ok when the vault can't be read: the next run doesn't depend
 * on it, and `latestNote` says why there's no brief. Only a throw makes it
 * unavailable.
 *
 * Part 2 (#143) adds the runner (online/offline and last seen), any queued or
 * running run, and the last scheduled run's outcome: new fields on
 * BriefTileData, read in `build` alongside the brief, and new sections in
 * `render` after the brief's.
 */

/** The skill whose schedule and output this tile reports. */
export const BRIEF_SKILL: SkillId = "morning-brief";

export type LatestBrief = BriefMeta;

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

    async build({ now }) {
        const schedule = skillSchedule(BRIEF_SKILL);
        const today = centralDay(now);
        const next = schedule ? nextScheduledRun(schedule, now) : null;
        const due = schedule ? scheduledOn(schedule, today) : null;
        const { latest, note, known } = readLatest();
        const haveToday = !!latest && latest.date >= today;
        return ok({
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
            ${latestHtml}`;
    },
};
