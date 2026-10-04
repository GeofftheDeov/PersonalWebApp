/**
 * Busy sources (#84, part of #57): outside calendars a person lets count as
 * busy time, and the sync that keeps their busy_blocks fresh enough for the
 * overlap.
 *
 * A source is one adapter: Google Calendar (googleBusySource.ts) or Discord
 * events the person marked "interested" (discordBusySource.ts, #85). An adapter says whether a person can use it and fetches their
 * busy intervals for a stretch of time. This module owns everything else:
 * the on/off switch (busy_sources), replacing that source's busy_blocks, the
 * freshness rule, and failure handling. It stores start and end only -- an
 * adapter has no way to hand it a title -- and nothing it writes reaches the
 * party except as "busy".
 *
 * Freshness rule. When an overlap or a preview is computed for a range, each
 * person's enabled source is synced first unless its last good sync is both
 *   - younger than FRESH_MINUTES (15), and
 *   - covers the whole range (synced_from <= range start, synced_to >= range end).
 * A sync always asks for the next HORIZON_DAYS (28) days -- what the Notice
 * Board and the profile preview look at -- stretched to take in the range
 * (with a day of slack either side), so ranges near each other share one sync
 * instead of evicting each other. Only when that would exceed MAX_SYNC_DAYS
 * (Google refuses one free/busy query longer than about three months) does it
 * ask for the range alone. A sync replaces that source's blocks inside the
 * stretch it asked about and leaves the rest alone, so a far-off sync never
 * wipes the busy time a nearer overlap is about to read.
 *
 * Failure rule. If a sync fails (or takes longer than SYNC_TIMEOUT_MS), that
 * person's blocks from that source are left out of overlaps until a sync
 * works again, so the overlap still loads and falls back to their windows and
 * exceptions. The failure is recorded for the owner to see on their
 * Availability tab, and the source isn't retried for
 * RETRY_AFTER_FAILURE_MINUTES (5) unless the owner asks ("Sync now"), so a
 * broken connection doesn't slow every page load.
 *
 * To add a source: write a BusySourceAdapter and add it to ADAPTERS (and to
 * the source CHECKs on busy_sources and busy_blocks).
 */
import { query, withTransaction } from "../db/index.js";
import { bus } from "../events/index.js";
import { googleBusySource } from "./googleBusySource.js";
import { discordBusySource } from "./discordBusySource.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export const FRESH_MINUTES = 15;
export const RETRY_AFTER_FAILURE_MINUTES = 5;
export const HORIZON_DAYS = 28;
/** The longest stretch one sync asks for. */
export const MAX_SYNC_DAYS = 70;
export const SYNC_TIMEOUT_MS = 15_000;
/** More than this from one sync is cut off: nobody has 1,000 commitments in two months. */
export const MAX_BLOCKS_PER_SYNC = 1000;

export type BusySourceName = "google" | "discord";

/** One stretch of busy time, as an adapter reports it. There is deliberately no room for a title. */
export interface FetchedBusy {
    start: Date;
    end: Date;
    /** Discord scheduled-event id, say. Google free/busy has none. Never shown to anyone. */
    externalId?: string | null;
}

export interface SourceConnection {
    /** The account link exists (e.g. Google Calendar is connected). */
    connected: boolean;
    /** The source can be turned on and synced right now. */
    ready: boolean;
    /** Connected, but the grant lacks what this needs: the owner must reconnect once. */
    needsReconsent: boolean;
    /** Why it isn't ready, worded for the owner. */
    problem: string | null;
}

export interface BusySourceAdapter {
    name: BusySourceName;
    connection(personId: string): Promise<SourceConnection>;
    /**
     * The person's busy time between start and end. Throw to fail the sync;
     * the error's message is shown to the person (only), so word it for them.
     * `manual` is set when the person asked ("Sync now", or turning it on):
     * don't answer from anything cached.
     */
    fetchBusy(personId: string, range: { start: Date; end: Date }, opts?: { manual?: boolean }): Promise<FetchedBusy[]>;
}

const ADAPTERS: Partial<Record<BusySourceName, BusySourceAdapter>> = {
    google: googleBusySource,
    discord: discordBusySource,
};

/** A 4xx the route can hand straight back to the page. */
export class BusySourceError extends Error {
    constructor(public status: number, message: string) { super(message); }
}

export interface BusySourceStatus extends SourceConnection {
    source: BusySourceName;
    enabled: boolean;
    /** Last good sync. */
    syncedAt: string | null;
    /** Set while the most recent attempt failed. */
    lastError: string | null;
    freshMinutes: number;
}

interface SourceRow {
    person_id: string;
    source: BusySourceName;
    synced_at: Date | null;
    synced_from: Date | null;
    synced_to: Date | null;
    last_attempt_at: Date | null;
    last_error: string | null;
}

function adapterFor(source: string): BusySourceAdapter {
    const adapter = ADAPTERS[source as BusySourceName];
    if (!adapter) throw new BusySourceError(404, "Unknown busy source.");
    return adapter;
}

/** How refreshBusy names a person's source whose blocks must be left out. */
export const busySkipKey = (personId: string, source: string) => `${personId}|${source}`;

function announce(personId: string) {
    bus.publish("availability.changed", { personId, what: "busy" }).catch(() => { /* bus down is non-fatal */ });
}

/** What one sync asks for: the planning horizon stretched over the range, or the range alone when that's too long. */
export function syncWindow(range: { start: Date; end: Date }, now: Date) {
    const padded = { start: range.start.getTime() - DAY, end: range.end.getTime() + DAY };
    const start = Math.min(now.getTime() - DAY, padded.start);
    const end = Math.max(now.getTime() + (HORIZON_DAYS + 1) * DAY, padded.end);
    if (end - start <= MAX_SYNC_DAYS * DAY) return { start: new Date(start), end: new Date(end) };
    return { start: new Date(padded.start), end: new Date(padded.end) };
}

/** A failed attempt since the last good sync means nothing from this source is trusted until one works. */
function isFresh(row: SourceRow, range: { start: Date; end: Date }, now: Date) {
    return !row.last_error && !!row.synced_at && row.synced_at.getTime() > now.getTime() - FRESH_MINUTES * MINUTE &&
        row.synced_from! <= range.start && row.synced_to! >= range.end;
}

function recentlyFailed(row: SourceRow, now: Date) {
    return !!row.last_error && !!row.last_attempt_at &&
        row.last_attempt_at.getTime() > now.getTime() - RETRY_AFTER_FAILURE_MINUTES * MINUTE;
}

/** Valid intervals only, clipped to the window, at most MAX_BLOCKS_PER_SYNC, in time order. */
function cleanBlocks(fetched: FetchedBusy[], window: { start: Date; end: Date }) {
    const lo = window.start.getTime(), hi = window.end.getTime();
    const out: { start: Date; end: Date; externalId: string | null }[] = [];
    for (const b of Array.isArray(fetched) ? fetched : []) {
        const s = Math.max(new Date(b?.start as any).getTime(), lo);
        const e = Math.min(new Date(b?.end as any).getTime(), hi);
        if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
        const externalId = typeof b.externalId === "string" ? b.externalId.slice(0, 200) : null;
        out.push({ start: new Date(s), end: new Date(e), externalId });
    }
    return out.sort((a, b) => a.start.getTime() - b.start.getTime()).slice(0, MAX_BLOCKS_PER_SYNC);
}

const signature = (blocks: { start: Date; end: Date }[]) =>
    blocks.map((b) => `${b.start.getTime()}-${b.end.getTime()}`).sort().join();

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout;
    return Promise.race([
        p.finally(() => clearTimeout(timer)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
}

/** Sync one source for one person over `window`. True when it worked. */
async function syncOne(personId: string, adapter: BusySourceAdapter, window: { start: Date; end: Date }, now: Date, manual = false) {
    let blocks: ReturnType<typeof cleanBlocks>;
    try {
        blocks = cleanBlocks(await withTimeout(adapter.fetchBusy(personId, window, { manual }), SYNC_TIMEOUT_MS,
            "The calendar took too long to answer."), window);
    } catch (err: any) {
        const message = String(err?.message || "The calendar couldn't be read.").slice(0, 300);
        // Recording the failure must not fail the overlap that asked.
        await query(`UPDATE busy_sources SET last_attempt_at = $3, last_error = $4 WHERE person_id = $1 AND source = $2`,
            [personId, adapter.name, now, message])
            .catch((e: any) => console.error(`[busy] recording a ${adapter.name} sync failure failed:`, e.message));
        return false;
    }
    try {
        const changed = await withTransaction(async (db) => {
            // Lock the switch: a source turned off mid-sync stays off and empty,
            // and two overlaps syncing at once can't both insert.
            const { rowCount } = await db.query(
                `SELECT 1 FROM busy_sources WHERE person_id = $1 AND source = $2 FOR UPDATE`, [personId, adapter.name]);
            if (!rowCount) return false;
            const { rows: old } = await db.query(
                `DELETE FROM busy_blocks WHERE person_id = $1 AND source = $2 AND ends_at > $3 AND starts_at < $4
                 RETURNING starts_at AS start, ends_at AS "end"`,
                [personId, adapter.name, window.start, window.end]);
            if (blocks.length) {
                await db.query(
                    `INSERT INTO busy_blocks (person_id, source, starts_at, ends_at, external_id, fetched_at)
                     SELECT $1, $2, t.s, t.e, t.x, $6
                       FROM unnest($3::timestamptz[], $4::timestamptz[], $5::text[]) AS t(s, e, x)`,
                    [personId, adapter.name, blocks.map((b) => b.start), blocks.map((b) => b.end),
                     blocks.map((b) => b.externalId), now]);
            }
            await db.query(
                `UPDATE busy_sources SET synced_at = $3, synced_from = $4, synced_to = $5, last_attempt_at = $3, last_error = NULL
                  WHERE person_id = $1 AND source = $2`, [personId, adapter.name, now, window.start, window.end]);
            return signature(old) !== signature(blocks);
        });
        if (changed) announce(personId);
        return true;
    } catch (err: any) {
        console.error(`[busy] saving ${adapter.name} busy time failed:`, err.message);
        await query(`UPDATE busy_sources SET last_attempt_at = $3, last_error = $4 WHERE person_id = $1 AND source = $2`,
            [personId, adapter.name, now, "Busy time couldn't be saved. Try again later."]).catch(() => {});
        return false;
    }
}

/**
 * Bring these people's busy sources up to date for `range` (the freshness
 * rule above). Returns the "<personId>|<source>" pairs whose blocks must be
 * left out because their calendar couldn't be read: their overlap falls back
 * to windows and exceptions.
 */
export async function refreshBusy(personIds: string[], range: { start: Date; end: Date }, now: Date): Promise<Set<string>> {
    const skip = new Set<string>();
    if (!personIds.length) return skip;
    const { rows } = await query<SourceRow>(`SELECT * FROM busy_sources WHERE person_id = ANY($1)`, [personIds]);
    await Promise.all(rows.map(async (row) => {
        const adapter = ADAPTERS[row.source];
        if (!adapter || isFresh(row, range, now)) return;
        if (recentlyFailed(row, now) || !(await syncOne(row.person_id, adapter, syncWindow(range, now), now))) {
            skip.add(busySkipKey(row.person_id, row.source));
        }
    }));
    return skip;
}

async function statusOf(personId: string, adapter: BusySourceAdapter, row: SourceRow | undefined): Promise<BusySourceStatus> {
    return {
        source: adapter.name,
        enabled: !!row,
        ...await adapter.connection(personId),
        syncedAt: row?.synced_at?.toISOString() ?? null,
        lastError: row?.last_error ?? null,
        freshMinutes: FRESH_MINUTES,
    };
}

async function rowOf(personId: string, source: BusySourceName): Promise<SourceRow | undefined> {
    const { rows: [row] } = await query<SourceRow>(
        `SELECT * FROM busy_sources WHERE person_id = $1 AND source = $2`, [personId, source]);
    return row;
}

/** Every source this server offers, with the person's switch and sync state. */
export async function listBusySources(personId: string): Promise<BusySourceStatus[]> {
    const { rows } = await query<SourceRow>(`SELECT * FROM busy_sources WHERE person_id = $1`, [personId]);
    return Promise.all(Object.values(ADAPTERS).map((a) => statusOf(personId, a!, rows.find((r) => r.source === a!.name))));
}

export async function getBusySource(personId: string, source: string): Promise<BusySourceStatus> {
    const adapter = adapterFor(source);
    return statusOf(personId, adapter, await rowOf(personId, adapter.name));
}

/** Turns a source on and syncs it straight away. A failed first sync still leaves it on. */
export async function enableBusySource(personId: string, source: string, now: Date): Promise<BusySourceStatus> {
    const adapter = adapterFor(source);
    const conn = await adapter.connection(personId);
    if (!conn.ready) throw new BusySourceError(409, conn.problem || "This source can't be turned on yet.");
    await query(`INSERT INTO busy_sources (person_id, source, enabled_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [personId, adapter.name, now]);
    await syncOne(personId, adapter, syncWindow({ start: now, end: now }, now), now, true);
    return getBusySource(personId, adapter.name);
}

/** Re-reads the calendar now, whatever the freshness rule says. 404 when the source is off. */
export async function syncBusySourceNow(personId: string, source: string, now: Date): Promise<BusySourceStatus> {
    const adapter = adapterFor(source);
    if (!(await rowOf(personId, adapter.name))) throw new BusySourceError(404, "That source is off.");
    await syncOne(personId, adapter, syncWindow({ start: now, end: now }, now), now, true);
    return getBusySource(personId, adapter.name);
}

/** Turns a source off and deletes every busy block it brought in. */
export async function disableBusySource(personId: string, source: string): Promise<void> {
    const adapter = adapterFor(source);
    const removed = await withTransaction(async (db) => {
        const sources = await db.query(`DELETE FROM busy_sources WHERE person_id = $1 AND source = $2`, [personId, adapter.name]);
        const blocks = await db.query(`DELETE FROM busy_blocks WHERE person_id = $1 AND source = $2`, [personId, adapter.name]);
        return (sources.rowCount ?? 0) + (blocks.rowCount ?? 0);
    });
    if (removed) announce(personId);
}
