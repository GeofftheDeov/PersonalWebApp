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
  const unlistedThreads = useRef<Set<string>>(new Set());
  /** Threads a frame named that the list didn't have, waiting for the next refetch to bring them. */
  const awaitedThreads = useRef<Set<string>>(new Set());
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Numbers each refetch, so an older one that resolves last can't overwrite a newer one. */
  const refreshSeq = useRef(0);
  /** threadKey → when a live frame last changed it, so a refetch already in flight doesn't undo that. */
  const liveTouchedAt = useRef<Map<string, number>>(new Map());

  const refresh = useCallback(async () => {
    const t = token();
    if (!t) return;
    const started = Date.now();
    const seq = ++refreshSeq.current;
    const awaited = new Set(awaitedThreads.current);
    awaitedThreads.current.clear();
    setLoading(true);
    try {
      const res = await fetch('/api/threads', { headers: { Authorization: `Bearer ${t}` } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not load conversations');
      const data = await res.json();
      if (seq !== refreshSeq.current) return; // a later refetch is on its way; its snapshot is newer
      const fresh: ThreadSummary[] = Array.isArray(data?.threads) ? data.threads : [];
      const listed = new Set(fresh.map(th => th.threadKey));
      unlistedThreads.current = new Set([...awaited].filter(key => !listed.has(key)));
      // The snapshot may be older than what the list already shows: a thread a
      // live frame touched while the fetch was in flight keeps its live state,
      // and a read (here, or a `thread.read` from another device) that the
      // snapshot predates doesn't get its old count back.
      setAll(prev => fresh.map(th => {
        if ((liveTouchedAt.current.get(th.threadKey) ?? 0) >= started) {
          const live = prev.find(p => p.threadKey === th.threadKey);
          if (live) return live;
        }
        return (markedAt.current.get(th.threadKey) ?? 0) >= started
          || (readAt.current.get(th.threadKey) ?? -Infinity) >= activityOf(th)
          ? { ...th, unreadCount: 0 } : th;
      }).sort(byActivity));
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Could not load conversations');
    } finally {
      setLoading(false);
    }
  }, []);

  /** Refetch soon, once per burst of frames that need it. */
  const scheduleRefresh = useCallback(() => {
    if (refetchTimer.current) return;
    refetchTimer.current = setTimeout(() => { refetchTimer.current = null; refresh(); }, MISSING_REFETCH_MS);
  }, [refresh]);

  /** A frame named a thread the list doesn't have yet (a first DM): fetch it. */
  const fetchMissing = useCallback((threadKey: string) => {
    if (unlistedThreads.current.has(threadKey)) return;
    awaitedThreads.current.add(threadKey);
    scheduleRefresh();
  }, [scheduleRefresh]);

  // A new message: the thread's last activity moves (it can only move later)
  // and the person's unread count is the server's. A thread already read past
  // that message on some device stays at 0, whichever frame arrived first. An
  // update older than one already applied (frames for two quick messages can
  // cross) may raise the count but never lower it: lowering is a read's job.
  const applyUpdate = useCallback((u: ThreadUpdate) => {
    if (!allRef.current.some(th => th.threadKey === u.thread)) return fetchMissing(u.thread);
    const at = Date.parse(u.lastActivityAt);
    liveTouchedAt.current.set(u.thread, Date.now());
    setAll(prev => prev.map(th => {
      if (th.threadKey !== u.thread) return th;
      const older = activityOf(th) > at;
      const readPast = (readAt.current.get(u.thread) ?? -Infinity) >= at;
      return {
        ...th,
        lastActivityAt: older ? th.lastActivityAt : u.lastActivityAt,
        unreadCount: readPast ? 0 : older ? Math.max(th.unreadCount, u.unreadCount) : u.unreadCount,
      };
    }).sort(byActivity));
  }, [fetchMissing]);

  // A read on any of the person's devices, this one included. Its count is
  // right unless the list already shows a message newer than the read
  // position (the frames crossed): then the count can't be known here, so
  // keep the shown one and refetch.
  const applyRead = useCallback((r: ThreadRead) => {
    const at = Date.parse(r.lastReadAt);
    if ((readAt.current.get(r.thread) ?? -Infinity) > at) return; // an older read than one already applied
    readAt.current.set(r.thread, at);
    const shown = allRef.current.find(th => th.threadKey === r.thread);
    if (shown && activityOf(shown) > at) return scheduleRefresh();
    liveTouchedAt.current.set(r.thread, Date.now());
    setAll(prev => prev.map(th => (th.threadKey === r.thread ? { ...th, unreadCount: r.unreadCount } : th)));
  }, [scheduleRefresh]);

  useEffect(() => {
    if (!enabled || !token()) return;
    const client = getLiveClient();
    refresh();
    // Nothing is replayed after a reconnect, so refetch then.
    const unsubscribe = client.subscribePerson({
      onThreadUpdated: applyUpdate,
      onThreadRead: applyRead,
      onReconnect: () => { unlistedThreads.current.clear(); refresh(); },
    });
    // If this opened the socket, frames only flow from its `ready`; anything
    // between the first fetch and that is covered by fetching once more then.
    const stopWatching = client.status === 'open' ? () => {} : client.onStatus(status => {
      if (status !== 'open') return;
      stopWatching();
      refresh();
    });
    return () => {
      stopWatching();
      unsubscribe();
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      refetchTimer.current = null;
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
