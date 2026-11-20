/**
 * The Almanac (#228, spec #69): layout B, "Chronicle", from
 * prototype/hearthside-almanac. The rules the page follows, kept apart from
 * React so they can be tested (test/almanac.test.ts). Today's data only:
 *
 *   GET /api/quests/almanac?start&end   my dated sessions in [start, end) (not cancelled), each with my quests on it
 *   GET /api/campaigns                  my campaigns, for their banners
 *
 * Days are the viewer's own (local time): a session belongs to every day
 * from the one it starts on to the one it ends on, and weeks start on Monday.
 */
import type { Quest } from './quests';
import { sessionPhase, timeSpan, type SessionPhase } from './sessionPage';

/** A session as the Almanac API sends it. Every one has a night; sessions still picking one are #201's. */
export interface AlmanacSession {
  id: string;
  title: string;
  date: string;
  endDate: string | null;
  status: string;
  isOnline: boolean;
  location: string | null;
  campaign: { id: string; title: string };
  /** Mine only, open or done. */
  quests: Quest[];
}

export interface AlmanacReply {
  sessions: AlmanacSession[];
}

// ── filters ─────────────────────────────────────────────────────────────────

/** Where a session is played. */
export type Where = 'all' | 'person' | 'online';

export const WHERE_OPTIONS: readonly { id: Where; label: string }[] = [
  { id: 'all', label: 'Anywhere' },
  { id: 'person', label: 'In person' },
  { id: 'online', label: 'Online' },
];

/** Any number of campaigns (none picked means all), and anywhere, in person or online. */
export interface AlmanacFilter {
  campaigns: readonly string[];
  where: Where;
}

export const NO_FILTER: AlmanacFilter = { campaigns: [], where: 'all' };

export const isFiltered = (f: AlmanacFilter): boolean => f.campaigns.length > 0 || f.where !== 'all';

export function matches(s: Pick<AlmanacSession, 'campaign' | 'isOnline'>, f: AlmanacFilter): boolean {
  if (f.campaigns.length && !f.campaigns.includes(s.campaign.id)) return false;
  return f.where === 'all' || (f.where === 'online') === !!s.isOnline;
}

export const applyFilter = <T extends Pick<AlmanacSession, 'campaign' | 'isOnline'>>(sessions: readonly T[], f: AlmanacFilter): T[] =>
  sessions.filter((s) => matches(s, f));

/** Picks or unpicks one campaign. */
export function toggleCampaign(f: AlmanacFilter, id: string): AlmanacFilter {
  return { ...f, campaigns: f.campaigns.includes(id) ? f.campaigns.filter((c) => c !== id) : [...f.campaigns, id] };
}

/** The campaigns the filter offers: every campaign with a session in the Almanac, by name. */
export function campaignChoices(sessions: readonly AlmanacSession[]): { id: string; title: string }[] {
  const byId = new Map<string, string>();
  for (const s of sessions) if (!byId.has(s.campaign.id)) byId.set(s.campaign.id, s.campaign.title);
  return [...byId].map(([id, title]) => ({ id, title })).sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * How many sessions coming up each choice would leave, given the rest of the
 * filter: each campaign with the current place, and each place with the
 * current campaigns.
 */
export function filterCounts(sessions: readonly AlmanacSession[], f: AlmanacFilter, now: Date) {
  const ahead = almanacLists(sessions, now).comingUp;
  const campaigns: Record<string, number> = {};
  for (const c of campaignChoices(sessions)) campaigns[c.id] = applyFilter(ahead, { campaigns: [c.id], where: f.where }).length;
  const where = Object.fromEntries(WHERE_OPTIONS.map((w) => [w.id, applyFilter(ahead, { ...f, where: w.id }).length])) as Record<Where, number>;
  return { campaigns, where };
}

// ── days ────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const firstOfMonth = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), 1);
export const addMonths = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth() + n, 1);
/** The Monday of the week a day is in. */
export const mondayOf = (d: Date): Date => addDays(startOfDay(d), -((d.getDay() + 6) % 7));
export const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** A day as a key: "2026-11-26" (local). */
export const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function fromDayKey(k: string): Date {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** A session longer than this is drawn on its first fortnight only. */
const MAX_SPAN_DAYS = 14;

/**
 * The days a session is on: the day it starts to the day it ends. One that
 * ends at midnight doesn't spill onto the next day.
 */
export function sessionDays(s: Pick<AlmanacSession, 'date' | 'endDate'>): Date[] {
  const start = new Date(s.date);
  const endAt = s.endDate ? new Date(Date.parse(s.endDate) - 1) : start;
  const last = startOfDay(endAt < start ? start : endAt);
  const out: Date[] = [];
  for (let d = startOfDay(start); d <= last && out.length < MAX_SPAN_DAYS; d = addDays(d, 1)) out.push(d);
  return out;
}

export const isOnDay = (s: Pick<AlmanacSession, 'date' | 'endDate'>, day: Date): boolean =>
  sessionDays(s).some((d) => sameDay(d, day));

export const sessionsOn = (sessions: readonly AlmanacSession[], day: Date): AlmanacSession[] =>
  sessions.filter((s) => isOnDay(s, day));

/**
 * Quests on a day of the calendar: the ones due that day, unless that's a
 * day of their own session (then they're on its sheet with it, as the
 * prototype decided).
 */
export function questsDueOn(sessions: readonly AlmanacSession[], day: Date): Quest[] {
  const out: Quest[] = [];
  for (const s of sessions) {
    for (const q of s.quests) {
      if (!q.dueAt || q.status === 'cancelled') continue;
      const due = new Date(q.dueAt);
      if (sameDay(due, day) && !isOnDay(s, due)) out.push(q);
    }
  }
  return out.sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!));
}

/** The month's grid: whole weeks, Monday first, with the neighbouring months' days to fill them. */
export function monthDays(month: Date): Date[] {
  const first = firstOfMonth(month);
  const start = mondayOf(first);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const weeks = Math.ceil((Math.round((last.getTime() - start.getTime()) / DAY_MS) + 1) / 7);
  return Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
}

export const weekDays = (monday: Date): Date[] => Array.from({ length: 7 }, (_, i) => addDays(monday, i));

/**
 * The day the calendar opens on in a span of days: the first from today with
 * something on it, else today, else the first day with something on it, else
 * the first day.
 */
export function firstDay(days: readonly Date[], now: Date, busy: (d: Date) => boolean): Date {
  const today = startOfDay(now);
  return days.find((d) => d >= today && busy(d)) ?? days.find((d) => sameDay(d, today)) ?? days.find(busy) ?? days[0];
}

/** "Thursday, November 26". */
export const longDayName = (d: Date): string => `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
/** "Thu Nov 26". */
export const shortDay = (d: Date): string => `${WD[d.getDay()]} ${MON[d.getMonth()]} ${d.getDate()}`;
export const weekdayShort = (d: Date): string => WD[d.getDay()];
/** "November 2026". */
export const monthTitle = (d: Date): string => `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

/** "Nov 16 – 22", or "Nov 30 – Dec 6" across a month. */
export function spanLabel(a: Date, b: Date): string {
  return `${MON[a.getMonth()]} ${a.getDate()} – ${a.getMonth() === b.getMonth() ? '' : `${MON[b.getMonth()]} `}${b.getDate()}`;
}

/** The calendar's week: "Nov 16 – 22, 2026", "Dec 28, 2026 – Jan 3, 2027". */
export function weekTitle(monday: Date): string {
  const end = addDays(monday, 6);
  if (end.getFullYear() !== monday.getFullYear()) {
    return `${MON[monday.getMonth()]} ${monday.getDate()}, ${monday.getFullYear()} – ${MON[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
  }
  return `${spanLabel(monday, end)}, ${end.getFullYear()}`;
}

/** The list's week headings: "This week · Nov 16 – 22", "Next week · …", "Week of …". */
export function weekLabel(monday: Date, now: Date): string {
  const diff = Math.round((monday.getTime() - mondayOf(now).getTime()) / (7 * DAY_MS));
  const span = spanLabel(monday, addDays(monday, 6));
  return diff === 0 ? `This week · ${span}` : diff === 1 ? `Next week · ${span}` : `Week of ${span}`;
}

// ── sessions ────────────────────────────────────────────────────────────────

/** Where it's played: "Online", its place, or that the place isn't settled. */
export const placeLine = (s: Pick<AlmanacSession, 'isOnline' | 'location'>): string =>
  s.isOnline ? 'Online' : s.location?.trim() || 'Place to be decided';

/** "Thu Nov 26 · 7:30–10 pm", or across days: "Fri Nov 27, 6 pm – Sun Nov 29, 2 pm". */
export function whenLine(s: Pick<AlmanacSession, 'date' | 'endDate'>): string {
  const start = new Date(s.date);
  if (s.endDate && !sameDay(start, new Date(s.endDate))) {
    return `${shortDay(start)}, ${timeSpan(s.date)} – ${shortDay(new Date(s.endDate))}, ${timeSpan(s.endDate)}`;
  }
  return `${shortDay(start)} · ${timeSpan(s.date, s.endDate)}`;
}

/**
 * A session's time on one of its days in the calendar: its start (and end)
 * on its first day, then "Until 2 pm" on its last and "All day" between.
 */
export function timeOnDay(s: Pick<AlmanacSession, 'date' | 'endDate'>, day: Date, withEnd: boolean): string {
  const start = new Date(s.date);
  const sameDayEnd = !s.endDate || sameDay(start, new Date(s.endDate));
  if (sameDay(start, day)) return withEnd ? (sameDayEnd ? timeSpan(s.date, s.endDate) : `${timeSpan(s.date)} onward`) : timeSpan(s.date);
  if (s.endDate && sameDay(new Date(s.endDate), day)) return `Until ${timeSpan(s.endDate)}`;
  return 'All day';
}

/** Where a session stands, by the session page's rule (the backend never marks one played). */
export const phaseOf = (s: AlmanacSession, now: Date): SessionPhase => sessionPhase(s, now);

/** The seal on a session's sheet. */
export function sealOf(s: AlmanacSession, now: Date): { label: string; cls: string } {
  const phase = phaseOf(s, now);
  if (phase === 'cancelled') return { label: 'Cancelled', cls: 'hs-seal is-cancelled' };
  if (phase === 'after') return { label: 'Played', cls: 'hs-seal is-ok' };
  if (s.status === 'planning') return { label: 'Being planned', cls: 'hs-seal is-planning' };
  return { label: 'Night set', cls: 'hs-seal is-ok' };
}

/**
 * Coming up and Played. Coming up is every session not over yet, soonest
 * first (cancelled ones still to come stay, outlined); Played is the ones
 * that are over, latest first. A played session is the same one the
 * campaign's page lists under Previous sessions (`sessionPhase`).
 */
export function almanacLists(sessions: readonly AlmanacSession[], now: Date) {
  const comingUp: AlmanacSession[] = [];
  const played: AlmanacSession[] = [];
  const today = startOfDay(now).getTime();
  for (const s of sessions) {
    const phase = phaseOf(s, now);
    if (phase === 'after') played.push(s);
    else if (phase === 'before' || Date.parse(s.date) >= today) comingUp.push(s);
  }
  const at = (s: AlmanacSession) => Date.parse(s.date);
  comingUp.sort((a, b) => at(a) - at(b) || a.id.localeCompare(b.id));
  played.sort((a, b) => at(b) - at(a) || a.id.localeCompare(b.id));
  return { comingUp, played };
}

export interface ChronicleDay {
  day: Date;
  sessions: AlmanacSession[];
}

export interface ChronicleWeek {
  monday: Date;
  label: string;
  days: ChronicleDay[];
}

/**
 * The list: sessions coming up, by week, each under the day it starts on (a
 * session already under way since an earlier day sits on today).
 */
export function chronicleWeeks(comingUp: readonly AlmanacSession[], now: Date): ChronicleWeek[] {
  const today = startOfDay(now);
  const weeks: ChronicleWeek[] = [];
  for (const s of comingUp) {
    const start = startOfDay(new Date(s.date));
    const day = start < today ? today : start;
    const monday = mondayOf(day);
    let week = weeks.find((w) => sameDay(w.monday, monday));
    if (!week) weeks.push((week = { monday, label: weekLabel(monday, now), days: [] }));
    let entry = week.days.find((d) => sameDay(d.day, day));
    if (!entry) week.days.push((entry = { day, sessions: [] }));
    entry.sessions.push(s);
  }
  weeks.sort((a, b) => a.monday.getTime() - b.monday.getTime());
  for (const w of weeks) w.days.sort((a, b) => a.day.getTime() - b.day.getTime());
  return weeks;
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** Under the heading: "2 sessions in the next four weeks · 3 quests open". */
export function headLine(sessions: readonly AlmanacSession[], now: Date): string {
  const { comingUp } = almanacLists(sessions, now);
  const horizon = now.getTime() + 28 * DAY_MS;
  const soon = comingUp.filter((s) => phaseOf(s, now) === 'before' && Date.parse(s.date) < horizon).length;
  const open = comingUp.filter((s) => phaseOf(s, now) === 'before')
    .reduce((n, s) => n + s.quests.filter((q) => q.status === 'open').length, 0);
  return `${plural(soon, 'session')} in the next four weeks · ${plural(open, 'quest')} open`;
}

/** "2 open", "all done", for the quests on a sheet. */
export function questsLine(quests: readonly Quest[]): string {
  const open = quests.filter((q) => q.status === 'open').length;
  return open ? `${open} open` : 'all done';
}

/** A day's label for its button: "Thursday, November 26, 1 session, 2 quests". */
export function dayButtonLabel(day: Date, sessions: number, quests: number): string {
  return [longDayName(day), sessions && plural(sessions, 'session'), quests && plural(quests, 'quest')].filter(Boolean).join(', ');
}

// ── quests ──────────────────────────────────────────────────────────────────

/** A quest ticked in Your Quests shows done here too. */
export function withRail(sessions: readonly AlmanacSession[], rail: readonly Quest[]): AlmanacSession[] {
  const done = new Set(rail.filter((q) => q.status === 'done').map((q) => q.id));
  if (!done.size) return [...sessions];
  return sessions.map((s) => s.quests.some((q) => q.status === 'open' && done.has(q.id))
    ? { ...s, quests: s.quests.map((q) => (q.status === 'open' && done.has(q.id) ? { ...q, status: 'done' as const } : q)) }
    : s);
}

/** Changes one quest wherever it is. */
export function setQuest(sessions: readonly AlmanacSession[], id: string, change: (q: Quest) => Quest): AlmanacSession[] {
  return sessions.map((s) => s.quests.some((q) => q.id === id) ? { ...s, quests: s.quests.map((q) => (q.id === id ? change(q) : q)) } : s);
}

// ── what to fetch ───────────────────────────────────────────────────────────

/** The API takes up to 400 days at once: the list reads half a year back and a little more ahead. */
export const PAST_DAYS = 182;
export const AHEAD_DAYS = 214;

export interface Range {
  start: Date;
  end: Date;
}

/** The first read: from half a year ago to seven months ahead, in whole days. */
export function firstRange(now: Date): Range {
  const today = startOfDay(now);
  return { start: addDays(today, -PAST_DAYS), end: addDays(today, AHEAD_DAYS) };
}

/** The days a span of the calendar shows, as a range to read: the first day to the day after the last. */
export const rangeOf = (days: readonly Date[]): Range => ({ start: days[0], end: addDays(days[days.length - 1], 1) });

/** Has a range already been read? Ranges read are kept as they came, so it must sit inside one. */
export const covered = (read: readonly Range[], r: Range): boolean =>
  read.some((x) => x.start <= r.start && x.end >= r.end);

/**
 * A newer read of a range replaces what was known about it: sessions in it
 * that it no longer sends (moved away, or cancelled) go.
 */
export function mergeRange(known: readonly AlmanacSession[], r: Range, fresh: readonly AlmanacSession[]): AlmanacSession[] {
  const ids = new Set(fresh.map((s) => s.id));
  const inside = (s: AlmanacSession) => { const t = Date.parse(s.date); return t >= r.start.getTime() && t < r.end.getTime(); };
  return [...known.filter((s) => !ids.has(s.id) && !inside(s)), ...fresh];
}
