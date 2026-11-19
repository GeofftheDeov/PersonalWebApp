/**
 * Your Room (#230, spec #69): layout A, "The ledger", from
 * prototype/hearthside-player-profile. The rules the page follows, kept apart
 * from React so they can be tested (test/room.test.ts). Today's data only:
 *
 *   GET  /api/users/profile               the record (the session client reads it)
 *   PUT  /api/users/profile               the record's edits; only the fields sent change
 *   POST /api/users/profile/picture       the photo (multipart `profilePicture`)
 *   GET  /api/users/profile/sessions      sessions attended: Played
 *   GET  /api/tabletop/sessions           sessions in the player's campaigns: Coming up
 *   GET  /api/campaigns                   the player's campaigns
 *   GET  /api/google-calendar/status, /auth-url, DELETE /api/google-calendar
 *
 * The ledger's pieces take a person, not only "me": another player's page
 * (#231) draws the same head and record from `GET /api/users/players/:id`.
 */
import { sessionName, sessionPhase } from './sessionPage';

/**
 * A person as the ledger draws them: the profile read (yourself) or
 * `toPublicPerson` (anyone else), so every field but the name may be missing.
 */
export interface LedgerPerson {
  _id?: string | null;
  id?: string | null;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  handle?: string | null;
  userNumber?: string | number | null;
  /** The internal ID (`userDigit`), shown on User records only. */
  userDigit?: string | null;
  email?: string | null;
  phone?: string | null;
  /** The record type: `toPublicPerson` calls it `recordType`, the profile read `sfObject`. */
  recordType?: string | null;
  sfObject?: string | null;
  discordHandle?: string | null;
  discordId?: string | null;
  favoriteGames?: string[] | null;
  profilePicture?: string | null;
  createdAt?: string | null;
}

export const personId = (p: LedgerPerson): string => String(p._id ?? p.id ?? '');

/** Their name: `name`, else first and last, else "A player". */
const ownName = (p: LedgerPerson): string =>
  p.name?.trim() || [p.firstName, p.lastName].filter(Boolean).join(' ').trim();

export const displayName = (p: LedgerPerson): string => ownName(p) || 'A player';

/** The photo's fallback: the name's first letter. */
export const initialOf = (p: LedgerPerson): string => [...displayName(p)][0]?.toUpperCase() ?? '?';

/** "@wren", or '' with no handle. */
export const handleOf = (p: LedgerPerson): string => (p.handle ? `@${p.handle}` : '');

/** The unique ID, "@wren#4821", or '' until they have a handle. */
export const uniqueIdOf = (p: LedgerPerson): string =>
  p.handle && p.userNumber != null && p.userNumber !== '' ? `@${p.handle}#${p.userNumber}` : '';

export const recordTypeOf = (p: LedgerPerson): string | null => p.recordType ?? p.sfObject ?? null;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const dateOf = (iso: string | null | undefined): Date | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** When they joined, for the head: "March 2025". */
export function sinceLabel(iso: string | null | undefined): string {
  const d = dateOf(iso);
  return d ? `${MONTHS[d.getMonth()]} ${d.getFullYear()}` : '';
}

/** "Mar 14, 2025". */
export function shortDay(iso: string | null | undefined): string {
  const d = dateOf(iso);
  return d ? `${SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}` : '';
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The head's counts: "12 sessions · 3 campaigns · since March 2025". */
export function headLine({ sessions, campaigns, since }: { sessions: number; campaigns: number; since?: string | null }): string {
  const joined = sinceLabel(since);
  return [plural(sessions, 'session'), plural(campaigns, 'campaign'), joined && `since ${joined}`].filter(Boolean).join(' · ');
}

/** One line of the record. `mine`: only the person themselves sees it (email, phone, record type, internal ID). */
export interface RecordRow {
  label: string;
  /** null: not set, and `empty` says so. */
  value: string | null;
  empty?: string;
  note?: string;
  mono?: boolean;
  mine?: boolean;
}

/**
 * The record, in the portfolio's order: what everyone sees, then (on your own
 * page) what only you do, then Discord. The internal ID shows on User records
 * only, as on the portfolio. Favourite games are drawn apart, as chips.
 */
export function recordRows(p: LedgerPerson, own: boolean): RecordRow[] {
  const unique = uniqueIdOf(p);
  const rows: RecordRow[] = [
    { label: 'Name', value: displayName(p) },
    { label: 'Handle', value: handleOf(p) || null, empty: 'Not set' },
    { label: 'Unique ID', value: unique || null, empty: 'Set a handle to get one', mono: true },
  ];
  if (own) {
    const type = recordTypeOf(p);
    if (type === 'User') rows.push({ label: 'Internal ID', value: p.userDigit || null, empty: 'Not set', mono: true, mine: true });
    rows.push(
      { label: 'Email', value: p.email || null, empty: 'Not set', note: 'Can’t be changed here.', mine: true },
      { label: 'Phone', value: p.phone || null, empty: 'Not set', mine: true },
      { label: 'Record type', value: type, empty: 'Not set', mine: true },
    );
  }
  rows.push(
    { label: 'Discord', value: p.discordHandle || null, empty: 'Not linked' },
    { label: 'Discord user ID', value: p.discordId || null, empty: 'Not set', mono: true },
  );
  const joined = shortDay(p.createdAt);
  if (joined) rows.push({ label: 'Joined', value: joined });
  return rows;
}

/** The fields the record's dialog edits, and so the only ones it saves. */
export const RECORD_FIELDS = ['name', 'handle', 'phone', 'discordHandle', 'discordId'] as const;
export type RecordField = (typeof RECORD_FIELDS)[number];
export type RecordDraft = Record<RecordField, string>;

export function recordDraft(p: LedgerPerson): RecordDraft {
  return {
    name: ownName(p),
    handle: p.handle ?? '',
    phone: p.phone ?? '',
    discordHandle: p.discordHandle ?? '',
    discordId: p.discordId ?? '',
  };
}

/**
 * What Save sends: only the fields that changed, trimmed, with the handle's
 * "@" taken off. Nothing else on the row is written back, since it may have
 * moved since the page loaded (as on the portfolio).
 */
export function recordEdits(draft: RecordDraft, p: LedgerPerson): Partial<RecordDraft> {
  const was = recordDraft(p);
  const edits: Partial<RecordDraft> = {};
  for (const f of RECORD_FIELDS) {
    const v = f === 'handle' ? draft[f].trim().replace(/^@+/, '') : draft[f].trim();
    if (v !== was[f].trim()) edits[f] = v;
  }
  return edits;
}

/** What the backend's upload takes (multer's filter): JPG, PNG, GIF or WEBP, up to 5 MB. */
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const PHOTO_RULE = 'A photo must be a JPG, PNG, GIF or WEBP, up to 5 MB.';

/** Why a photo can't be used, or null when it can. */
export function photoProblem(file: { type: string; size: number }): string | null {
  return (PHOTO_TYPES as readonly string[]).includes(file.type) && file.size <= PHOTO_MAX_BYTES ? null : PHOTO_RULE;
}

/** Favourite games: a new one goes on the end; blanks and repeats (in any case) don't. */
export function withGame(games: readonly string[], name: string): string[] {
  const g = name.trim();
  if (!g || games.some((x) => x.toLowerCase() === g.toLowerCase())) return [...games];
  return [...games, g];
}

export const withoutGame = (games: readonly string[], name: string): string[] => games.filter((g) => g !== name);

/* ---------- Sessions ---------- */

/** A session in Your Room's lists: Coming up or Played. */
export interface RoomSession {
  id: string;
  title: string;
  date: string | null;
  endDate?: string | null;
  campaign: { id: string; title: string } | null;
}

/** A session as `GET /api/tabletop/sessions` lists it (the fields read here). */
export interface ListedSession {
  _id?: string;
  id?: string;
  title?: string | null;
  date?: string | null;
  endDate?: string | null;
  status?: string | null;
  campaign?: { _id?: string; id?: string; title?: string | null } | string | null;
}

/** A row of `GET /api/users/profile/sessions`: a session the player attended. */
export interface AttendedSession {
  playerSessionId?: string;
  sessionId: string;
  title?: string | null;
  date?: string | null;
  campaign?: { id: string; title: string } | null;
}

const campaignOf = (c: ListedSession['campaign']): RoomSession['campaign'] => {
  if (!c || typeof c === 'string') return null;
  const id = String(c._id ?? c.id ?? '');
  return id ? { id, title: c.title?.trim() || 'A campaign' } : null;
};

const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/**
 * Coming up: the dated sessions in the player's campaigns that haven't ended
 * (sessionPhase; nothing marks a session played), soonest first. Sessions
 * still being planned have no night yet, so they wait on the Notice Board.
 */
export function comingUp(sessions: readonly ListedSession[], now: Date): RoomSession[] {
  return sessions
    .filter((s) => s.date && s.status !== 'planning' && sessionPhase(s, now) === 'before')
    .sort((a, b) => time(a.date) - time(b.date))
    .map((s) => ({
      id: String(s._id ?? s.id ?? ''),
      title: sessionName(s.title, null),
      date: s.date ?? null,
      endDate: s.endDate ?? null,
      campaign: campaignOf(s.campaign),
    }));
}

/** Played: the sessions the player attended, latest first. */
export function played(rows: readonly AttendedSession[]): RoomSession[] {
  const seen = new Set<string>();
  return rows
    .filter((r) => r.sessionId && !seen.has(String(r.sessionId)) && seen.add(String(r.sessionId)))
    .map((r) => ({ id: String(r.sessionId), title: sessionName(r.title, null), date: r.date ?? null, campaign: r.campaign ?? null }))
    .sort((a, b) => (time(b.date) || 0) - (time(a.date) || 0));
}

/** All, or one campaign's id. */
export type SessionFilter = 'all' | string;

export interface FilterOption {
  id: string;
  title: string;
  /** Its sessions in both lists. */
  count: number;
}

/** The campaign filter's options: each campaign with a session in either list, by title. */
export function filterOptions(...lists: readonly (readonly RoomSession[])[]): FilterOption[] {
  const by = new Map<string, FilterOption>();
  for (const s of lists.flat()) {
    if (!s.campaign) continue;
    const o = by.get(s.campaign.id) ?? { id: s.campaign.id, title: s.campaign.title, count: 0 };
    o.count++;
    by.set(s.campaign.id, o);
  }
  return [...by.values()].sort((a, b) => a.title.localeCompare(b.title));
}

export function bySessionFilter(list: readonly RoomSession[], filter: SessionFilter): RoomSession[] {
  return filter === 'all' ? [...list] : list.filter((s) => s.campaign?.id === filter);
}

/* ---------- Google Calendar ---------- */

/** `GET /api/google-calendar/status`. */
export interface GcalStatus {
  connected: boolean;
  configured?: boolean;
  needsReconsent?: boolean;
}

/**
 * The line under the card after the round trip to Google, from `?gcal=` (the
 * callback sends Hearthside's people back to /room, #215); null for anything else.
 */
export function gcalResult(param: string | null | undefined): string | null {
  switch (param) {
    case 'connected': return 'Google Calendar connected!';
    case 'denied': return 'Connecting Google Calendar was cancelled.';
    case 'error': return 'Connecting Google Calendar failed. Try again.';
    case 'noRefreshToken': return 'Google didn’t return a refresh token. Remove the app at myaccount.google.com/permissions, then connect again.';
    default: return null;
  }
}

/** The card's status pill and line. */
export function gcalState(s: GcalStatus | null): { pill: string; tone: 'ok' | 'seal' | 'off'; line: string } {
  if (!s?.connected) return { pill: 'Not connected', tone: 'off', line: 'Connect to add session events to your calendar automatically.' };
  if (s.needsReconsent) return { pill: 'Reconnect needed', tone: 'seal', line: 'Connected. Session events are added to your calendar automatically.' };
  return { pill: 'Connected', tone: 'ok', line: 'Connected. Session events are added to your calendar automatically.' };
}

/* ---------- The tabs ---------- */

export type RoomTab = 'record' | 'sessions' | 'campaigns' | 'integrations';

export const ROOM_TABS: readonly RoomTab[] = ['record', 'sessions', 'campaigns', 'integrations'];

export const ROOM_TAB_LABEL: Record<RoomTab, string> = {
  record: 'Record',
  sessions: 'Sessions',
  campaigns: 'Campaigns',
  integrations: 'Integrations',
};

/** `?tab=` as a tab, falling back to the Record. A return from Google opens Integrations. */
export function roomTab(tab: string | null | undefined, gcal: string | null | undefined): RoomTab {
  if ((ROOM_TABS as readonly string[]).includes(tab ?? '')) return tab as RoomTab;
  return gcal ? 'integrations' : 'record';
}

/** Is `/players/:id` the viewer's own page? Then it's Your Room. */
export const isOwnPage = (id: string, me: { id: string } | null | undefined): boolean => !!me && !!id && me.id === id;
