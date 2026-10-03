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
    reminderOffsets: number[];
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
