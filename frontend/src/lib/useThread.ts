"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveThread, type LiveMessage, type ThreadStatus } from './realtime/useLiveThread';

/**
 * One open thread (#101, spec #58), headless: history paging, the live
 * subscription, send and mark-read, so Table Talk on a campaign page and the
 * dock's thread view behave identically. It renders nothing.
 *
 *   const t = useThread(threadKey, { markRead });
 *   t.messages   // oldest first; your unsent messages last, `sending` or `failed`
 *   t.loadOlder()  t.send(body)  t.resend(key)  t.discard(key)
 *
 * - History is GET /api/threads/:threadKey/messages, newest first, paged with
 *   `before` = the oldest message id held. The latest page loads on open and
 *   again after every live-channel reconnect (nothing is replayed).
 * - A send shows at once as `sending`. If it fails (offline, a server error) it
 *   stays in the log as `failed` with its error until resent or discarded. Each
 *   message carries a clientId the server dedupes on, so a resend after a lost
 *   response still lands exactly once.
 * - The newest message is marked read on open and whenever a newer one
 *   arrives while the thread is open. Pass `markRead` (e.g. useThreads'
 *   markRead, which also clears the list's count at once); without it the hook
 *   posts the read position itself.
 */

export interface ThreadEntry {
    /** Stable React key: the clientId for your own sends, else the message id. */
    key: string;
    /** The stored message's id; null until the server has it. */
    id: string | null;
    sender: { id: string; name: string };
    body: string;
    createdAt: string;
    eventId?: string;
    state: 'sent' | 'sending' | 'failed';
    /** Why a failed send failed. */
    error?: string;
}

export interface UseThreadOptions {
    pageSize?: number;
    markRead?: (threadKey: string, messageId: string) => void;
}

const token = () => (typeof window !== 'undefined' ? localStorage.getItem('token') : null);

/** The signed-in account id from the JWT, or null. Used for "mine" alignment only. */
export function myAccountId(): string | null {
    try {
        const t = token();
        return t ? JSON.parse(atob(t.split('.')[1]))?.id ?? null : null;
    } catch {
        return null;
    }
}

const newClientId = (): string => {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch { /* insecure context */ }
    return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
};

/** How many older pages a reconnect fetches to close the gap before starting the log afresh. */
const MAX_CATCH_UP_PAGES = 4;

const messagesUrl =(threadKey: string) => `/api/threads/${encodeURIComponent(threadKey)}/messages`;

const fromServer = (m: LiveMessage, key = m.id): ThreadEntry => ({
    key, id: m.id, sender: m.sender, body: m.body, createdAt: m.createdAt,
    ...(m.eventId ? { eventId: m.eventId } : {}),
    state: 'sent',
});

const byTime = (a: ThreadEntry, b: ThreadEntry) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : (a.id ?? '') < (b.id ?? '') ? -1 : 1;

async function postRead(threadKey: string, messageId: string) {
    const t = token();
    if (!t) return;
    await fetch(`/api/threads/${encodeURIComponent(threadKey)}/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify({ messageId }),
    }).catch(() => { /* the next open marks it again */ });
}

export function useThread(threadKey: string | null, { pageSize = 50, markRead }: UseThreadOptions = {}) {
    /** Stored messages by id. */
    const [sent, setSent] = useState<Map<string, ThreadEntry>>(() => new Map());
    /** Your sends the server hasn't confirmed, in the order you sent them. */
    const [pending, setPending] = useState<ThreadEntry[]>([]);
    const [hasMore, setHasMore] = useState(false);
    const [loading, setLoading] = useState(false);
    const [loadingOlder, setLoadingOlder] = useState(false);
    const [error, setError] = useState<string | null>(null);

    /** Bumped on every thread switch, so responses for a thread that's gone are dropped. */
    const generation = useRef(0);
    const pendingRef = useRef<ThreadEntry[]>([]);
    pendingRef.current = pending;
    const olderInFlight = useRef(false);
    const firstPageLoaded = useRef(false);

    const sentRef = useRef(sent);
    sentRef.current = sent;

    /**
     * Adds stored messages. For a live echo (`echo`), a new message of yours
     * whose body matches a send still in flight is that send (the echo beat the
     * POST response), so it takes that entry's place and key instead of
     * showing twice. History pages never do this: an old message with the same
     * text is a different message.
     */
    const addSent = useCallback((msgs: LiveMessage[], { echo = false } = {}) => {
        if (!msgs.length) return;
        const absorbed = new Map<string, string>(); // message id → pending key
        if (echo) {
            const me = myAccountId();
            const waiting = pendingRef.current.filter((p) => p.state === 'sending');
            for (const m of msgs) {
                if (m.sender?.id !== me || sentRef.current.has(m.id)) continue;
                const i = waiting.findIndex((p) => p.body === m.body);
                if (i >= 0) absorbed.set(m.id, waiting.splice(i, 1)[0].key);
            }
        }
        setSent((prev) => {
            let next: Map<string, ThreadEntry> | null = null;
            for (const m of msgs) {
                if (prev.has(m.id)) continue;
                next ??= new Map(prev);
                next.set(m.id, fromServer(m, absorbed.get(m.id)));
            }
            return next ?? prev;
        });
        if (absorbed.size) {
            const keys = new Set(absorbed.values());
            setPending((prev) => prev.filter((p) => !keys.has(p.key)));
        }
    }, []);

    const fetchPage = useCallback(async (key: string, before?: string) => {
        const t = token();
        if (!t) throw new Error('Sign in to see this conversation');
        const qs = `?limit=${pageSize}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
        const res = await fetch(`${messagesUrl(key)}${qs}`, { headers: { Authorization: `Bearer ${t}` } });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || 'Could not load messages');
        return { messages: (data.messages ?? []) as LiveMessage[], hasMore: !!data.hasMore };
    }, [pageSize]);

    /**
     * The latest page. On open, and after every reconnect. After a reconnect it
     * pages back until it meets what's already held, so nothing missed while
     * offline is skipped; after MAX_CATCH_UP_PAGES it starts the log afresh
     * from the latest pages instead (scrolling up loads the rest).
     */
    const loadLatest = useCallback(async () => {
        if (!threadKey) return;
        const gen = generation.current;
        setLoading(true);
        try {
            const page = await fetchPage(threadKey);
            if (gen !== generation.current) return;
            const fetched = [...page.messages]; // newest first
            let more = page.hasMore;
            if (!firstPageLoaded.current) {
                firstPageLoaded.current = true;
                setHasMore(more);
            } else if (sentRef.current.size) {
                const meets = () => fetched.some((m) => sentRef.current.has(m.id));
                for (let n = 0; more && !meets() && n < MAX_CATCH_UP_PAGES; n++) {
                    const older = await fetchPage(threadKey, fetched[fetched.length - 1].id);
                    if (gen !== generation.current) return;
                    fetched.push(...older.messages);
                    more = older.hasMore;
                }
                if (more && !meets()) {
                    setSent(new Map()); // too far behind: drop the stale log and page back from here
                    setHasMore(true);
                }
            }
            addSent(fetched);
            setError(null);
        } catch (err: any) {
            if (gen === generation.current) setError(err.message || 'Could not load messages');
        } finally {
            if (gen === generation.current) setLoading(false);
        }
    }, [threadKey, fetchPage, addSent]);

    const messages = useMemo(
        () => [...[...sent.values()].sort(byTime), ...pending],
        [sent, pending],
    );
    const oldestId = useMemo(() => {
        let oldest: ThreadEntry | null = null;
        for (const m of sent.values()) if (!oldest || byTime(m, oldest) < 0) oldest = m;
        return oldest?.id ?? null;
    }, [sent]);

    /** The page before the oldest message held. Safe to call repeatedly (e.g. on every scroll event). */
    const loadOlder = useCallback(async () => {
        if (!threadKey || !hasMore || !oldestId || olderInFlight.current) return;
        const gen = generation.current;
        olderInFlight.current = true;
        setLoadingOlder(true);
        try {
            const page = await fetchPage(threadKey, oldestId);
            if (gen !== generation.current) return;
            addSent(page.messages);
            setHasMore(page.hasMore);
        } catch (err: any) {
            if (gen === generation.current) setError(err.message || 'Could not load older messages');
        } finally {
            if (gen === generation.current) {
                olderInFlight.current = false;
                setLoadingOlder(false);
            }
        }
    }, [threadKey, hasMore, oldestId, fetchPage, addSent]);

    // A new thread starts empty.
    useEffect(() => {
        generation.current++;
        olderInFlight.current = false;
        firstPageLoaded.current = false;
        setSent(new Map());
        setPending([]);
        setHasMore(false);
        setLoadingOlder(false);
        setError(null);
        loadLatest();
    }, [loadLatest]);

    const status: ThreadStatus = useLiveThread(threadKey, {
        onMessage: (m) => addSent([m], { echo: true }),
        onReconnect: () => { loadLatest(); },
    });

    /* -------------------------------- send ------------------------------- */

    const post = useCallback(async (entry: ThreadEntry) => {
        if (!threadKey) return;
        const gen = generation.current;
        const settle = (patch: Partial<ThreadEntry> | null) => {
            if (gen !== generation.current) return;
            setPending((prev) => (patch === null
                ? prev.filter((p) => p.key !== entry.key)
                : prev.map((p) => (p.key === entry.key ? { ...p, ...patch } : p))));
        };
        try {
            const res = await fetch(messagesUrl(threadKey), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
                body: JSON.stringify({ body: entry.body, clientId: entry.key }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data?.message) {
                settle({ state: 'failed', error: data?.error || `Not sent (${res.status})` });
                return;
            }
            if (gen !== generation.current) return;
            const m: LiveMessage = data.message;
            setSent((prev) => {
                if (prev.has(m.id)) return prev;
                // Keep React keys unique if an echo of a look-alike message took this key.
                const keyTaken = [...prev.values()].some((e) => e.key === entry.key);
                const next = new Map(prev);
                next.set(m.id, fromServer(m, keyTaken ? m.id : entry.key));
                return next;
            });
            settle(null);
        } catch {
            const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
            settle({ state: 'failed', error: offline ? "Not sent: you're offline" : 'Not sent: no connection to the server' });
        }
    }, [threadKey]);

    /** Sends a message. It shows at once; false only when there's nothing to send. */
    const send = useCallback((text: string): boolean => {
        const body = text.trim();
        if (!body || !threadKey) return false;
        const me = myAccountId();
        const entry: ThreadEntry = {
            key: newClientId(), id: null, sender: { id: me ?? '', name: 'You' }, body,
            createdAt: new Date().toISOString(), state: 'sending',
        };
        setPending((prev) => [...prev, entry]);
        post(entry);
        return true;
    }, [threadKey, post]);

    /** Tries a failed send again, with the same clientId so it can't land twice. */
    const resend = useCallback((key: string) => {
        const entry = pendingRef.current.find((p) => p.key === key && p.state === 'failed');
        if (!entry) return;
        setPending((prev) => prev.map((p) => (p.key === key ? { ...p, state: 'sending', error: undefined } : p)));
        post(entry);
    }, [post]);

    /** Drops a failed send from the log. */
    const discard = useCallback((key: string) => {
        setPending((prev) => prev.filter((p) => !(p.key === key && p.state === 'failed')));
    }, []);

    /* ------------------------------ mark read ----------------------------- */

    const markReadRef = useRef(markRead);
    markReadRef.current = markRead;
    const lastMarked = useRef<{ thread: string | null; id: string | null }>({ thread: null, id: null });
    const newest = useMemo(() => {
        let n: ThreadEntry | null = null;
        for (const m of sent.values()) if (!n || byTime(m, n) > 0) n = m;
        return n?.id ?? null;
    }, [sent]);
    useEffect(() => {
        if (!threadKey || !newest) return;
        if (lastMarked.current.thread === threadKey && lastMarked.current.id === newest) return;
        lastMarked.current = { thread: threadKey, id: newest };
        (markReadRef.current ?? postRead)(threadKey, newest);
    }, [threadKey, newest]);

    return { messages, status, loading, loadingOlder, hasMore, error, loadOlder, send, resend, discard };
}
