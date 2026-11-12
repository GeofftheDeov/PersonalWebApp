import { errorOf, type ApiClient } from '@gtd/shared/api';

/**
 * Quests (#90) on Hearthside: the shape /api/quests returns, which of yours
 * Your Quests shows in the rail (#221), and the store the rail ticks them off
 * through. Only the existing quests API (spec #69: today's data only):
 *
 *   GET  /api/quests/mine?scope=all   every open or done quest of yours
 *   POST /api/quests/:id/done         its owner (or the GM) marks it done; there's no undoing it
 *
 * The rail asks for `scope=all` rather than the Quest Log's default
 * (`upcoming`, open quests only) so a quest you ticked stays on the rail,
 * struck through, until its session is over, and is still done after a reload.
 */
export interface Quest {
  id: string;
  sessionId: string;
  kind: 'host_prep' | 'food' | 'custom';
  title: string;
  notes: string | null;
  assignee: { id: string; name: string } | null;
  /** ISO. null while the session's night is still being voted on. */
  dueAt: string | null;
  status: 'open' | 'done' | 'cancelled';
  reminderOffsets: number[];
  remindersSent: number[];
  createdBy: string | null;
  createdAt: string;
  completedAt: string | null;
  session: {
    id: string;
    title: string;
    date: string | null;
    endDate: string | null;
    status: string;
    campaign: { id: string; title: string };
  };
}

/** The tag beside a quest's name; a GM's own (custom) quest has none. */
export const KIND_TAG: Record<Quest['kind'], string | null> = {
  host_prep: 'Host',
  food: 'Food',
  custom: null,
};

/** A session with no end time counts as over this long after it starts (the backend's SESSION_GRACE). */
const SESSION_GRACE_MS = 4 * 60 * 60 * 1000;

/**
 * The quests Your Quests shows: open and done ones, for sessions being
 * planned or still to come (one that's started stays until it ends). The
 * server's order (soonest due first) is kept, so ticking one doesn't move it.
 */
export function railQuests(quests: readonly Quest[], now: Date): Quest[] {
  return quests.filter((q) => {
    if (q.status === 'cancelled') return false;
    const s = q.session;
    if (s.status !== 'planning' && s.status !== 'scheduled') return false;
    if (!s.date) return true;
    const over = s.endDate ? Date.parse(s.endDate) : Date.parse(s.date) + SESSION_GRACE_MS;
    return over >= now.getTime();
  });
}

const WEEK_MS = 6 * 24 * 60 * 60 * 1000;

/**
 * When a quest is due, short enough for the rail: "Sat 5:30 pm" this week,
 * "Nov 14, 5:30 pm" after that, from its due time or else its session's start.
 */
export function questWhen(q: Pick<Quest, 'dueAt' | 'session'>, now: Date): string {
  const due = q.dueAt ?? q.session.date;
  if (!due) return q.session.status === 'planning' ? 'When the night is set' : 'No set time';
  const d = new Date(due);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  const soon = Math.abs(d.getTime() - now.getTime()) < WEEK_MS;
  const day = soon
    ? d.toLocaleDateString(undefined, { weekday: 'short' })
    : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })},`;
  return `${day} ${time}`;
}

export interface QuestRailState {
  /** `idle` before the first load (or signed out); `loading` only until the first answer. */
  status: 'idle' | 'loading' | 'ready' | 'error';
  quests: Quest[];
  /** The last thing that went wrong, fit to show. */
  error: string | null;
  /** Quests ticked here whose done the server hasn't confirmed yet. */
  ticking: ReadonlySet<string>;
}

const EMPTY: QuestRailState = { status: 'idle', quests: [], error: null, ticking: new Set() };

/**
 * Your quests, for the rail and any page that ticks them (a session's slips,
 * the Almanac): one store per tab, so a quest ticked anywhere shows done
 * everywhere at once. Framework-free; `useYourQuests` (src/lib/useQuests.ts)
 * is its React face.
 */
export function createQuestStore({ api, now = () => new Date() }: {
  api: Pick<ApiClient, 'get' | 'post'>;
  now?: () => Date;
}) {
  let state: QuestRailState = EMPTY;
  const listeners = new Set<() => void>();
  /** Bumped by every load and tick, so a load that started earlier can't overwrite what changed since. */
  let version = 0;

  const set = (patch: Partial<QuestRailState>) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  };
  const replace = (q: Quest) => state.quests.map((x) => (x.id === q.id ? q : x));

  return {
    getState: () => state,

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    /** Fetches your quests again. The rail keeps showing the last list meanwhile. */
    async load() {
      const v = ++version;
      if (state.status === 'idle') set({ status: 'loading' });
      try {
        const data = await api.get<{ quests?: Quest[] }>('/api/quests/mine?scope=all');
        if (v !== version) return;
        set({ status: 'ready', quests: railQuests(data?.quests ?? [], now()), error: null });
      } catch (err) {
        if (v !== version) return;
        set({ status: state.status === 'ready' ? 'ready' : 'error', error: errorOf(err, "Couldn't fetch your quests") });
      }
    },

    /** Ticks a quest off: done at once, undone again if the server refuses. */
    async complete(questId: string) {
      const before = state.quests.find((q) => q.id === questId);
      if (!before || before.status !== 'open' || state.ticking.has(questId)) return;
      version++;
      set({
        quests: replace({ ...before, status: 'done' }),
        ticking: new Set([...state.ticking, questId]),
        error: null,
      });
      const settled = () => new Set([...state.ticking].filter((id) => id !== questId));
      try {
        const done = await api.post<Quest>(`/api/quests/${encodeURIComponent(questId)}/done`);
        set({ quests: done?.id ? replace(done) : state.quests, ticking: settled() });
      } catch (err) {
        set({ quests: replace(before), ticking: settled(), error: errorOf(err, "Couldn't mark it done") });
      }
    },

    /** Signed out: nothing to show. */
    reset() {
      version++;
      set(EMPTY);
    },
  };
}

export type QuestStore = ReturnType<typeof createQuestStore>;
