/**
 * A session's page (#226, spec #69): the rules the page follows, kept apart
 * from React so they can be tested. Today's data only:
 *
 *   GET /api/tabletop/sessions/:id      the session (its `agenda` only for the GM, the stand-in and admins, #213)
 *   GET /api/planning/sessions/:id      the party, the GM's ids, the stand-in, the venue and the viewer's role
 *   GET /api/campaigns/:id/sessions     the campaign's sessions, for previous and next
 *   PUT /api/tabletop/sessions/:id      the GM's edits; only the fields sent change
 */

/** Where a session stands: still to come (or under way), over, or called off. */
export type SessionPhase = 'before' | 'after' | 'cancelled';

/** The tabs under the table. */
export type SessionTab = 'tale' | 'details' | 'prep';

export const TAB_LABEL: Record<SessionTab, string> = {
  tale: 'The tale',
  details: 'Details',
  prep: 'Prep notes',
};

/** A session with no end time counts as over this long after it starts (the backend's SESSION_GRACE). */
const SESSION_GRACE_MS = 4 * 60 * 60 * 1000;

interface Timed {
  status?: string | null;
  date?: string | null;
  endDate?: string | null;
}

/**
 * Before the session ends it's `before` (being planned, still to come, or
 * being played); after it, `after`. Nothing marks a session played on the
 * server yet, so its end time decides, as Your Quests does.
 */
export function sessionPhase(s: Timed, now: Date): SessionPhase {
  if (s.status === 'cancelled') return 'cancelled';
  if (s.status === 'completed') return 'after';
  if (s.status === 'planning' || !s.date) return 'before';
  const over = s.endDate ? Date.parse(s.endDate) : Date.parse(s.date) + SESSION_GRACE_MS;
  return now.getTime() >= over ? 'after' : 'before';
}

/**
 * May the viewer read and write Prep notes? The server sends the `agenda` key
 * (a string, or null) only to those who may (the campaign's GM, the
 * session's stand-in and admins, #213), and leaves it out for anyone else.
 * They're also the ones who may edit the session and write the tale.
 */
export const canWritePrepNotes = (s: object): boolean => 'agenda' in s;

/** The tabs, in order. A cancelled session has no tale to tell. */
export function sessionTabs(phase: SessionPhase, gm: boolean): SessionTab[] {
  const tabs: SessionTab[] = phase === 'cancelled' ? ['details'] : ['tale', 'details'];
  return gm ? [...tabs, 'prep'] : tabs;
}

/**
 * The tab the page opens on (from the session prototype's table): before the
 * session the GM sees their Prep notes and a player the Details; after it,
 * the GM sees the Details and a player the tale.
 */
export function defaultTab(phase: SessionPhase, gm: boolean): SessionTab {
  if (phase === 'before') return gm ? 'prep' : 'details';
  if (phase === 'after') return gm ? 'details' : 'tale';
  return 'details';
}

/** A session in a campaign's list, as GET /api/campaigns/:id/sessions sends it. */
export interface SessionListItem {
  _id?: string;
  id?: string;
  title?: string | null;
  date?: string | null;
  createdAt?: string | null;
}

export interface SessionLink {
  id: string;
  title: string;
}

export interface Neighbours {
  /** Its place in the campaign, from 1: "Session 6". Null if it isn't in the list. */
  number: number | null;
  prev: SessionLink | null;
  next: SessionLink | null;
}

const idOf = (s: SessionListItem) => String(s._id ?? s.id ?? '');
const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/** A session's name: its title, or its number in the campaign when it has none. */
export const sessionName = (title: string | null | undefined, number: number | null): string =>
  title?.trim() || (number ? `Session ${number}` : 'Session');

/**
 * Where a session sits in its campaign: the sessions in order of their
 * night, the ones still without a night (being planned) last, in the order
 * they were made. Previous and next walk that order.
 */
export function sessionNeighbours(sessions: readonly SessionListItem[], id: string): Neighbours {
  const ordered = [...sessions].sort((a, b) => {
    const da = time(a.date), db = time(b.date);
    if (Number.isNaN(da) !== Number.isNaN(db)) return Number.isNaN(da) ? 1 : -1;
    if (!Number.isNaN(da) && da !== db) return da - db;
    return (time(a.createdAt) || 0) - (time(b.createdAt) || 0) || idOf(a).localeCompare(idOf(b));
  });
  const i = ordered.findIndex((s) => idOf(s) === id);
  if (i < 0) return { number: null, prev: null, next: null };
  const link = (j: number): SessionLink | null =>
    j >= 0 && j < ordered.length ? { id: idOf(ordered[j]), title: sessionName(ordered[j].title, j + 1) } : null;
  return { number: i + 1, prev: link(i - 1), next: link(i + 1) };
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const clock = (d: Date) => {
  const h = d.getHours(), m = d.getMinutes();
  return { hm: `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}`, half: h < 12 ? 'am' : 'pm' };
};

/** "7:30 pm", or a span: "7:30–11 pm", "11 am–2:15 pm". */
export function timeSpan(startIso: string, endIso?: string | null): string {
  const a = clock(new Date(startIso));
  if (!endIso) return `${a.hm} ${a.half}`;
  const b = clock(new Date(endIso));
  return a.half === b.half ? `${a.hm}–${b.hm} ${b.half}` : `${a.hm} ${a.half}–${b.hm} ${b.half}`;
}

/** "Tuesday, November 3, 2026". */
export function longDay(iso: string): string {
  const d = new Date(iso);
  return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** The night on the session's card: "Tuesday, November 3, 2026 · 7:30–11 pm", or "No night yet". */
export function nightLine(date: string | null | undefined, endDate: string | null | undefined): string {
  return date ? `${longDay(date)} · ${timeSpan(date, endDate)}` : 'No night yet';
}

/** How far off a night is, in days: "Tonight", "Tomorrow", "Saturday", "Next Thursday", "In 20 days". */
export function whenFromNow(iso: string, now: Date): string {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const n = Math.round((day(d) - day(now)) / 86_400_000);
  if (n === 0) return 'Tonight';
  if (n === 1) return 'Tomorrow';
  if (n > 1 && n < 7) return WEEKDAYS[d.getDay()];
  if (n >= 7 && n < 14) return `Next ${WEEKDAYS[d.getDay()]}`;
  return n > 0 ? `In ${n} days` : '';
}

/** The tale as paragraphs: blank lines start a new one. */
export function taleParagraphs(text: string | null | undefined): string[] {
  return (text ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

/** A date as a datetime-local field holds it, in local time; '' for none. */
export function toDatetimeLocal(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A datetime-local field's value as ISO, or null when it's empty. */
export const fromDatetimeLocal = (v: string): string | null => (v ? new Date(v).toISOString() : null);
