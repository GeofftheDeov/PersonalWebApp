/**
 * Adventurers (#229, spec #69): layout D, "Gallery + road", from
 * prototype/hearthside-characters, with today's data only (name, player,
 * campaign, game, class, level and fallen). The rules the roster, an
 * adventurer's page and the shared dialog follow, kept apart from React so
 * they're tested on their own (test/adventurers.test.ts). The server enforces
 * every one of them (#202, #235); these only decide what to draw.
 *
 *   GET  /api/tabletop/characters          your own, plus the party's in every campaign you sit in
 *   GET  /api/tabletop/characters/:id      one, for its player, their friends and campaign-mates, its party, admins
 *   GET  /api/tabletop/characters?campaign= the party (Travels with); 403 for anyone outside it
 *   GET  /api/tabletop/sessions            the sessions of your campaigns (the next one under each portrait)
 *   POST /api/tabletop/characters          New adventurer: you play it
 *   PUT  /api/tabletop/characters/:id      Edit: its player, or an admin
 *
 * Art and the full sheet (#273, #274) upload through lib/adventurerFiles.ts.
 *
 * The paths keep the word `characters`; the pages say Adventurers.
 */
import type { PartyCharacter } from './campaignRecords';
import { sessionPhase } from './sessionPage';

/** A campaign as a character carries it: its whole row for its members, `{ _id, title, status }` for anyone else. */
export interface AdventurerCampaign {
  _id: string;
  title?: string | null;
  status?: string | null;
}

/** A character as `GET /api/tabletop/characters[/:id]` sends it. */
export interface Adventurer {
  _id: string;
  name: string;
  class?: string | null;
  level?: number | null;
  gameType?: string | null;
  isDead?: boolean | null;
  /** The player: an id in the list, `{ _id, name, handle }` on its own page. */
  player?: string | { _id: string; name?: string | null; handle?: string | null } | null;
  /** The campaign: populated in both reads, or an id, or none. */
  campaign?: string | AdventurerCampaign | null;
  createdAt?: string | null;
  /** The portrait (#273): a URL, or null for the initials. Every read carries it. */
  portraitUrl?: string | null;
  /** Every piece of art, in order (#273). Only on its own page. */
  art?: AdventurerArt[];
  /** Where the full sheet lives (#274): an http(s) link, or null. */
  sheetUrl?: string | null;
  /** The uploaded copy of the sheet (#274), or null. Only on its own page. */
  sheet?: AdventurerSheetCopy | null;
}

/** A piece of an adventurer's art (#273). `url` is null when uploads are switched off. */
export interface AdventurerArt {
  _id: string;
  url: string | null;
  isPortrait: boolean;
  createdAt?: string;
}

/** The uploaded copy of an adventurer's sheet (#274), kept exactly as uploaded. `url` expires. */
export interface AdventurerSheetCopy {
  name: string;
  contentType: string;
  size: number | null;
  url: string | null;
}

/** A session as `GET /api/tabletop/sessions` sends it (the fields the roster reads). */
export interface RosterSession {
  _id: string;
  title?: string | null;
  date?: string | null;
  endDate?: string | null;
  status?: string | null;
  campaign?: string | { _id: string } | null;
}

const idOf = (ref: string | { _id: string } | null | undefined): string | null =>
  ref == null ? null : typeof ref === 'string' ? ref : String(ref._id);

/** Who plays it: their id. */
export const playerIdOf = (c: Pick<Adventurer, 'player'>): string | null => idOf(c.player);

/** The campaign it's in: its id, or null. */
export const campaignIdOf = (c: Pick<Adventurer, 'campaign'>): string | null => idOf(c.campaign);

/** The campaign's name, if the reply carried it. */
export const campaignTitleOf = (c: Pick<Adventurer, 'campaign'>): string | null =>
  c.campaign && typeof c.campaign === 'object' ? c.campaign.title ?? null : null;

/** "Rogue · Level 3", or "No class set" with only a level, as on the brass plate. */
export function classLine(c: Pick<Adventurer, 'class' | 'level'>): string {
  const cls = c.class?.trim();
  const level = c.level != null ? `Level ${c.level}` : '';
  return [cls, level].filter(Boolean).join(' · ') || 'No class set';
}

/** Adventuring, or Fallen. */
export const statusOf = (c: Pick<Adventurer, 'isDead'>): string => (c.isDead ? 'Fallen' : 'Adventuring');

/**
 * The initials stitched on the fallback portrait: the first letters of the
 * first two words, skipping a title ("Brother Odran" → "O", "Dr. Ada Marsh"
 * → "AM"); "?" with nothing to go on.
 */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => /^\p{L}/u.test(w) && !TITLE.test(w));
  const initials = words.slice(0, 2).map((w) => [...w][0].toUpperCase()).join('');
  return initials || [...name.trim()][0]?.toUpperCase() || '?';
}
const TITLE = /^(dr|mr|mrs|ms|sir|dame|lady|lord|brother|sister|father|mother|captain|capt)\.?$/i;

/** The viewer's own adventurers, in their two halls: adventuring, then fallen (the Hall of Heroes). By name. */
export function rosterOf(list: readonly Adventurer[], viewerId: string) {
  const mine = list
    .filter((c) => playerIdOf(c) === viewerId)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { adventuring: mine.filter((c) => !c.isDead), fallen: mine.filter((c) => !!c.isDead) };
}

/**
 * The next session in each campaign, by campaign id: the soonest with a night
 * that isn't over or called off (`sessionPhase`, as the campaign page uses).
 */
export function nextSessions(sessions: readonly RosterSession[], now: Date): Map<string, RosterSession> {
  const next = new Map<string, RosterSession>();
  for (const s of sessions) {
    const cid = idOf(s.campaign);
    if (!cid || !s.date || sessionPhase(s, now) !== 'before') continue;
    const held = next.get(cid);
    if (!held || Date.parse(s.date) < Date.parse(held.date!)) next.set(cid, s);
  }
  return next;
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Next: Thu Nov 26" under a portrait (the year too when it isn't this one's). */
export function nextLabel(s: Pick<RosterSession, 'date'>, now: Date): string {
  const d = new Date(s.date!);
  const year = d.getFullYear() !== now.getFullYear() ? `, ${d.getFullYear()}` : '';
  return `Next: ${WD[d.getDay()]} ${MON[d.getMonth()]} ${d.getDate()}${year}`;
}

/** May the viewer edit it? Its player and admins, as the server allows (#202). Display only. */
export function canEditAdventurer(
  c: Pick<Adventurer, 'player'>,
  me: { id: string } | null | undefined,
  caps: { appRole: string | null } | null | undefined,
): boolean {
  if (!me) return false;
  return caps?.appRole === 'admin' || playerIdOf(c) === me.id;
}

/** "You", or the player's name ("@handle" when they have one). */
export function playedByLine(c: Pick<Adventurer, 'player'>, viewerId: string | null | undefined): string {
  if (viewerId && playerIdOf(c) === viewerId) return 'You';
  const p = c.player && typeof c.player === 'object' ? c.player : null;
  if (!p) return 'Someone';
  return p.handle ? `@${p.handle}` : p.name || 'Someone';
}

/**
 * Travels with: the party's other adventurers (`PartyCharacter`s from
 * `?campaign=`), by name. Not this one, the fallen, or the former party's
 * (players made inactive there): they no longer travel.
 */
export function travelsWith<T extends Pick<PartyCharacter, '_id' | 'name' | 'playerActive' | 'isDead'>>(party: readonly T[], id: string): T[] {
  return party
    .filter((m) => m._id !== id && m.playerActive && !m.isDead)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

// ---------------------------------------------------------------- the dialog

export const MAX_LEVEL = 20;

/** New adventurer and Edit share one form: today's fields. */
export interface AdventurerForm {
  name: string;
  class: string;
  /** As typed; a whole number from 1 to 20 to save. */
  level: string;
  gameType: string;
  /** A campaign id, or "" for none. */
  campaign: string;
  isDead: boolean;
  /** The link to the full sheet (#274), as typed; "" for none. */
  sheetUrl: string;
}

export const EMPTY_ADVENTURER: AdventurerForm = { name: '', class: '', level: '1', gameType: '', campaign: '', isDead: false, sheetUrl: '' };

/** The form, filled from an adventurer to edit. */
export function formOf(c: Adventurer): AdventurerForm {
  return {
    name: c.name ?? '',
    class: c.class ?? '',
    level: c.level != null ? String(c.level) : '1',
    gameType: c.gameType ?? '',
    campaign: campaignIdOf(c) ?? '',
    isDead: !!c.isDead,
    sheetUrl: c.sheetUrl ?? '',
  };
}

/** What's wrong with the form, or null: the server's rule (#235), said before it's asked. */
export function formProblem(f: AdventurerForm): string | null {
  if (!f.name.trim()) return 'Every adventurer needs a name.';
  const level = Number(f.level);
  if (!/^\d+$/.test(f.level.trim()) || level < 1 || level > MAX_LEVEL) return `The level is a whole number from 1 to ${MAX_LEVEL}.`;
  return sheetLinkProblem(f.sheetUrl);
}

/**
 * What's wrong with a link to the full sheet, or null: blank, or a whole
 * http(s) link of at most 2,000 characters, as the server allows (#274).
 */
export function sheetLinkProblem(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (v.length > 2000) return 'That link is too long.';
  let url: URL;
  try { url = new URL(v); } catch { return 'The sheet’s link must be a whole web address, starting with https://.'; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'The sheet’s link must start with https:// or http://.';
  return null;
}

/** "dndbeyond.com" for a sheet link: where it goes, without the noise. */
export function sheetLinkHost(link: string): string {
  try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return link; }
}

/** The body for `POST` or `PUT /api/tabletop/characters`. "" leaves it in no campaign. */
export function adventurerPayload(f: AdventurerForm) {
  return {
    name: f.name.trim(),
    class: f.class.trim(),
    level: Number(f.level),
    gameType: f.gameType.trim(),
    campaign: f.campaign,
    isDead: f.isDead,
    sheetUrl: f.sheetUrl.trim(),
  };
}

/**
 * The campaigns to offer: the viewer's own, plus the one it's already in when
 * that isn't among them (a player may leave it where it is, #202).
 */
export function campaignChoices(
  mine: readonly { _id: string; title: string }[],
  current: Adventurer | null,
): { _id: string; title: string }[] {
  const list = [...mine];
  const id = current ? campaignIdOf(current) : null;
  if (current && id && !list.some((c) => c._id === id)) list.push({ _id: id, title: campaignTitleOf(current) ?? 'Its campaign' });
  return list;
}
