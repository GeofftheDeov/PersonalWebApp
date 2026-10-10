/**
 * Quests (#90): the shapes /api/quests returns, and the few helpers the
 * Quest Log, the session page and the Almanac share.
 */
export interface Quest {
    id: string;
    sessionId: string;
    kind: 'host_prep' | 'food' | 'custom';
    title: string;
    notes: string | null;
    assignee: { id: string; name: string } | null;
    dueAt: string | null;
    status: 'open' | 'done' | 'cancelled';
    /** Minutes before dueAt, largest first (#91). */
    reminderOffsets: number[];
    /** The offsets already sent for the current dueAt. */
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

export interface AlmanacSession {
    id: string;
    title: string;
    date: string;
    endDate: string | null;
    status: string;
    isOnline: boolean;
    location: string | null;
    campaign: { id: string; title: string };
    quests: Quest[];
}

export const KIND_LABEL: Record<Quest['kind'], string> = {
    host_prep: 'Host prep',
    food: 'Food',
    custom: 'Quest',
};

/** "Due Sat, Oct 10, 7:00 PM", or why there's no due time yet. */
export function questDue(q: Pick<Quest, 'dueAt' | 'session'>): string {
    if (q.dueAt) {
        return `Due ${new Date(q.dueAt).toLocaleString(undefined, {
            weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        })}`;
    }
    return q.session.status === 'planning' ? 'Due when the night is set' : 'No due time';
}

// ── reminders (#91) ─────────────────────────────────────────────────────────

/** The server's limits on reminder offsets. */
export const MAX_REMINDERS = 5;
export const MAX_REMINDER_MINUTES = 14 * 24 * 60;
const MORNING_HOUR = 9;

export interface ReminderPreset { label: string; minutes: number }

const FIXED_PRESETS: ReminderPreset[] = [
    { label: '30 min before', minutes: 30 },
    { label: '2 hours before', minutes: 120 },
    { label: 'The day before', minutes: 24 * 60 },
    { label: 'A week before', minutes: 7 * 24 * 60 },
];

/** Minutes from 9 AM (this browser's time) `daysBefore` days before the due date, to the due time. */
function morningOffset(dueAt: string, daysBefore: number): number | null {
    const due = new Date(dueAt);
    const morning = new Date(due);
    morning.setDate(morning.getDate() - daysBefore);
    morning.setHours(MORNING_HOUR, 0, 0, 0);
    const minutes = Math.round((+due - +morning) / 60_000);
    return minutes >= 1 && minutes <= MAX_REMINDER_MINUTES ? minutes : null;
}

/**
 * The presets the picker offers. "The morning of / before" depend on the due
 * time, so they're offered only once there is one, and are stored as the
 * minutes they work out to for it.
 */
export function reminderPresets(dueAt: string | null): ReminderPreset[] {
    const presets = [...FIXED_PRESETS];
    if (dueAt) {
        const of = morningOffset(dueAt, 0), before = morningOffset(dueAt, 1);
        if (before !== null) presets.splice(2, 0, { label: 'The morning before', minutes: before });
        if (of !== null) presets.splice(2, 0, { label: 'The morning of', minutes: of });
    }
    // Two presets can land on the same minutes (e.g. a 9 AM due time): keep the first.
    return presets.filter((p, i) => presets.findIndex(q => q.minutes === p.minutes) === i);
}

/** "2 hours before", "The morning of", or a plain "1d 3h before". */
export function describeOffset(minutes: number, dueAt: string | null): string {
    const preset = reminderPresets(dueAt).find(p => p.minutes === minutes);
    if (preset) return preset.label;
    const d = Math.floor(minutes / 1440), h = Math.floor((minutes % 1440) / 60), m = minutes % 60;
    return `${[d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ')} before`;
}

/** When a reminder goes out, e.g. "Fri, Oct 9, 9:00 AM"; null without a due time. */
export function reminderTime(minutes: number, dueAt: string | null): string | null {
    if (!dueAt) return null;
    return new Date(+new Date(dueAt) - minutes * 60_000).toLocaleString(undefined, {
        weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
}

/** fetch() against the API with the signed-in user's token; throws the server's message on failure. */
export async function questApi<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    const res = await fetch(`/api/quests${path}`, {
        method: init.method ?? 'GET',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
    return json as T;
}
