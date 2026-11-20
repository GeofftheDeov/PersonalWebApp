"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api, errorOf, getOrNull } from './api';
import {
  covered, firstRange, firstReach, mergeOlder, mergeRange, nextReach, olderPath, setQuest, withRail,
  type AlmanacReply, type AlmanacSession, type OlderPage, type Range, type Reach,
} from './almanac';
import type { CampaignSummary } from './campaigns';
import { railChanges, type Quest } from './quests';
import { questStore, refreshQuests, setQuestDone } from './useQuests';

const enc = encodeURIComponent;

/** How far back Played has read (#252). */
export interface OlderState {
  /** Every session from here on has been read; null once there are no older ones. */
  reach: Reach | null;
  /** Whether older sessions are left, as the last page back said; null until one has answered. */
  more: boolean | null;
  loading: boolean;
  /** Why the last page back failed; reading stops until `loadOlder` is asked again. */
  error: string | null;
}

export interface AlmanacData {
  /** Null until the first read answers. */
  sessions: AlmanacSession[] | null;
  /** My campaigns by id, for their banners; empty if they couldn't be read. */
  campaigns: ReadonlyMap<string, CampaignSummary>;
  /** Why the first read failed, fit to show. */
  error: string | null;
  /** Why the last tick failed. */
  tickError: string | null;
  ticking: ReadonlySet<string>;
  /** Reads a span the calendar is showing, unless it's been read already. */
  ensure: (r: Range) => void;
  tick: (q: Quest) => void;
  older: OlderState;
  /** Reads the next page back, unless one is on its way or there are no more. */
  loadOlder: () => void;
}

/**
 * The Almanac's data (#228): my dated sessions with my quests on them, read
 * half a year back and seven months ahead at first, and any span the
 * calendar moves to after that; plus my campaigns' banners. Played pages
 * further back (#252): once the first read is in, one page back
 * (`OLDER_PAGE` sessions) so Played's count is usually whole, then more as
 * its pages need them, until the API says there are no more.
 *
 * Ticking (and unticking) goes through the rail's store (`setQuestDone`)
 * when Your Quests holds the quest, so it follows there at once; one it
 * doesn't hold (a played session's) is ticked directly. A quest ticked in
 * the rail shows ticked here too.
 */
export function useAlmanac(enabled: boolean, now: Date): AlmanacData {
  const [sessions, setSessions] = useState<AlmanacSession[] | null>(null);
  const [campaigns, setCampaigns] = useState<ReadonlyMap<string, CampaignSummary>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [tickError, setTickError] = useState<string | null>(null);
  const [ticking, setTicking] = useState<ReadonlySet<string>>(new Set());
  const read = useRef<Range[]>([]);
  // Fixed when the page opened, as the page's `now` is.
  const first = useRef(firstRange(now));
  const reach = useRef<Reach | null>(firstReach(first.current));
  const olderBusy = useRef(false);
  const [older, setOlder] = useState<OlderState>({ reach: reach.current, more: null, loading: false, error: null });
  const rail = useSyncExternalStore(questStore.subscribe, questStore.getState, questStore.getState);

  const fetchRange = useCallback(async (r: Range) => {
    const reply = await api.get<AlmanacReply>(`/api/quests/almanac?start=${enc(r.start.toISOString())}&end=${enc(r.end.toISOString())}`);
    read.current = [...read.current, r];
    setSessions((known) => mergeRange(known ?? [], r, reply?.sessions ?? []));
  }, []);

  const loadOlder = useCallback(async () => {
    const from = reach.current;
    if (!enabled || olderBusy.current || !from) return;
    olderBusy.current = true;
    setOlder((o) => ({ ...o, loading: true, error: null }));
    try {
      const page = await api.get<OlderPage>(olderPath(from));
      const fresh = page?.sessions ?? [];
      reach.current = nextReach(from, { sessions: fresh, more: !!page?.more });
      setSessions((known) => mergeOlder(known ?? [], fresh));
      setOlder({ reach: reach.current, more: !!page?.more, loading: false, error: null });
    } catch (err) {
      setOlder((o) => ({ ...o, loading: false, error: errorOf(err, 'Older sessions couldn’t be read.') }));
    } finally {
      olderBusy.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    read.current = [];
    // The first page back waits for the first read, so the page doesn't show before that's in.
    fetchRange(first.current).then(() => { if (live) loadOlder(); },
      (err) => { if (live) setError(errorOf(err, 'The Almanac couldn’t be read. Try again in a moment.')); });
    getOrNull<CampaignSummary[]>('/api/campaigns').then((list) => {
      if (live && Array.isArray(list)) setCampaigns(new Map(list.map((c) => [String(c._id), c])));
    });
    return () => { live = false; };
  }, [enabled, fetchRange, loadOlder]);

  const ensure = useCallback((r: Range) => {
    if (!enabled || covered(read.current, r)) return;
    fetchRange(r).catch(() => { /* the calendar shows what it has */ });
  }, [enabled, fetchRange]);

  const tick = useCallback(async (q: Quest) => {
    if (ticking.has(q.id) || q.status === 'cancelled') return;
    const done = q.status === 'open';
    const status = done ? 'done' as const : 'open' as const;
    const failed = done ? 'Couldn’t mark it done' : 'Couldn’t undo it';
    setTickError(null);
    setTicking((t) => new Set([...t, q.id]));
    setSessions((list) => list && setQuest(list, q.id, (x) => ({ ...x, status })));
    try {
      if (questStore.getState().quests.some((x) => x.id === q.id)) {
        await setQuestDone(q.id, done);
        const after = questStore.getState();
        if (after.quests.find((x) => x.id === q.id)?.status !== status) throw new Error(after.error ?? failed);
      } else {
        const path = `/api/quests/${enc(q.id)}/done`;
        const saved = done ? await api.post<Quest>(path) : await api.delete<Quest>(path);
        if (saved?.id) setSessions((list) => list && setQuest(list, q.id, (x) => ({ ...x, status: saved.status, completedAt: saved.completedAt })));
        refreshQuests();
      }
    } catch (err) {
      setSessions((list) => list && setQuest(list, q.id, (x) => ({ ...x, status: q.status })));
      setTickError(errorOf(err, failed));
    } finally {
      setTicking((t) => new Set([...t].filter((id) => id !== q.id)));
    }
  }, [ticking]);

  const shown = useMemo(() => sessions && withRail(sessions, railChanges(rail)), [sessions, rail]);

  return { sessions: shown, campaigns, error, tickError, ticking, ensure, tick, older, loadOlder };
}
