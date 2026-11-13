/**
 * The Notice Board (#222, spec #69): sessions being planned, as Hearthside
 * pins them up. Each is a NoticeSheet on parchment with its numbered
 * PlannerSteps (the night; in person, the venue and the food), its votes
 * and its actions. The Hearth shows every one in the player's campaigns;
 * a campaign's page shows its own (#225). Kept apart from React so the
 * rules are tested on their own (test/notice-board.test.ts).
 *
 * Today's data only, from the planning API (backend/planning/planner.ts):
 *
 *   GET  /api/planning/campaigns/:id     the board: { canPlan, gmTitle, party, planning: [PlanningState], upcoming }
 *   GET  /api/planning/sessions/:id      one PlanningState
 *   POST /api/planning/sessions/:id/...  vote, advance, tiebreak, suggest-venue, food/…, confirm-food, cancel
 */
import { timeSpan } from './sessionPage';

export type Stage = 'night' | 'venue' | 'food';
export type FoodMode = 'potluck' | 'provided';

export interface Member {
  id: string;
  name: string;
}

/** A venue as the party sees it. The address is only sent while it's shortlisted or confirmed. */
export interface Venue {
  id: string;
  name: string;
  kind: 'home' | 'store' | 'other';
  hostId: string | null;
  address: string | null;
  lastUsedAt: string | null;
}

export interface PollOption {
  id: string;
  /** A night option's time; null on the venue vote. */
  start: string | null;
  end: string | null;
  /** A venue option's venue; null on the night vote. */
  venueId: string | null;
  suggestedBy: string | null;
  /** Who chose this option. */
  approvals: string[];
  meetsQuorum: boolean;
  /** On the venue vote, the venue itself. */
  venue?: Venue | null;
}

/**
 * A vote: the night (approval: tick every night you can make) or the venue
 * (pick one). It closes when everyone eligible has voted, or when the GM
 * moves it forward; a tie goes to the GM.
 */
export interface Poll {
  id: string;
  kind?: 'night' | 'venue';
  round: number;
  status: 'open' | 'closed';
  result: 'winner' | 'tie' | 'no_quorum' | null;
  closedReason: string | null;
  quorum: number | null;
  /** Who may vote: the party when the vote opened. */
  eligibleIds: string[];
  /** Who has voted, including "I can't make any of these". */
  voted: string[];
  winningOptionId: string | null;
  tiedOptionIds: string[];
  options: PollOption[];
}

/** A food quest (#93): a potluck slot (no assignee: unclaimed), or the food owner's provisioning. */
export interface FoodQuest {
  id: string;
  title: string;
  notes: string | null;
  assignee: Member | null;
  status: 'open' | 'done' | 'cancelled';
  dueAt: string | null;
  createdBy: string | null;
}

/** One session being planned, as `GET /api/planning/sessions/:id` (and each of the board's `planning`) sends it. */
export interface PlanningState {
  session: {
    id: string;
    campaignId: string;
    title: string;
    status: string;
    /** Which step it's on; null once it's scheduled. */
    stage: Stage | null;
    isOnline: boolean;
    foodMode: FoodMode | null;
    foodOwnerId: string | null;
    /** Prep notes: the key is there only for the GM, the stand-in and admins (#213). Not shown on the board. */
    agenda?: string | null;
    /** Set while a scheduled session's night is being changed (#87): it stands until a new one is confirmed. */
    date: string | null;
    endDate: string | null;
    location: string | null;
    /** The confirmed venue (#92). */
    venue: Venue | null;
    hostId: string | null;
    /** The one-session stand-in GM (#89). */
    gmOverride: Member | null;
  };
  campaign: { id: string; title: string; gmTitle: string; quorum: number | null; tableLink: string | null; gameMasterIds: string[] };
  party: Member[];
  quorum: number;
  /** `isGameMaster`: the campaign's GM, the stand-in or an admin. `canPassTorch`: the campaign's own GM or an admin. */
  viewer: { id: string; isGameMaster: boolean; canPassTorch: boolean };
  /** The latest night round. */
  night: Poll | null;
  /** Every night round, oldest first; the last is `night`. */
  nightRounds: Poll[];
  /** In person: the latest venue round, each option carrying its venue. */
  venue: Poll | null;
  venueRounds: Poll[];
  /** In person: the campaign's saved venues, most recently used first. */
  venues: Venue[];
  food: { mode: FoodMode; ownerId: string | null; quests: FoodQuest[] } | null;
}

/** A scheduled session still to come, on a campaign's board (#225's Coming up). */
export interface Upcoming {
  id: string;
  title: string;
  date: string;
  endDate: string | null;
  isOnline: boolean;
  canChangeNight: boolean;
  venue: Venue | null;
  hostId: string | null;
}

/** A campaign's Notice Board, as `GET /api/planning/campaigns/:id` sends it. */
export interface Board {
  /** May the viewer start planning (the GM, or an admin)? */
  canPlan: boolean;
  gmTitle: string;
  party: Member[];
  planning: PlanningState[];
  upcoming: Upcoming[];
}

/** The step a session is on. */
export const stageOf = (state: PlanningState): Stage => state.session.stage ?? 'night';

/** The vote running on the session's current step, if any (the food step has none). */
export function currentPoll(state: PlanningState): Poll | null {
  const stage = stageOf(state);
  return stage === 'night' ? state.night : stage === 'venue' ? state.venue : null;
}

/** A party member's name, from the session's party. */
export const nameIn = (state: PlanningState) => (id: string | null | undefined): string =>
  state.party.find((p) => p.id === id)?.name ?? (state.session.gmOverride?.id === id ? state.session.gmOverride.name : 'someone');

/** Is the viewer at this session's table: in its party, or its stand-in GM? (An admin may see any campaign's board.) */
export const isMine = (state: PlanningState): boolean =>
  state.party.some((p) => p.id === state.viewer.id) || state.session.gmOverride?.id === state.viewer.id;

/** Is a vote open on the session's step that the viewer may cast and hasn't? */
export function needsMyVote(state: PlanningState): boolean {
  const poll = currentPoll(state);
  return !!poll && poll.status === 'open' && poll.eligibleIds.includes(state.viewer.id) && !poll.voted.includes(state.viewer.id);
}

/**
 * The Hearth's sheets: the sessions being planned in the viewer's campaigns
 * (`null` for a board that didn't load), the ones waiting on the viewer's
 * vote first, otherwise in board order.
 */
export function boardSheets(boards: readonly (Board | null | undefined)[]): PlanningState[] {
  const all = boards.flatMap((b) => b?.planning ?? []).filter(isMine);
  return [...all.filter(needsMyVote), ...all.filter((s) => !needsMyVote(s))];
}

export type StepState = 'done' | 'live' | 'later';

export interface PlannerStep {
  key: Stage;
  /** Its number on the sheet, from 1. */
  n: number;
  title: string;
  state: StepState;
}

/**
 * A sheet's numbered steps. Online, there's only the night. In person, the
 * venue follows, then the food when a food mode was chosen at kickoff. A
 * scheduled session whose night is being changed (#87) keeps its venue, and
 * no venue vote or food step follows.
 */
export function plannerSteps(state: PlanningState): PlannerStep[] {
  const { session: s } = state;
  const stage = stageOf(state);
  const steps: PlannerStep[] = [{ key: 'night', n: 1, title: stage === 'night' ? 'Pick the night' : 'The night', state: stage === 'night' ? 'live' : 'done' }];
  if (s.isOnline) return steps;
  steps.push({
    key: 'venue', n: 2,
    title: stage === 'venue' ? 'Pick the venue' : 'The venue',
    state: stage === 'venue' ? 'live' : stage === 'food' || s.venue ? 'done' : 'later',
  });
  const changingNight = stage === 'night' && !!s.venue;
  if (s.foodMode && !changingNight) {
    steps.push({ key: 'food', n: 3, title: stage === 'food' ? 'Sort the food' : 'Food', state: stage === 'food' ? 'live' : 'later' });
  }
  return steps;
}

/** Unclaimed potluck slots still open. */
export const unclaimedSlots = (state: PlanningState): number =>
  state.food?.mode === 'potluck' ? state.food.quests.filter((q) => q.status === 'open' && !q.assignee).length : 0;

/** The seal in a sheet's corner: `vote` a vote is open, `tie` something waits on a decision, `wait` it's someone else's move. */
export interface Seal {
  label: string;
  tone: 'vote' | 'tie' | 'wait';
}

export function sheetSeal(state: PlanningState): Seal {
  const gmTitle = state.campaign.gmTitle;
  const gm = state.viewer.isGameMaster;
  const stage = stageOf(state);
  const poll = currentPoll(state);
  if (stage === 'food') {
    const open = unclaimedSlots(state);
    if (open) return { label: `Food · ${open} unclaimed`, tone: 'tie' };
    return gm ? { label: 'Confirm the food', tone: 'wait' } : { label: `Food · waiting on the ${gmTitle}`, tone: 'wait' };
  }
  if (poll?.status === 'open') {
    const what = stage === 'venue' ? 'Pick the venue' : 'Awaiting votes';
    return { label: `${what} · ${poll.voted.length} of ${poll.eligibleIds.length}`, tone: 'vote' };
  }
  if (poll?.status === 'closed' && poll.result === 'tie') return { label: `Tie · the ${gmTitle} decides`, tone: 'tie' };
  if (stage === 'venue') return { label: 'The venue', tone: 'wait' };
  return gm ? { label: 'Pick some nights', tone: 'wait' } : { label: `Waiting on the ${gmTitle}`, tone: 'wait' };
}

/** Who may vote on `poll` and hasn't yet. */
export const waitingOn = (poll: Poll | null): string[] => (poll ? poll.eligibleIds.filter((id) => !poll.voted.includes(id)) : []);

/** One row of the VoteTally. */
export interface TallyRow {
  id: string;
  count: number;
  /** Out of: everyone who may vote. */
  of: number;
  /** The bar's fill, 0 to 1. */
  share: number;
  /** Most votes so far (ties lead together; nobody leads with none). */
  lead: boolean;
  /** The viewer chose it. */
  mine: boolean;
  /** On the night vote, enough of the party can make it. */
  meetsQuorum: boolean;
  voters: string[];
}

export function voteTally(poll: Poll, name: (id: string) => string, viewerId: string): TallyRow[] {
  const top = Math.max(0, ...poll.options.map((o) => o.approvals.length));
  const of = poll.eligibleIds.length;
  return poll.options.map((o) => ({
    id: o.id,
    count: o.approvals.length,
    of,
    share: of ? Math.min(1, o.approvals.length / of) : 0,
    lead: top > 0 && o.approvals.length === top,
    mine: o.approvals.includes(viewerId),
    meetsQuorum: o.meetsQuorum,
    voters: o.approvals.map(name),
  }));
}

const DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

/** A night on the vote: "Fri, Nov 20 · 7–11 pm". */
export const optionWhen = (start: string, end: string | null): string => `${DAY.format(new Date(start))} · ${timeSpan(start, end)}`;

/** Where it will be, under the sheet's title: "Online", or "In person · The Rusty Anchor · potluck". */
export function placeLine(state: PlanningState, name: (id: string) => string): string {
  const s = state.session;
  if (s.isOnline) return 'Online';
  const food = s.foodMode === 'potluck' ? 'potluck'
    : s.foodMode === 'provided' ? `food by ${s.foodOwnerId === state.viewer.id ? 'you' : name(s.foodOwnerId ?? '')}` : null;
  return ['In person', s.venue?.name, food].filter(Boolean).join(' · ');
}

/** The Hearth's heading: "Good evening, Tobin". */
export function greeting(now: Date, user: { name?: string | null; firstName?: string | null } | null): string {
  const h = now.getHours();
  const part = h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 18 ? 'afternoon' : 'evening';
  const first = user?.firstName?.trim() || user?.name?.trim().split(/\s+/)[0] || '';
  return first ? `Good ${part}, ${first}` : `Good ${part}`;
}

const sessions = (n: number) => (n === 1 ? 'One session' : `${n} sessions`);

/** The line under the greeting: what's pinned up, and how much of it waits on the viewer's vote. */
export function hearthLine(sheets: readonly PlanningState[]): string {
  const n = sheets.length;
  const mine = sheets.filter(needsMyVote).length;
  if (!n) return 'Nothing’s pinned to the Notice Board.';
  if (!mine) return `${sessions(n)} ${n === 1 ? 'is' : 'are'} being planned.`;
  if (mine === n) return `${sessions(n)} ${n === 1 ? 'needs' : 'need'} your vote.`;
  return `${sessions(n)} are being planned, and ${mine === 1 ? 'one needs' : `${mine} need`} your vote.`;
}
