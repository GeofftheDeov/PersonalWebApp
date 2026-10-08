"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { campaignThreadKey, dmThreadKey } from './realtime/threadKeys';
import { getLiveClient } from './realtime/useLiveThread';
import type { ThreadRead, ThreadUpdate } from './realtime/liveClient';

/**
 * Letters thread list (#100, spec #58), headless.
 *
 * Wraps GET /api/threads and POST /api/threads/:threadKey/read. It renders
 * nothing, so the social dock and any later Letters panel can draw it however
 * they like. The list never carries message text.
 *
 * Live (#102): it fetches once, then follows the live channel's person-level
 * frames (LiveClient.subscribePerson). `thread.updated` moves a thread's last
 * activity and unread count (and re-sorts); `thread.read` applies a read made
 * on any of the person's devices. A thread it doesn't know yet (a first DM)
 * triggers a refetch, and so does every reconnect, since the server replays
 * nothing. No polling.
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

const activityOf = (t: ThreadSummary) => (t.lastActivityAt ? Date.parse(t.lastActivityAt) : -Infinity);

/** Newest activity first, then by title: the server's order, so a live re-sort matches a refetch. */
const byActivity = (a: ThreadSummary, b: ThreadSummary) =>
  activityOf(b) - activityOf(a) || a.title.localeCompare(b.title);

/** Coalesces the refetches a burst of unknown-thread frames would trigger. */
const MISSING_REFETCH_MS = 300;

/**
 * The person's threads, newest activity first, kept current by the live channel.
 *
 * `threads` is narrowed by `filter`; `totalUnread` always counts every thread,
 * so a badge stays right whichever tab is showing. `markRead` clears a thread's
 * count at once and records the read position on the server (whose
 * `thread.read` then clears it on the person's other devices). `refresh`
 * refetches the whole list.
 */
export function useThreads({ filter = 'all', enabled = true }:
  { filter?: ThreadFilter; enabled?: boolean } = {}) {
  const [all, setAll] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** threadKey → the last message id we marked read, so re-renders don't re-post. */
  const marked = useRef<Map<string, string>>(new Map());
  /** threadKey → when we last marked it read, so a fetch that started earlier can't bring the old count back. */
  const markedAt = useRef<Map<string, number>>(new Map());
  /** threadKey → the newest read position (ms) a `thread.read` reported, from any device. */
  const readAt = useRef<Map<string, number>>(new Map());
  /** The list as last rendered, for deciding outside a state updater whether a frame's thread is known. */
  const allRef = useRef<ThreadSummary[]>([]);
  allRef.current = all;
  /**
   * Threads a refetch didn't return although a frame named them (a completed
   * campaign is still subscribed, but isn't listed). Frames for them are
   * ignored until the next full refresh, so they don't refetch on every message.
   */
  const unlisted = useRef<Set<string>>(new Set());
  const missingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const missing = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    const t = token();
    if (!t) return;
    const started = Date.now();
    const lookingFor = new Set(missing.current);
    missing.current.clear();
    setLoading(true);
    try {
      const res = await fetch('/api/threads', { headers: { Authorization: `Bearer ${t}` } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not load conversations');
      const data = await res.json();
      const fresh: ThreadSummary[] = Array.isArray(data?.threads) ? data.threads : [];
      const listed = new Set(fresh.map(th => th.threadKey));
      unlisted.current = new Set([...lookingFor].filter(key => !listed.has(key)));
      setAll(fresh.map(th => ((markedAt.current.get(th.threadKey) ?? 0) >= started ? { ...th, unreadCount: 0 } : th)));
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Could not load conversations');
    } finally {
      setLoading(false);
    }
  }, []);

  /** A frame named a thread the list doesn't have yet (a first DM): fetch it, once per burst. */
  const fetchMissing = useCallback((threadKey: string) => {
    if (unlisted.current.has(threadKey)) return;
    missing.current.add(threadKey);
    if (missingTimer.current) return;
    missingTimer.current = setTimeout(() => { missingTimer.current = null; refresh(); }, MISSING_REFETCH_MS);
  }, [refresh]);

  // A new message: the thread's last activity moves (it can only move later)
  // and the person's unread count is the server's. A thread already read past
  // that message on some device stays at 0, whichever frame arrived first.
  const applyUpdate = useCallback((u: ThreadUpdate) => {
    if (!allRef.current.some(th => th.threadKey === u.thread)) return fetchMissing(u.thread);
    const at = Date.parse(u.lastActivityAt);
    setAll(prev => prev.map(th => {
      if (th.threadKey !== u.thread) return th;
      const later = !(activityOf(th) >= at);
      const readPast = (readAt.current.get(u.thread) ?? -Infinity) >= at;
      return {
        ...th,
        lastActivityAt: later ? u.lastActivityAt : th.lastActivityAt,
        unreadCount: readPast ? 0 : u.unreadCount,
      };
    }).sort(byActivity));
  }, [fetchMissing]);

  // A read on any of the person's devices, this one included.
  const applyRead = useCallback((r: ThreadRead) => {
    const at = Date.parse(r.lastReadAt);
    if (!((readAt.current.get(r.thread) ?? -Infinity) >= at)) readAt.current.set(r.thread, at);
    setAll(prev => prev.map(th => (th.threadKey === r.thread ? { ...th, unreadCount: r.unreadCount } : th)));
  }, []);

  useEffect(() => {
    if (!enabled || !token()) return;
    refresh();
    // Nothing is replayed after a reconnect, so refetch then.
    const unsubscribe = getLiveClient().subscribePerson({
      onThreadUpdated: applyUpdate,
      onThreadRead: applyRead,
      onReconnect: () => { unlisted.current.clear(); refresh(); },
    });
    return () => {
      unsubscribe();
      if (missingTimer.current) clearTimeout(missingTimer.current);
      missingTimer.current = null;
    };
  }, [enabled, refresh, applyUpdate, applyRead]);

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
