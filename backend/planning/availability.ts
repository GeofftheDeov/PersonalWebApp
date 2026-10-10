/**
 * Availability math (#57): when can the party play?
 *
 * Pure -- no database, no network, no clock. Everything it needs comes in as
 * arguments, so every time-zone rule here is testable with a table of cases
 * (scripts/test-availability-math.ts) instead of by waiting for November.
 *
 * Inputs are the party's regular availability (weekly windows, each in its
 * owner's own IANA time zone, plus one-off exceptions) and busy blocks pulled
 * from external calendars. Output is every candidate slot in a date range,
 * ranked by headcount, saying who is free, busy or unknown for each.
 *
 * For each person:
 *   free time = (weekly windows ∪ "available" exceptions)
 *               − ("unavailable" exceptions ∪ busy blocks)
 * and for each slot they are
 *   free     if the whole slot falls inside their free time;
 *   busy     otherwise, if they have set weekly windows (outside your own
 *            windows is a "no"), or if something blocks part of the slot;
 *   unknown  otherwise: they have told us nothing about this time. A player
 *            who has never set availability shows as unknown, not as a "no"
 *            that silently sinks every option (#57, story 10).
 *
 * Weekly windows are stored as local wall time, so "Sat 5 pm" stays 5 pm in
 * the owner's zone across a daylight-saving change and its UTC instant moves.
 * A local time that a DST change skips or repeats is resolved the way
 * Temporal's "compatible" disambiguation does: a skipped time moves forward by
 * the length of the gap, a repeated time takes its first occurrence.
 */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** The longest date range one overlap may cover. */
export const MAX_RANGE_DAYS = 62;

export interface WeeklyWindow {
    personId: string;
    /** 0 = Sunday, as JS getDay(), in the window's own time zone. */
    weekday: number;
    /** Local wall time, "HH:MM". */
    start: string;
    /** "HH:MM". At or before `start` means the window crosses midnight. */
    end: string;
    /** IANA name, e.g. "America/Chicago". */
    timeZone: string;
}

export interface AvailabilityException {
    personId: string;
    start: Date;
    end: Date;
    kind: "unavailable" | "available";
}

/** Busy time from an external calendar. Deliberately has no title. */
export interface BusyBlock {
    personId: string;
    start: Date;
    end: Date;
}

export interface OverlapInput {
    /** Everyone whose availability counts, in the order to report them. */
    party: string[];
    windows: WeeklyWindow[];
    exceptions: AvailabilityException[];
    busy: BusyBlock[];
    range: { start: Date; end: Date };
    /** How long a session would run. */
    slotMinutes: number;
    /** Headcount a slot needs to be workable. See resolveQuorum. */
    quorum: number;
    /** Distance between candidate start times. Default 30. */
    stepMinutes?: number;
}

export interface Slot {
    start: Date;
    end: Date;
    free: string[];
    busy: string[];
    unknown: string[];
    /** free.length */
    headcount: number;
    meetsQuorum: boolean;
}

type Interval = [number, number]; // [startMs, endMs)

// ── time zones ──────────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
    let f = formatters.get(timeZone);
    if (!f) {
        f = new Intl.DateTimeFormat("en-US", {
            timeZone, hourCycle: "h23",
            year: "numeric", month: "numeric", day: "numeric",
            hour: "numeric", minute: "numeric", second: "numeric",
        });
        formatters.set(timeZone, f);
    }
    return f;
}

/** True when `timeZone` is an IANA name this runtime knows. */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
    if (typeof timeZone !== "string" || !timeZone || timeZone.length > 64) return false;
    try {
        formatter(timeZone);
        return true;
    } catch {
        return false;
    }
}

interface LocalDate { y: number; m: number; d: number }

function wallClock(timeZone: string, ms: number) {
    const p: Record<string, number> = {};
    for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
        if (part.type !== "literal") p[part.type] = Number(part.value);
    }
    return p as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Local time minus UTC, in ms, at instant `ms`. */
function offsetAt(timeZone: string, ms: number): number {
    const w = wallClock(timeZone, ms);
    const floored = Math.floor(ms / 1000) * 1000;
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - floored;
}

function localDateOf(timeZone: string, ms: number): LocalDate {
    const w = wallClock(timeZone, ms);
    return { y: w.year, m: w.month, d: w.day };
}

function addDays(date: LocalDate, n: number): LocalDate {
    const t = new Date(Date.UTC(date.y, date.m - 1, date.d + n));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

const weekdayOf = (date: LocalDate) => new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();
const dayNumber = (date: LocalDate) => Date.UTC(date.y, date.m - 1, date.d) / DAY;

/**
 * The instant a local wall time happens in `timeZone`, with "compatible"
 * disambiguation: a time skipped by a DST change moves forward by the gap; a
 * time that happens twice takes its first occurrence.
 */
export function localTimeToInstant(date: LocalDate, hour: number, minute: number, timeZone: string): Date {
    const wall = Date.UTC(date.y, date.m - 1, date.d, hour, minute);
    // Offsets either side of any transition near this wall time.
    const before = offsetAt(timeZone, wall - DAY);
    const after = offsetAt(timeZone, wall + DAY);
    const valid = [...new Set([before, after])]
        .map((off) => wall - off)
        .filter((instant) => wall - offsetAt(timeZone, instant) === instant);
    if (valid.length) return new Date(Math.min(...valid));
    return new Date(wall - before); // in the gap
}

// ── intervals ───────────────────────────────────────────────────────────────

function merge(intervals: Interval[]): Interval[] {
    const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
    const out: Interval[] = [];
    for (const [s, e] of sorted) {
        const last = out[out.length - 1];
        if (last && s <= last[1]) last[1] = Math.max(last[1], e);
        else out.push([s, e]);
    }
    return out;
}

/** a − b, both merged. */
function subtract(a: Interval[], b: Interval[]): Interval[] {
    const out: Interval[] = [];
    for (const [s0, e0] of a) {
        let s = s0;
        for (const [bs, be] of b) {
            if (be <= s) continue;
            if (bs >= e0) break;
            if (bs > s) out.push([s, bs]);
            s = Math.max(s, be);
            if (s >= e0) break;
        }
        if (s < e0) out.push([s, e0]);
    }
    return out;
}

/** Index of the last interval starting at or before `t`, or -1. */
function lastStartingBy(intervals: Interval[], t: number): number {
    let lo = 0, hi = intervals.length - 1, found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (intervals[mid][0] <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
}

function covers(intervals: Interval[], s: number, e: number): boolean {
    const i = lastStartingBy(intervals, s);
    return i >= 0 && intervals[i][1] >= e;
}

function touches(intervals: Interval[], s: number, e: number): boolean {
    const i = lastStartingBy(intervals, e - 1);
    return i >= 0 && intervals[i][1] > s;
}

// ── weekly windows ──────────────────────────────────────────────────────────

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Parses "HH:MM" (00:00-23:59), or returns null. */
export function parseTimeOfDay(value: unknown): { hour: number; minute: number } | null {
    const m = typeof value === "string" ? HHMM.exec(value) : null;
    return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

/** Every occurrence of a weekly window that could touch [fromMs, toMs). */
function expandWindow(w: WeeklyWindow, fromMs: number, toMs: number): Interval[] {
    const start = parseTimeOfDay(w.start);
    const end = parseTimeOfDay(w.end);
    if (!start || !end) throw new RangeError(`Bad window time "${w.start}"-"${w.end}"`);
    const crossesMidnight = end.hour * 60 + end.minute <= start.hour * 60 + start.minute;

    const out: Interval[] = [];
    // A day either side: a window that started the evening before the range,
    // or that a far-off time zone puts on a different local date.
    const last = dayNumber(localDateOf(w.timeZone, toMs + DAY));
    for (let day = localDateOf(w.timeZone, fromMs - DAY); dayNumber(day) <= last; day = addDays(day, 1)) {
        if (weekdayOf(day) !== w.weekday) continue;
        const s = localTimeToInstant(day, start.hour, start.minute, w.timeZone).getTime();
        const e = localTimeToInstant(crossesMidnight ? addDays(day, 1) : day, end.hour, end.minute, w.timeZone).getTime();
        if (e > s && e > fromMs && s < toMs) out.push([s, e]);
    }
    return out;
}

// ── the overlap ─────────────────────────────────────────────────────────────

/**
 * The headcount a slot needs. The campaign's quorum, or the whole party when
 * it has none -- and never more than the party, so a party that shrank below
 * its quorum can still plan a session.
 */
export function resolveQuorum(campaignQuorum: number | null | undefined, partySize: number): number {
    const size = Math.max(1, partySize);
    return campaignQuorum == null ? size : Math.max(1, Math.min(campaignQuorum, size));
}

function validate(input: OverlapInput, step: number) {
    const { range, slotMinutes, quorum } = input;
    const span = range.end.getTime() - range.start.getTime();
    if (!(span > 0)) throw new RangeError("The range must end after it starts.");
    if (span > MAX_RANGE_DAYS * DAY) throw new RangeError(`The range may cover at most ${MAX_RANGE_DAYS} days.`);
    if (!Number.isInteger(slotMinutes) || slotMinutes < 15 || slotMinutes > 24 * 60) {
        throw new RangeError("Slot length must be a whole number of minutes from 15 to 1440.");
    }
    if (!Number.isInteger(step) || step < 5 || step > 24 * 60) {
        throw new RangeError("Step must be a whole number of minutes from 5 to 1440.");
    }
    if (!Number.isInteger(quorum) || quorum < 1) throw new RangeError("Quorum must be a positive whole number.");
}

/**
 * Every candidate slot in `range`, ranked by headcount (then earliest first).
 * Slot starts are `stepMinutes` apart, aligned to the step in UTC; every slot
 * lies wholly inside the range.
 */
export function computeOverlap(input: OverlapInput): Slot[] {
    const step = input.stepMinutes ?? 30;
    validate(input, step);
    const slotMs = input.slotMinutes * MINUTE;
    const stepMs = step * MINUTE;
    const from = input.range.start.getTime();
    const to = input.range.end.getTime();
    const party = [...new Set(input.party)];
    const inParty = new Set(party);

    const byPerson = new Map(party.map((id) => [id, {
        hasWindows: false,
        open: [] as Interval[],
        blocked: [] as Interval[],
    }]));
    for (const w of input.windows) {
        const p = byPerson.get(w.personId);
        if (!p) continue;
        p.hasWindows = true;
        p.open.push(...expandWindow(w, from, to));
    }
    for (const x of input.exceptions) {
        const p = byPerson.get(x.personId);
        if (!p) continue;
        (x.kind === "available" ? p.open : p.blocked).push([x.start.getTime(), x.end.getTime()]);
    }
    for (const b of input.busy) {
        if (inParty.has(b.personId)) byPerson.get(b.personId)!.blocked.push([b.start.getTime(), b.end.getTime()]);
    }
    const people = party.map((id) => {
        const p = byPerson.get(id)!;
        const blocked = merge(p.blocked);
        return { id, hasWindows: p.hasWindows, blocked, free: subtract(merge(p.open), blocked) };
    });

    const slots: Slot[] = [];
    for (let s = Math.ceil(from / stepMs) * stepMs; s + slotMs <= to; s += stepMs) {
        const e = s + slotMs;
        const slot: Slot = { start: new Date(s), end: new Date(e), free: [], busy: [], unknown: [], headcount: 0, meetsQuorum: false };
        for (const p of people) {
            if (covers(p.free, s, e)) slot.free.push(p.id);
            else if (p.hasWindows || touches(p.blocked, s, e)) slot.busy.push(p.id);
            else slot.unknown.push(p.id);
        }
        slot.headcount = slot.free.length;
        slot.meetsQuorum = slot.headcount >= input.quorum;
        slots.push(slot);
    }
    return slots.sort((a, b) => b.headcount - a.headcount || a.start.getTime() - b.start.getTime());
}
