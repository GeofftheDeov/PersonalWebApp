/**
 * The overlap picker (#225, spec #69): when the party is free, for the GM
 * choosing nights to put to a vote, as the portfolio's OverlapPicker has it
 * (`frontend/src/components/OverlapPicker.tsx`, #57). The grid is turned
 * round from the portfolio's, as the campaign-page prototype decided: days are
 * the columns and start times the rows, so it reads like a calendar. Kept
 * apart from React so the rules are tested on their own
 * (test/overlap.test.ts).
 *
 *   GET /api/availability/campaigns/:id?start&end&slotMinutes&stepMinutes   (the GM only)
 */
import { optionWhen } from './noticeBoard';

/** One possible start time and how many of the party are free for the whole session from it. */
export interface Slot {
  start: string;
  end: string;
  headcount: number;
  meetsQuorum: boolean;
  free: string[];
  busy: string[];
  unknown: string[];
}

export interface Overlap {
  quorum: number;
  party: { id: string; name: string }[];
  slots: Slot[];
  /** Why some busy time may be missing (say, Discord can't be read). Names no player. */
  notes?: string[];
}

/** A night on the shortlist, as `shortlist`, `reshortlist` and `reopen` take it. */
export interface PickedTime {
  start: string;
  end: string;
}

/** A shortlist holds two to four nights. */
export const MIN_PICKS = 2;
export const MAX_PICKS = 4;
export const DAY_CHOICES = [7, 14, 21, 28] as const;
export const HOUR_CHOICES = [2, 3, 4, 5, 6] as const;

const pad = (n: number) => String(n).padStart(2, '0');

/** A local calendar day as a date field holds it: "2026-11-20". */
export const toDateInput = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** A date field's value as local midnight; null if it isn't a date. */
export function fromDateInput(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** The availability read's query: `days` from local midnight on `from`, sessions `hours` long, a start every half hour. */
export function overlapQuery(from: Date, days: number, hours: number): string {
  const end = new Date(from);
  end.setDate(end.getDate() + days);
  return new URLSearchParams({
    start: from.toISOString(), end: end.toISOString(), slotMinutes: String(hours * 60), stepMinutes: '30',
  }).toString();
}

/**
 * A cell's shade, as the design system's heat scale numbers it: 0 nobody
 * free, 1 to 4 more and more of the party, 5 everyone.
 */
export function heatLevel(headcount: number, partySize: number): number {
  if (headcount <= 0) return 0;
  if (partySize <= 0 || headcount >= partySize) return 5;
  return Math.min(4, Math.ceil((headcount / partySize) * 4));
}

export interface GridDay {
  /** Local midnight. */
  day: Date;
  /** "Fri". */
  weekday: string;
  /** "Nov 20" on the first column and the first of a month, otherwise "20". */
  label: string;
}

export interface OverlapGrid {
  /** The columns: one per day. */
  days: GridDay[];
  /** The rows: local hours (0-23), on the hour, from the earliest anyone is free to the latest. */
  hours: number[];
  /** `cells[row][column]`: the slot starting at that hour on that day, or null (none, or already past). */
  cells: (Slot | null)[][];
}

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short' });
const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short' });

/** A row's label: "7 pm", "12 pm", "9 am". */
export const hourLabel = (h: number): string => `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}`;

/**
 * The grid: days across, start times down. The rows run from the earliest
 * hour anyone is free on any day to the latest (5 pm to 10 pm when nobody
 * is). Times already past can't go on a shortlist, so their cells are empty.
 */
export function overlapGrid(data: Overlap, from: Date, days: number, now: Date): OverlapGrid {
  const future = data.slots.filter((s) => Date.parse(s.start) > now.getTime());
  const byStart = new Map(future.map((s) => [Date.parse(s.start), s]));
  let lo = 24, hi = -1;
  for (const s of data.slots) {
    const d = new Date(s.start);
    if (s.headcount && d.getMinutes() === 0) { lo = Math.min(lo, d.getHours()); hi = Math.max(hi, d.getHours()); }
  }
  if (hi < 0) { lo = 17; hi = 22; }
  const hours = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  const cols: GridDay[] = Array.from({ length: days }, (_, i) => {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    const label = i === 0 || day.getDate() === 1 ? `${MONTH.format(day)} ${day.getDate()}` : String(day.getDate());
    return { day, weekday: WEEKDAY.format(day), label };
  });
  const cells = hours.map((h) => cols.map(({ day }) =>
    byStart.get(new Date(day.getFullYear(), day.getMonth(), day.getDate(), h).getTime()) ?? null));
  return { days: cols, hours, cells };
}

/** The best times: the ranked slots anyone is free for, still to come, none overlapping one already listed. */
export function bestTimes(slots: readonly Slot[], now: Date, limit = 6): Slot[] {
  const out: Slot[] = [];
  for (const s of slots) {
    if (!s.headcount || Date.parse(s.start) <= now.getTime()) continue;
    if (out.some((o) => s.start < o.end && o.start < s.end)) continue;
    out.push(s);
    if (out.length === limit) break;
  }
  return out;
}

/** Picks or unpicks a slot: the shortlist stays in time order, and holds no more than four. */
export function togglePick(picked: readonly PickedTime[], slot: PickedTime): PickedTime[] {
  if (picked.some((p) => p.start === slot.start)) return picked.filter((p) => p.start !== slot.start);
  if (picked.length >= MAX_PICKS) return [...picked];
  return [...picked, { start: slot.start, end: slot.end }].sort((a, b) => a.start.localeCompare(b.start));
}

/** Who's free, busy or unknown for a slot, by name: "Busy: Isolde · Unknown: Tobin". */
export function whoLine(slot: Slot, names: ReadonlyMap<string, string>): string {
  const list = (ids: string[]) => ids.map((id) => names.get(id) ?? 'someone').join(', ');
  return [slot.busy.length ? `Busy: ${list(slot.busy)}` : '', slot.unknown.length ? `Unknown: ${list(slot.unknown)}` : '']
    .filter(Boolean).join(' · ');
}

/** A cell's or a best time's name: "Fri, Nov 20 · 7–11 pm: 3 of 4 free". */
export const slotName = (slot: Slot, partySize: number): string =>
  `${optionWhen(slot.start, slot.end)}: ${slot.headcount} of ${partySize} free`;
