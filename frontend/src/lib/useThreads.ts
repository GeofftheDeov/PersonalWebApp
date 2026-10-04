"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { campaignThreadKey, dmThreadKey } from './realtime/threadKeys';

/**
 * Letters thread list (#100, spec #58), headless.
 *
 * Wraps GET /api/threads and POST /api/threads/:threadKey/read. It renders
 * nothing, so the social dock and any later Letters panel can draw it however
 * they like. The list never carries message text.
 */

export type ThreadFilter = 'all' | 'campaigns' | 'friends';

export interface ThreadSummary {
  /** `campaign:<campaign id>` or `dm:<sorted id pair>`. */
  threadKey: string;
  kind: 'campaign' | 'dm';
  /** What to open: the campaign id, or the friend's account id. */
  targetId: string;
  title: string;
  /** Up to two initials to draw an avatar from. */
  avatarHint: string;
  /** "Campaign · 5 in the party" or "Friend". */
  subtitle: string;
  /** ISO time of the newest message, or null if nobody has written yet. */
  lastActivityAt: string | null;
  unreadCount: number;
}

const token = () => (typeof window !== 'undefined' ? localStorage.getItem('token') : null);

/** The signed-in account id from the JWT, or null. */
function myAccountId(): string | null {
  try {
    const t = token();
    return t ? JSON.parse(atob(t.split('.')[1]))?.id ?? null : null;
  } catch {
    return null;
  }
}

/** The thread key for a campaign chat or a DM with a friend, matching the server's. */
export function threadKeyFor(kind: 'campaign' | 'dm', id: string): string | null {
  if (kind === 'campaign') return campaignThreadKey(id);
  const me = myAccountId();
  return me ? dmThreadKey(me, id) : null;
}

const matches = (filter: ThreadFilter) => (t: ThreadSummary) =>
  filter === 'all' || (filter === 'campaigns' ? t.kind === 'campaign' : t.kind === 'dm');

/**
 * The person's threads, newest activity first.
 *
 * `threads` is narrowed by `filter`; `totalUnread` always counts every thread,
 * so a badge stays right whichever tab is showing. `markRead` clears a thread's
 * count at once and records the read position on the server.
 */
export function useThreads({ filter = 'all', pollMs = 30_000, enabled = true }:
  { filter?: ThreadFilter; pollMs?: number; enabled?: boolean } = {}) {
  const [all, setAll] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** threadKey → the last message id we marked read, so re-renders don't re-post. */
  const marked = useRef<Map<string, string>>(new Map());
  /** threadKey → when we last marked it read, so a fetch that started earlier can't bring the old count back. */
  const markedAt = useRef<Map<string, number>>(new Map());

  const refresh = useCallback(async () => {
    const t = token();
    if (!t) return;
    const started = Date.now();
    setLoading(true);
    try {
      const res = await fetch('/api/threads', { headers: { Authorization: `Bearer ${t}` } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not load conversations');
      const data = await res.json();
      const fresh: ThreadSummary[] = Array.isArray(data?.threads) ? data.threads : [];
      setAll(fresh.map(th => ((markedAt.current.get(th.threadKey) ?? 0) >= started ? { ...th, unreadCount: 0 } : th)));
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Could not load conversations');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled || !token()) return;
    refresh();
    if (!pollMs) return;
    const interval = setInterval(refresh, pollMs);
    return () => clearInterval(interval);
  }, [enabled, pollMs, refresh]);

  const markRead = useCallback(async (threadKey: string, messageId: string) => {
    const t = token();
    if (!t || !threadKey || !messageId || marked.current.get(threadKey) === messageId) return;
    marked.current.set(threadKey, messageId);
    markedAt.current.set(threadKey, Date.now());
    setAll(prev => prev.map(th => (th.threadKey === threadKey ? { ...th, unreadCount: 0 } : th)));
    try {
      const res = await fetch(`/api/threads/${encodeURIComponent(threadKey)}/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify({ messageId }),
      });
      if (!res.ok) throw new Error('mark read failed');
    } catch {
      marked.current.delete(threadKey);
      markedAt.current.delete(threadKey);
      refresh(); // put the real count back
    }
  }, [refresh]);

  const threads = useMemo(() => all.filter(matches(filter)), [all, filter]);
  const totalUnread = useMemo(() => all.reduce((n, t) => n + (t.unreadCount || 0), 0), [all]);

  return { threads, totalUnread, loading, error, refresh, markRead };
}
