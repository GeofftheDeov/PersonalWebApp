/**
 * A session's round table (#227, spec #69): the rules the table follows,
 * kept apart from React so they can be tested. Today's data only:
 *
 *   GET /api/planning/sessions/:id              the party, the GM's ids and the stand-in (via useSessionPage)
 *   GET /api/tabletop/sessions/:id              the session, with its `readyCheck` responses (via useSessionPage)
 *   GET /api/tabletop/characters?campaign=:id   the party's adventurers in this campaign
 *   GET /api/quests/sessions/:id                the session's quests, and whether the viewer is its GM
 *   GET /api/tabletop/sessions/:id/attendance   who came, once the GM has confirmed it
 */
import type { Quest } from './quests';
import { whenFromNow, type SessionPhase } from './sessionPage';

export interface PartyMember {
  id: string;
  name: string;
}

/** A session's ready check, as the session read sends it: each answer, keyed by person. */
export interface ReadyCheck {
  sentAt?: string | null;
  responses?: Array<{ playerId: string; name?: string; ready: boolean; respondedAt?: string }>;
}

/** One person's row in GET /api/tabletop/sessions/:id/attendance (#37). */
export interface AttendanceRow {
  playerId: string;
  name: string;
  active: boolean;
  attended: boolean;
  /** Their ready-check answer, or null. */
  ready: boolean | null;
}

/** GET /api/tabletop/sessions/:id/attendance. A GM sees the whole party; anyone else, who came. */
export interface Attendance {
  sessionId: string;
  /** Null until the GM confirms who came; that's what tells "nobody came" from "not taken yet". */
  confirmedAt: string | null;
  confirmedBy: string | null;
  /** The viewer may take it: the session's GM, its stand-in or an admin. */
  canConfirm: boolean;
  /** The session has started, so attendance can be taken. */
  open: boolean;
  people: AttendanceRow[];
}

/** An adventurer in GET /api/tabletop/characters?campaign=:id. */
export interface CampaignCharacter {
  _id?: string;
  id?: string;
  name: string;
  class?: string | null;
  level?: number | null;
  isDead?: boolean | null;
  player: { _id: string; name: string } | string | null;
}

/** Who may tick: from GET /api/quests/sessions/:id. */
export interface QuestViewer {
  id: string;
  isGameMaster: boolean;
}

/**
 * Who sits at the head: the session's stand-in while they're in the party,
 * else the first of the campaign's Game Masters in the party's order. Null
 * when no GM is in the party (an admin running it from outside).
 */
export function headOf(party: readonly PartyMember[], gameMasterIds: readonly string[], standInId: string | null): string | null {
  if (standInId && party.some((p) => p.id === standInId)) return standInId;
  return party.find((p) => gameMasterIds.includes(p.id))?.id ?? null;
}

const playerIdOf = (c: CampaignCharacter) => (typeof c.player === 'string' ? c.player : c.player?._id ?? null);

/** The adventurer a seat shows: the player's one adventurer in this campaign who hasn't fallen, if they have exactly one. */
export function adventurerOf(characters: readonly CampaignCharacter[] | null, playerId: string): CampaignCharacter | null {
  const living = (characters ?? []).filter((c) => playerIdOf(c) === playerId && !c.isDead);
  return living.length === 1 ? living[0] : null;
}

export interface Seat {
  personId: string;
  /** The player's own name. */
  name: string;
  /** Their adventurer's name, when the seat shows one. */
  adventurer: string | null;
  head: boolean;
}

/** The seats, the head first, then the party in its own order. The GM at the head sits as themself. */
export function tableSeats(party: readonly PartyMember[], headId: string | null, characters: readonly CampaignCharacter[] | null): Seat[] {
  const head = party.find((p) => p.id === headId);
  const rest = party.filter((p) => p.id !== headId);
  return [
    ...(head ? [{ personId: head.id, name: head.name, adventurer: null, head: true }] : []),
    ...rest.map((p) => ({ personId: p.id, name: p.name, adventurer: adventurerOf(characters, p.id)?.name ?? null, head: false })),
  ];
}

/** How far from the middle the seats sit, as a percentage of the table's width. */
const SEAT_RADIUS = 38;

/** Where each seat's portrait sits, in percent of the table: evenly round it, the first at the top. */
export function seatPositions(n: number): Array<{ x: number; y: number }> {
  const round = (v: number) => Math.round(v * 10) / 10 + 0; // + 0 turns -0 into 0
  return Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return { x: round(50 + SEAT_RADIUS * Math.cos(a)), y: round(50 + SEAT_RADIUS * Math.sin(a)) };
  });
}

/**
 * How a seat looks:
 * - `came` or `away` (an empty grey seat) while the GM taps seats, and once
 *   attendance is confirmed;
 * - otherwise `ready` (green) or `not-ready` (red) from the ready check;
 * - else nothing.
 */
export type SeatMark = 'came' | 'away' | 'ready' | 'not-ready' | null;

export function seatMark(personId: string, { phase, readyCheck, attendance, draft }: {
  phase: SessionPhase;
  readyCheck?: ReadyCheck | null;
  attendance?: Attendance | null;
  /** The GM's taps while they take attendance. */
  draft?: ReadonlySet<string> | null;
}): SeatMark {
  if (draft) return draft.has(personId) ? 'came' : 'away';
  if (attendance?.confirmedAt) {
    return attendance.people.some((p) => p.playerId === personId && p.attended) ? 'came' : 'away';
  }
  if (phase === 'cancelled') return null;
  const answer = readyCheck?.responses?.find((r) => r.playerId === personId);
  if (!answer) return null;
  return answer.ready ? 'ready' : 'not-ready';
}

/** Where the GM's taps start: who was recorded, or before it's taken, who came or said they were ready. */
export function attendanceDraft(a: Attendance): Set<string> {
  return new Set(a.people.filter((p) => (a.confirmedAt ? p.attended : p.attended || p.ready === true)).map((p) => p.playerId));
}

/** The ready check's count among those at the table. */
export function readyTally(readyCheck: ReadyCheck | null | undefined, seatIds: readonly string[]) {
  const answers = (readyCheck?.responses ?? []).filter((r) => seatIds.includes(r.playerId));
  return { ready: answers.filter((r) => r.ready).length, answered: answers.length, total: seatIds.length };
}

/** Each seat's slips: its player's quests, in the server's order. A quest nobody owns sits at no seat. */
export function slipsBySeat(quests: readonly Quest[]): Map<string, Quest[]> {
  const by = new Map<string, Quest[]>();
  for (const q of quests) {
    if (!q.assignee) continue;
    by.set(q.assignee.id, [...(by.get(q.assignee.id) ?? []), q]);
  }
  return by;
}

/** Players tick (and untick) their own quests; the GM (or stand-in, or an admin) anyone's. */
export const canTick = (q: Pick<Quest, 'status' | 'assignee'>, viewer: QuestViewer | null): boolean =>
  !!viewer && q.status !== 'cancelled' && (viewer.isGameMaster || q.assignee?.id === viewer.id);

/** The GM's "+ quest" on each seat: before the session, while it still takes quests. */
export const canAddQuests = (s: { status?: string | null }, phase: SessionPhase, isGameMaster: boolean): boolean =>
  isGameMaster && phase === 'before' && s.status !== 'cancelled' && s.status !== 'completed';

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** Time left until `iso`, in its two largest units: "3 days, 4 hours", "22 minutes", "under a minute". */
export function countdown(iso: string, now: Date): string {
  const mins = Math.floor((Date.parse(iso) - now.getTime()) / 60_000);
  if (mins < 1) return 'under a minute';
  const days = Math.floor(mins / 1440), hours = Math.floor((mins % 1440) / 60), minutes = mins % 60;
  const parts = days ? [plural(days, 'day'), hours && plural(hours, 'hour')] : hours ? [plural(hours, 'hour'), minutes && plural(minutes, 'minute')] : [plural(minutes, 'minute')];
  return parts.filter(Boolean).join(', ');
}

/** The recording's link (today's `vodUrl`), when it's a web address; anything else isn't followed. */
export function recordingUrl(v: string | null | undefined): string | null {
  const url = v?.trim();
  return url && /^https?:\/\/\S+$/i.test(url) ? url : null;
}

/**
 * What the card in the middle of the table shows (its front only, #227):
 * before the session a countdown to it, or that it has no night yet, or
 * that it's under way; after it the recording's link, or "No recording
 * yet"; and nothing to record once it's cancelled.
 */
export type MiddleCard =
  | { kind: 'countdown'; when: string; left: string }
  | { kind: 'unscheduled' }
  | { kind: 'under-way' }
  | { kind: 'recording'; url: string }
  | { kind: 'no-recording' }
  | { kind: 'cancelled' };

export function middleCard(s: { status?: string | null; date?: string | null; endDate?: string | null; vodUrl?: string | null }, phase: SessionPhase, now: Date): MiddleCard {
  if (phase === 'cancelled') return { kind: 'cancelled' };
  if (phase === 'after') {
    const url = recordingUrl(s.vodUrl);
    return url ? { kind: 'recording', url } : { kind: 'no-recording' };
  }
  if (s.status === 'planning' || !s.date) return { kind: 'unscheduled' };
  if (Date.parse(s.date) <= now.getTime()) return { kind: 'under-way' };
  return { kind: 'countdown', when: whenFromNow(s.date, now), left: countdown(s.date, now) };
}
