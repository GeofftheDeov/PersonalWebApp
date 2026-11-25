/**
 * A campaign's records (#225, spec #69): Sessions | Characters under the
 * party. Coming up is the board's scheduled sessions still to come (and any
 * other session not yet over); Previous sessions is the campaign's past;
 * Add a session is the GM's
 * dialog; Characters is the party's adventurers. The rules are the
 * portfolio's (`frontend/src/app/game-night/campaigns/[id]/page.tsx` and
 * `CampaignCharacters`); the server enforces all of them. Kept apart from
 * React so they're tested on their own (test/campaign-records.test.ts).
 *
 *   GET  /api/campaigns/:id/sessions               the campaign's sessions, newest first
 *   GET  /api/tabletop/characters?campaign=:id     the party's characters, with who plays each
 *   POST /api/tabletop/sessions                    the GM adds a session (and its Discord and Google events)
 */
import type { Upcoming } from './noticeBoard';
import { fromDatetimeLocal, sessionPhase } from './sessionPage';

/** A session as `GET /api/campaigns/:id/sessions` sends it (the fields the list reads). */
export interface CampaignSession {
  _id: string;
  title?: string | null;
  date?: string | null;
  endDate?: string | null;
  location?: string | null;
  isOnline?: boolean | null;
  summary?: string | null;
  status?: string | null;
  /** The one-session stand-in GM's account id. */
  gmOverride?: string | null;
  /** Players recorded as there (#37). */
  attendeeCount?: number;
  /** Set once the GM has taken attendance, even if nobody came. */
  attendanceConfirmedAt?: string | null;
}

/**
 * The campaign's sessions, split by `sessionPhase` (the backend never marks
 * one played, so its end time decides, as on the session page):
 *
 * - `previous`: over or called off, newest first.
 * - `underWay`: started and not yet over (tonight's), which the board's
 *   Coming up leaves out; they go above it.
 * - `later`: still to come but not on the board's Coming up (no night yet,
 *   or past the ten it sends), soonest first and undated last; they go below it.
 *
 * Sessions being planned are the Notice Board's, and the board's Coming up
 * draws its own, so neither list has them.
 */
export function sessionLists(sessions: readonly CampaignSession[], upcoming: readonly Upcoming[], now: Date) {
  const coming = new Set(upcoming.map((u) => u.id));
  const at = (s: CampaignSession) => (s.date ? Date.parse(s.date) : NaN);
  const previous: CampaignSession[] = [];
  const underWay: CampaignSession[] = [];
  const later: CampaignSession[] = [];
  for (const s of sessions) {
    if (s.status === 'planning' || coming.has(s._id)) continue;
    if (sessionPhase(s, now) !== 'before') previous.push(s);
    else if (at(s) <= now.getTime()) underWay.push(s);
    else later.push(s);
  }
  previous.sort((a, b) => (at(b) || 0) - (at(a) || 0));
  underWay.sort((a, b) => at(a) - at(b));
  later.sort((a, b) => (Number.isNaN(at(a)) ? Infinity : at(a)) - (Number.isNaN(at(b)) ? Infinity : at(b)));
  return { previous, underWay, later };
}

const DAY_Y = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** A previous session's night: "Nov 3, 2026", "Cancelled · Nov 3, 2026", "Planning", or "Date TBD". */
export function sessionWhenLabel(s: CampaignSession): string {
  const day = s.date ? DAY_Y.format(new Date(s.date)) : null;
  if (s.status === 'planning') return 'Planning';
  if (s.status === 'cancelled') return day ? `Cancelled · ${day}` : 'Cancelled';
  return day ?? 'Date TBD';
}

/** Who came: "3 attended", "Attendance not taken", or null (cancelled, or no count sent). */
export function attendanceLabel(s: CampaignSession): string | null {
  if (s.attendeeCount === undefined || s.status === 'cancelled') return null;
  return s.attendanceConfirmedAt || s.attendeeCount > 0 ? `${s.attendeeCount} attended` : 'Attendance not taken';
}

/** The GM's "Add a session" form, all strings and switches. Times are datetime-local values. */
export interface SessionForm {
  title: string;
  date: string;
  endDate: string;
  location: string;
  isOnline: boolean;
  agenda: string;
  createDiscordEvent: boolean;
  createGoogleEvent: boolean;
}

export const EMPTY_SESSION_FORM: SessionForm = {
  title: '', date: '', endDate: '', location: '', isOnline: false, agenda: '', createDiscordEvent: false, createGoogleEvent: false,
};

/** What the campaign's Discord link means for the form. */
export interface DiscordLink {
  discordGuildId?: string | null;
  discordChannelId?: string | null;
}

/** Which fields become required: both times for any event elsewhere; a location for a Discord event with no voice channel. */
export function sessionFormNeeds(f: SessionForm, c: DiscordLink) {
  return {
    times: f.createDiscordEvent || f.createGoogleEvent,
    location: f.createDiscordEvent && !c.discordChannelId && !f.isOnline,
  };
}

/** Why the form can't be sent yet, as the portfolio checks it before the server does; null when it can. */
export function sessionFormProblem(f: SessionForm, c: DiscordLink): string | null {
  if (!f.title.trim()) return 'Give the session a title.';
  if (!sessionFormNeeds(f, c).times) return null;
  if (!f.date || !f.endDate) return 'Events elsewhere need a start and an end time.';
  if (new Date(f.endDate) <= new Date(f.date)) return 'The end has to come after the start.';
  if (f.createDiscordEvent && !c.discordChannelId && !f.location.trim() && !f.isOnline) {
    return 'A Discord event needs a location: enter one, or mark the session as online.';
  }
  return null;
}

/**
 * What `POST /api/tabletop/sessions` takes. The times go as instants (the
 * browser's local time, not the server's). The server saves the session
 * before it makes any event, so the events can link to its page (#214).
 */
export function sessionPayload(f: SessionForm, campaignId: string) {
  return {
    campaign: campaignId,
    title: f.title.trim(),
    date: fromDatetimeLocal(f.date) ?? undefined,
    endDate: fromDatetimeLocal(f.endDate) ?? undefined,
    location: f.location.trim(),
    isOnline: f.isOnline,
    agenda: f.agenda,
    createDiscordEvent: f.createDiscordEvent,
    createGoogleEvent: f.createGoogleEvent,
  };
}

/** A character in the party, as `GET /api/tabletop/characters?campaign=` sends it. */
export interface PartyCharacter {
  _id: string;
  name: string;
  class?: string | null;
  level?: number | null;
  gameType?: string | null;
  isDead?: boolean;
  player: { _id: string; name: string; handle: string | null } | null;
  /** False once the player has been made inactive in this campaign (#37). */
  playerActive: boolean;
  /** Their portrait (#273), or null for the initials. */
  portraitUrl?: string | null;
}

/** The party's adventurers, and the former party's (players made inactive here): their history stays. */
export function characterGroups(cs: readonly PartyCharacter[]) {
  return { current: cs.filter((c) => c.playerActive), former: cs.filter((c) => !c.playerActive) };
}

/** Under an adventurer's name: "Rogue · Level 3", or "Adventurer". */
export const characterLine = (c: PartyCharacter): string =>
  [c.class, c.level ? `Level ${c.level}` : null].filter(Boolean).join(' · ') || 'Adventurer';

/** "Played by @wren", "Played by Wren Talbot", or "No player". */
export const playedBy = (c: PartyCharacter): string =>
  c.player ? `Played by ${c.player.handle ? `@${c.player.handle}` : c.player.name}` : 'No player';
