/**
 * Availability store (#57): each person's regular availability, and the
 * database side of the party overlap.
 *
 * Weekly windows are replaced as a set (the editor saves the whole week at
 * once); exceptions are added and removed one at a time. Busy blocks are
 * written by the calendar sync (busySources.ts), never by a person, and only ever leave this
 * module as bare intervals: the overlap reports free / busy / unknown and
 * nothing about why.
 *
 * Plain SQL, like services/listViews.ts. Tables:
 * migrations/2026-10-01-session-planning.sql.
 */
import { query, withTransaction } from "../db/index.js";
import { isUuid } from "../db/model.js";
import { bus } from "../events/index.js";
import { personDisplayName } from "../utils/personUtils.js";
import { busySkipKey, refreshBusy } from "./busySources.js";
import {
    computeOverlap, isValidTimeZone, parseTimeOfDay, resolveQuorum, MAX_RANGE_DAYS,
    type AvailabilityException, type BusyBlock, type Slot, type WeeklyWindow,
} from "./availability.js";

const DAY = 24 * 60 * 60 * 1000;
export const MAX_WINDOWS = 50;
export const MAX_UPCOMING_EXCEPTIONS = 100;
export const MAX_EXCEPTION_DAYS = 62;

/** A 4xx the route can hand straight back to the page. */
export class AvailabilityError extends Error {
    constructor(public status: number, message: string) { super(message); }
}

export interface StoredWindow {
    id: string;
    weekday: number;
    start: string;   // "HH:MM"
    end: string;
    timeZone: string;
}

export interface StoredException {
    id: string;
    start: string;   // ISO
    end: string;
    kind: "unavailable" | "available";
    note: string | null;
}

const hhmm = (t: string) => t.slice(0, 5);   // Postgres time "17:00:00" -> "17:00"

const toWindow = (r: any): StoredWindow => ({
    id: r.id, weekday: r.weekday, start: hhmm(r.start_time), end: hhmm(r.end_time), timeZone: r.time_zone,
});

const toException = (r: any): StoredException => ({
    id: r.id, start: r.starts_at.toISOString(), end: r.ends_at.toISOString(), kind: r.kind, note: r.note,
});

function announce(personId: string, what: "windows" | "exceptions") {
    bus.publish("availability.changed", { personId, what }).catch(() => { /* bus down is non-fatal */ });
}

// ── weekly windows ──────────────────────────────────────────────────────────

/** Validates a week's worth of windows, dropping exact duplicates. */
export function cleanWindows(raw: unknown): Omit<StoredWindow, "id">[] {
    if (!Array.isArray(raw)) throw new AvailabilityError(400, "windows must be an array.");
    if (raw.length > MAX_WINDOWS) throw new AvailabilityError(400, `At most ${MAX_WINDOWS} weekly windows.`);
    const seen = new Set<string>();
    const out: Omit<StoredWindow, "id">[] = [];
    raw.forEach((w: any, i: number) => {
        const where = `Window ${i + 1}`;
        if (!w || typeof w !== "object") throw new AvailabilityError(400, `${where} is not an object.`);
        if (!Number.isInteger(w.weekday) || w.weekday < 0 || w.weekday > 6) {
            throw new AvailabilityError(400, `${where}: weekday must be 0 (Sunday) to 6 (Saturday).`);
        }
        const start = parseTimeOfDay(w.start), end = parseTimeOfDay(w.end);
        if (!start || !end) throw new AvailabilityError(400, `${where}: start and end must be "HH:MM" (00:00-23:59).`);
        if (w.start === w.end) throw new AvailabilityError(400, `${where}: start and end can't be the same time.`);
        if (!isValidTimeZone(w.timeZone)) throw new AvailabilityError(400, `${where}: "${w.timeZone}" is not a known time zone.`);
        const key = `${w.weekday}|${w.start}|${w.end}|${w.timeZone}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ weekday: w.weekday, start: w.start, end: w.end, timeZone: w.timeZone });
    });
    return out;
}

export async function getWindows(personId: string): Promise<StoredWindow[]> {
    const { rows } = await query(
        `SELECT * FROM availability_windows WHERE person_id = $1 ORDER BY weekday, start_time, end_time`, [personId]);
    return rows.map(toWindow);
}

/** Replaces the person's whole week. An empty list clears it. */
export async function replaceWindows(personId: string, raw: unknown): Promise<StoredWindow[]> {
    const windows = cleanWindows(raw);
    await withTransaction(async (db) => {
        await db.query(`DELETE FROM availability_windows WHERE person_id = $1`, [personId]);
        for (const w of windows) {
            await db.query(
                `INSERT INTO availability_windows (person_id, weekday, start_time, end_time, time_zone)
                 VALUES ($1, $2, $3, $4, $5)`, [personId, w.weekday, w.start, w.end, w.timeZone]);
        }
    });
    announce(personId, "windows");
    return getWindows(personId);
}

// ── exceptions ──────────────────────────────────────────────────────────────

function cleanException(raw: any) {
    if (!raw || typeof raw !== "object") throw new AvailabilityError(400, "Send { start, end, kind, note? }.");
    const start = new Date(raw.start), end = new Date(raw.end);
    if (typeof raw.start !== "string" || typeof raw.end !== "string" || isNaN(+start) || isNaN(+end)) {
        throw new AvailabilityError(400, "start and end must be ISO date-times.");
    }
    if (end <= start) throw new AvailabilityError(400, "An exception must end after it starts.");
    if (+end - +start > MAX_EXCEPTION_DAYS * DAY) {
        throw new AvailabilityError(400, `An exception can cover at most ${MAX_EXCEPTION_DAYS} days.`);
    }
    if (raw.kind !== "unavailable" && raw.kind !== "available") {
        throw new AvailabilityError(400, `kind must be "unavailable" or "available".`);
    }
    const note = typeof raw.note === "string" ? raw.note.trim() : "";
    if (note.length > 200) throw new AvailabilityError(400, "Notes are limited to 200 characters.");
    return { start, end, kind: raw.kind as StoredException["kind"], note: note || null };
}

/** Exceptions that have not finished yet, soonest first. */
export async function listExceptions(personId: string, now: Date): Promise<StoredException[]> {
    const { rows } = await query(
        `SELECT * FROM availability_exceptions WHERE person_id = $1 AND ends_at > $2 ORDER BY starts_at`,
        [personId, now]);
    return rows.map(toException);
}

export async function addException(personId: string, raw: unknown, now: Date): Promise<StoredException> {
    const x = cleanException(raw);
    if (x.end <= now) throw new AvailabilityError(400, "That exception is already over.");
    const { rows: [{ n }] } = await query(
        `SELECT count(*)::int AS n FROM availability_exceptions WHERE person_id = $1 AND ends_at > $2`, [personId, now]);
    if (n >= MAX_UPCOMING_EXCEPTIONS) {
        throw new AvailabilityError(400, `At most ${MAX_UPCOMING_EXCEPTIONS} upcoming exceptions; remove one first.`);
    }
    const { rows: [row] } = await query(
        `INSERT INTO availability_exceptions (person_id, starts_at, ends_at, kind, note)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`, [personId, x.start, x.end, x.kind, x.note]);
    announce(personId, "exceptions");
    return toException(row);
}

/** False when there is no such exception of this person's. */
export async function removeException(personId: string, id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const { rowCount } = await query(
        `DELETE FROM availability_exceptions WHERE id = $1 AND person_id = $2`, [id, personId]);
    if (rowCount) announce(personId, "exceptions");
    return Boolean(rowCount);
}

// ── feeding the math ────────────────────────────────────────────────────────

/**
 * Everything the availability math needs about these people around `range`.
 * `skip` holds "<personId>|<source>" pairs whose busy blocks are left out
 * (their calendar couldn't be read just now; see busySources.refreshBusy).
 */
export async function loadAvailability(personIds: string[], range: { start: Date; end: Date }, skip: Set<string> = new Set()) {
    // A day of slack either side: an exception or busy block can reach in from
    // just outside the range.
    const from = new Date(range.start.getTime() - DAY), to = new Date(range.end.getTime() + DAY);
    const [w, x, b] = await Promise.all([
        query(`SELECT * FROM availability_windows WHERE person_id = ANY($1)`, [personIds]),
        query(`SELECT * FROM availability_exceptions
                WHERE person_id = ANY($1) AND ends_at > $2 AND starts_at < $3`, [personIds, from, to]),
        query(`SELECT person_id, source, starts_at, ends_at FROM busy_blocks
                WHERE person_id = ANY($1) AND ends_at > $2 AND starts_at < $3`, [personIds, from, to]),
    ]);
    const windows: WeeklyWindow[] = w.rows.map((r) => ({
        personId: r.person_id, weekday: r.weekday, start: hhmm(r.start_time), end: hhmm(r.end_time), timeZone: r.time_zone,
    }));
    const exceptions: AvailabilityException[] = x.rows.map((r) => ({
        personId: r.person_id, start: r.starts_at, end: r.ends_at, kind: r.kind,
    }));
    // Only the interval goes on: the math never learns where busy time came from.
    const busy: BusyBlock[] = b.rows
        .filter((r) => !skip.has(busySkipKey(r.person_id, r.source)))
        .map((r) => ({ personId: r.person_id, start: r.starts_at, end: r.ends_at }));
    return { windows, exceptions, busy };
}

/** Parses and bounds the range/slot query parameters every overlap takes. */
export function cleanRange(q: { start?: unknown; end?: unknown; slotMinutes?: unknown; stepMinutes?: unknown },
                           defaults: { slotMinutes: number; stepMinutes: number }) {
    const start = new Date(String(q.start ?? "")), end = new Date(String(q.end ?? ""));
    if (isNaN(+start) || isNaN(+end)) throw new AvailabilityError(400, "start and end must be ISO date-times.");
    if (end <= start) throw new AvailabilityError(400, "end must be after start.");
    if (+end - +start > MAX_RANGE_DAYS * DAY) throw new AvailabilityError(400, `A range can cover at most ${MAX_RANGE_DAYS} days.`);
    const int = (v: unknown, dflt: number, min: number, max: number, name: string) => {
        if (v === undefined || v === "") return dflt;
        const n = Number(v);
        if (!Number.isInteger(n) || n < min || n > max) throw new AvailabilityError(400, `${name} must be a whole number from ${min} to ${max}.`);
        return n;
    };
    return {
        range: { start, end },
        slotMinutes: int(q.slotMinutes, defaults.slotMinutes, 15, 24 * 60, "slotMinutes"),
        stepMinutes: int(q.stepMinutes, defaults.stepMinutes, 15, 24 * 60, "stepMinutes"),
    };
}

export interface PartyMember { id: string; name: string }

/** The campaign's party: every member with an account, in joining order. */
export async function campaignParty(campaignId: string): Promise<PartyMember[]> {
    const { rows } = await query(
        `SELECT a.id, a.handle, a.name, a.first_name, a.last_name, a.email
           FROM campaign_members m JOIN accounts a ON a.id = m.person_id
          WHERE m.campaign_id = $1
          ORDER BY m.joined_at NULLS LAST, m.created_at, a.id`, [campaignId]);
    const party = new Map<string, PartyMember>();
    for (const r of rows) {
        if (party.has(r.id)) continue;   // one person, one seat, however many member rows
        party.set(r.id, {
            id: r.id,
            name: personDisplayName({ handle: r.handle, name: r.name, firstName: r.first_name, lastName: r.last_name, email: r.email }),
        });
    }
    return [...party.values()];
}

const toSlotJson = (s: Slot) => ({
    start: s.start.toISOString(), end: s.end.toISOString(),
    headcount: s.headcount, meetsQuorum: s.meetsQuorum,
    free: s.free, busy: s.busy, unknown: s.unknown,
});

/**
 * When the campaign's party is free over `range`: every slot, ranked by
 * headcount, with who is free / busy / unknown. Never says why someone is
 * busy -- the data to say so is not loaded, let alone returned. Busy sources
 * are synced first when stale (busySources.ts); one that fails falls back to
 * that person's windows and exceptions rather than failing the overlap.
 */
export async function campaignOverlap(campaignId: string, opts: ReturnType<typeof cleanRange>, now = new Date()) {
    const { rows: [campaign] } = await query(`SELECT quorum FROM campaigns WHERE id = $1`, [campaignId]);
    if (!campaign) throw new AvailabilityError(404, "Campaign not found.");
    const party = await campaignParty(campaignId);
    const ids = party.map((p) => p.id);
    const quorum = resolveQuorum(campaign.quorum, ids.length);
    const skip = await refreshBusy(ids, opts.range, now);
    const slots = computeOverlap({ party: ids, ...await loadAvailability(ids, opts.range, skip), quorum, ...opts });
    return {
        range: { start: opts.range.start.toISOString(), end: opts.range.end.toISOString() },
        slotMinutes: opts.slotMinutes, stepMinutes: opts.stepMinutes,
        quorum, party, slots: slots.map(toSlotJson),
    };
}

/**
 * "What the party sees about me" (#57, story 8): my free / busy / unknown
 * over `range`, as contiguous runs in time order -- exactly what an overlap
 * would report for me, and no more.
 */
export async function myPreview(personId: string, opts: ReturnType<typeof cleanRange>, now = new Date()) {
    const skip = await refreshBusy([personId], opts.range, now);
    const slots = computeOverlap({
        party: [personId], ...await loadAvailability([personId], opts.range, skip),
        quorum: 1, range: opts.range, slotMinutes: opts.stepMinutes, stepMinutes: opts.stepMinutes,
    }).sort((a, b) => a.start.getTime() - b.start.getTime());
    const runs: { start: string; end: string; presence: "free" | "busy" | "unknown" }[] = [];
    for (const s of slots) {
        const presence = s.free.length ? "free" : s.busy.length ? "busy" : "unknown";
        const last = runs[runs.length - 1];
        if (last && last.presence === presence && last.end === s.start.toISOString()) last.end = s.end.toISOString();
        else runs.push({ start: s.start.toISOString(), end: s.end.toISOString(), presence });
    }
    return { range: { start: opts.range.start.toISOString(), end: opts.range.end.toISOString() }, runs };
}
