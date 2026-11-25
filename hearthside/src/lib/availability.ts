/**
 * Your Room's Availability tab (#275): the portfolio profile's availability
 * editor (`frontend/src/components/AvailabilityEditor.tsx`, #57, #82, #84,
 * #85) on Hearthside. The rules the tab follows, kept apart from React so
 * they can be tested (test/availability.test.ts).
 *
 *   GET    /api/availability/me                       my week and upcoming exceptions
 *   PUT    /api/availability/me/windows               replace my week   { windows: [{ weekday, start, end, timeZone }] }
 *   POST   /api/availability/me/exceptions            add one           { start, end, kind, note }
 *   DELETE /api/availability/me/exceptions/:id        remove one
 *   GET    /api/availability/me/preview?start&end     what the party sees about me
 *   GET    /api/availability/me/busy-sources          Google Calendar and Discord events
 *   PUT | DELETE /api/availability/me/busy-sources/:s  turn one on or off; POST …/:s/sync re-reads it
 */

export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** How far ahead "What your party sees" looks: the coming two weeks, as on the portfolio. */
export const PREVIEW_DAYS = 14;
const HALF_HOUR = 30 * 60 * 1000;

/** One weekly window: a weekday and two "HH:MM" times in the week's time zone. */
export interface WeekWindow { weekday: number; start: string; end: string }

export interface AvailabilityException {
  id: string;
  start: string;
  end: string;
  kind: 'unavailable' | 'available';
  note: string | null;
}

export type Presence = 'free' | 'busy' | 'unknown';
export interface Run { start: string; end: string; presence: Presence }

/** `GET /api/availability/me/busy-sources`: one outside calendar. */
export interface BusySource {
  source: 'google' | 'discord';
  enabled: boolean;
  connected: boolean;
  ready: boolean;
  needsReconsent: boolean;
  problem: string | null;
  syncedAt: string | null;
  lastError: string | null;
  freshMinutes: number;
}

export const SOURCE_LABEL: Record<BusySource['source'], string> = { google: 'Google Calendar', discord: 'Discord events' };
export const SOURCE_HINT: Record<BusySource['source'], string> = {
  google: 'Busy times on your primary Google Calendar.',
  discord: 'Events you marked “Interested” in your campaigns’ Discord servers, matched by your Discord user ID.',
};

/** `GET /api/availability/me`: the week (each window carries its time zone) and what's ahead. */
export interface MyAvailability {
  windows: (WeekWindow & { timeZone?: string })[];
  exceptions: AvailabilityException[];
}

/** The week as the tab edits it: windows and the one time zone they're in. */
export interface Week { windows: WeekWindow[]; timeZone: string }

export function weekOf(data: MyAvailability, fallbackZone: string): Week {
  return {
    windows: data.windows.map((w) => ({ weekday: w.weekday, start: w.start, end: w.end })),
    timeZone: data.windows[0]?.timeZone ?? fallbackZone,
  };
}

/** Has the week changed since it was saved? */
export const weekChanged = (a: Week, b: Week): boolean => JSON.stringify(a) !== JSON.stringify(b);

/** What Save sends. */
export const windowsBody = (w: Week) => ({ windows: w.windows.map((r) => ({ ...r, timeZone: w.timeZone })) });

/** A new window: the day after the last one, at its times; else Saturday evening. */
export function nextWindow(windows: readonly WeekWindow[]): WeekWindow {
  const last = windows[windows.length - 1];
  return last ? { ...last, weekday: (last.weekday + 1) % 7 } : { weekday: 6, start: '18:00', end: '23:00' };
}

/** "18:30" → "6:30 PM"; "21:00" → "9 PM". */
export function clock(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

/** A window that ends before it starts runs past midnight: "Ends Sat 2 AM". Null for one that doesn't. */
export function overnightNote(w: WeekWindow): string | null {
  if (!w.start || !w.end || w.end >= w.start) return null;
  return `Ends ${DAYS[(w.weekday + 1) % 7]} ${clock(w.end)}`;
}

/* ---------- Exceptions ---------- */

export interface ExceptionDraft {
  kind: 'unavailable' | 'available';
  /** "YYYY-MM-DD", from the date field. */
  date: string;
  allDay: boolean;
  start: string;
  end: string;
  note: string;
}

export const blankException = (): ExceptionDraft =>
  ({ kind: 'unavailable', date: '', allDay: true, start: '18:00', end: '23:00', note: '' });

/**
 * The span an exception covers, in this device's local time: the whole day,
 * or from–until (an until at or before from runs into the next day). Or why
 * it can't be added.
 */
export function exceptionSpan(d: ExceptionDraft): { start: Date; end: Date } | { error: string } {
  if (!d.date) return { error: 'Pick a date.' };
  const [y, m, day] = d.date.split('-').map(Number);
  if (d.allDay) return { start: new Date(y, m - 1, day), end: new Date(y, m - 1, day + 1) };
  const [sh, sm] = d.start.split(':').map(Number);
  const [eh, em] = d.end.split(':').map(Number);
  const from = sh * 60 + sm, until = eh * 60 + em;
  if (from === until) return { error: 'Start and end can’t be the same time.' };
  return { start: new Date(y, m - 1, day, sh, sm), end: new Date(y, m - 1, day + (until < from ? 1 : 0), eh, em) };
}

const dayLabel = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
/** Newer ICU puts a narrow no-break space before AM/PM; a plain one reads the same and matches `clock`. */
const timeLabel = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/ /g, ' ');
const isMidnight = (d: Date) => d.getHours() === 0 && d.getMinutes() === 0;

/** An exception in a line: "Fri, Mar 14 · All day", "Fri, Mar 14 – Sun, Mar 16", "Fri, Mar 14 · 6:00 PM – 11:00 PM". */
export function describeException(x: Pick<AvailabilityException, 'start' | 'end'>): string {
  const s = new Date(x.start), e = new Date(x.end);
  if (isMidnight(s) && isMidnight(e)) {
    const last = new Date(e.getTime() - 1);
    return last.toDateString() === s.toDateString() ? `${dayLabel(s)} · All day` : `${dayLabel(s)} – ${dayLabel(last)}`;
  }
  return s.toDateString() === e.toDateString() || e.getTime() - s.getTime() < 24 * 60 * 60 * 1000
    ? `${dayLabel(s)} · ${timeLabel(s)} – ${timeLabel(e)}`
    : `${dayLabel(s)} ${timeLabel(s)} – ${dayLabel(e)} ${timeLabel(e)}`;
}

/** Exceptions in date order, with a new one put in its place. */
export const withException = (list: readonly AvailabilityException[], x: AvailabilityException) =>
  [...list, x].sort((a, b) => a.start.localeCompare(b.start));

/* ---------- Busy sources ---------- */

/** "just now", "12 min ago", "3 h ago", "4 days ago". */
export function ago(iso: string, now: Date): string {
  const minutes = Math.round((now.getTime() - Date.parse(iso)) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/** The source's status line. */
export function sourceLine(s: BusySource, now: Date): string {
  if (s.enabled) return s.syncedAt ? `Synced ${ago(s.syncedAt, now)} · refreshed when older than ${s.freshMinutes} min` : 'Not synced yet.';
  if (s.needsReconsent) return 'Google needs to ask you once more, so Hearthside can see when you’re busy.';
  if (s.ready) return `Off: your ${SOURCE_LABEL[s.source]} busy time doesn’t count yet.`;
  return s.problem ?? 'Not connected.';
}

/** Which buttons a source shows. */
export function sourceActions(s: BusySource): { connect: 'Connect Google' | 'Reconnect Google' | null; sync: boolean; toggle: 'Turn on' | 'Turn off' | null } {
  return {
    connect: s.source === 'google' && (!s.connected || s.needsReconsent) ? (s.connected ? 'Reconnect Google' : 'Connect Google') : null,
    sync: s.enabled,
    toggle: s.enabled ? 'Turn off' : s.ready ? 'Turn on' : null,
  };
}

/* ---------- What your party sees ---------- */

/** Midnight today, local: where the preview starts. */
export function previewStart(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** The preview's query: the next PREVIEW_DAYS days from `from`. */
export function previewQuery(from: Date): string {
  const to = new Date(from);
  to.setDate(to.getDate() + PREVIEW_DAYS);
  return `start=${from.toISOString()}&end=${to.toISOString()}`;
}

export interface PreviewDay {
  start: Date;
  label: string;
  /** Half-hour cells, midnight to midnight. */
  cells: Presence[];
  freeHours: number;
}

/** The preview's rows: one a day, its half hours as the runs say (unknown where none covers it). */
export function previewDays(from: Date, runs: readonly Run[]): PreviewDay[] {
  const spans = runs.map((r) => ({ s: Date.parse(r.start), e: Date.parse(r.end), p: r.presence }));
  return Array.from({ length: PREVIEW_DAYS }, (_, i) => {
    const start = new Date(from);
    start.setDate(start.getDate() + i);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const cells: Presence[] = [];
    for (let t = start.getTime(); t < end.getTime(); t += HALF_HOUR) {
      cells.push(spans.find((r) => r.s <= t && t < r.e)?.p ?? 'unknown');
    }
    return { start, label: dayLabel(start), cells, freeHours: cells.filter((c) => c === 'free').length / 2 };
  });
}

/* ---------- Time zones ---------- */

export function browserTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** Every zone this browser knows, with `current` first if it isn't among them. */
export function timeZones(current: string): string[] {
  let list: string[] = [];
  try { list = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone'); } catch { /* an old browser: just the current one */ }
  return list.includes(current) ? list : [current, ...list];
}

export const zoneLabel = (z: string) => z.replace(/_/g, ' ');
