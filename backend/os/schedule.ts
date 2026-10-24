/**
 * Skill schedules as data (spec #135): when the PC's Task Scheduler starts a
 * skill, in the schedule's own time zone, so "next run" holds across weekends
 * and daylight-saving changes.
 *
 * A leaf module (no imports) so services/agentRuns.ts can carry schedules in
 * SKILLS and os/ tiles and commands can compute from them.
 */

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface SkillSchedule {
    /** The days it runs, ISO weekdays. */
    days: readonly IsoWeekday[];
    /** Wall-clock start, "HH:MM" (24-hour), in `timeZone`. */
    at: string;
    /** IANA zone the days and time are in. */
    timeZone: string;
}

const DAY_MS = 86_400_000;

/** The calendar day (YYYY-MM-DD) of an instant in a zone. */
export const dayIn = (d: Date, timeZone: string) => d.toLocaleDateString("en-CA", { timeZone });

/** The ISO weekday of a YYYY-MM-DD calendar day. */
export function isoWeekday(day: string): IsoWeekday {
    return ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7 + 1) as IsoWeekday;
}

/** YYYY-MM-DD `n` calendar days after `day`. */
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** How far a zone's wall clock is ahead of UTC at an instant, in ms (Central: −5 h or −6 h). */
function offsetAt(t: number, timeZone: string): number {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
        timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(t)).map((p) => [p.type, p.value]));
    const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return wall - Math.floor(t / 1000) * 1000;
}

/**
 * The instant a zone's wall clock reads `at` ("HH:MM") on calendar day `day`.
 * Uses the offset in force at that wall time, so 06:45 Central is 11:45Z in
 * summer and 12:45Z in winter. US clocks change at 02:00, so a schedule
 * outside 01:00–03:00 never meets a skipped or repeated wall time; one inside
 * it lands within an hour of the wall time.
 */
export function zonedInstant(day: string, at: string, timeZone: string): Date {
    const m = at.match(/^(\d{2}):(\d{2})$/);
    if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RangeError(`not a day and HH:MM time: ${day} ${at}`);
    const wall = Date.parse(`${day}T00:00:00Z`) + (+m[1] * 60 + +m[2]) * 60_000;
    // Two passes: the first guess's offset can be the other side of a change.
    let t = wall - offsetAt(wall, timeZone);
    t = wall - offsetAt(t, timeZone);
    return new Date(t);
}

/** The scheduled start on a calendar day in the schedule's zone, or null when it doesn't run that day. */
export function scheduledOn(schedule: SkillSchedule, day: string): Date | null {
    return schedule.days.includes(isoWeekday(day)) ? zonedInstant(day, schedule.at, schedule.timeZone) : null;
}

/**
 * The first scheduled start strictly after `now`. At the scheduled minute
 * itself the run is starting, so the next one is the following run day.
 * Null only for a schedule with no days.
 */
export function nextScheduledRun(schedule: SkillSchedule, now: Date): Date | null {
    const today = dayIn(now, schedule.timeZone);
    // Eight days: today's start may have passed, and the same weekday next week is the latest it can be.
    for (let i = 0; i <= 7; i++) {
        const start = scheduledOn(schedule, addDays(today, i));
        if (start && start.getTime() > now.getTime()) return start;
    }
    return null;
}
