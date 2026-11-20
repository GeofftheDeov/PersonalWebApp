"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api, errorOf, getOrNull } from './api';
import {
  covered, firstRange, mergeRange, setQuest, withRail,
  type AlmanacReply, type AlmanacSession, type Range,
} from './almanac';
import type { CampaignSummary } from './campaigns';
import type { Quest } from './quests';
import { completeQuest, questStore, refreshQuests } from './useQuests';

const enc = encodeURIComponent;

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
}

/**
 * The Almanac's data (#228): my dated sessions with my quests on them, read
 * half a year back and seven months ahead at first, and any span the
 * calendar moves to after that; plus my campaigns' banners.
 *
 * Ticking goes through the rail's store (`completeQuest`) when Your Quests
 * holds the quest, so it shows done there at once; one it doesn't hold (a
 * played session's) is ticked directly. A quest ticked in the rail shows
 * done here too.
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
  const rail = useSyncExternalStore(questStore.subscribe, questStore.getState, questStore.getState);

  const fetchRange = useCallback(async (r: Range) => {
    const reply = await api.get<AlmanacReply>(`/api/quests/almanac?start=${enc(r.start.toISOString())}&end=${enc(r.end.toISOString())}`);
    read.current = [...read.current, r];
    setSessions((known) => mergeRange(known ?? [], r, reply?.sessions ?? []));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    read.current = [];
    fetchRange(first.current).catch((err) => { if (live) setError(errorOf(err, 'The Almanac couldn’t be read. Try again in a moment.')); });
    getOrNull<CampaignSummary[]>('/api/campaigns').then((list) => {
      if (live && Array.isArray(list)) setCampaigns(new Map(list.map((c) => [String(c._id), c])));
    });
    return () => { live = false; };
  }, [enabled, fetchRange]);

  const ensure = useCallback((r: Range) => {
    if (!enabled || covered(read.current, r)) return;
    fetchRange(r).catch(() => { /* the calendar shows what it has */ });
  }, [enabled, fetchRange]);

  const tick = useCallback(async (q: Quest) => {
    if (ticking.has(q.id) || q.status !== 'open') return;
    setTickError(null);
    setTicking((t) => new Set([...t, q.id]));
    setSessions((list) => list && setQuest(list, q.id, (x) => ({ ...x, status: 'done' })));
    try {
      if (questStore.getState().quests.some((x) => x.id === q.id)) {
        await completeQuest(q.id);
        const after = questStore.getState();
        if (after.quests.find((x) => x.id === q.id)?.status !== 'done') throw new Error(after.error ?? 'Couldn’t mark it done');
      } else {
        const done = await api.post<Quest>(`/api/quests/${enc(q.id)}/done`);
        if (done?.id) setSessions((list) => list && setQuest(list, q.id, (x) => ({ ...x, status: done.status, completedAt: done.completedAt })));
        refreshQuests();
      }
    } catch (err) {
      setSessions((list) => list && setQuest(list, q.id, (x) => ({ ...x, status: q.status })));
      setTickError(errorOf(err, 'Couldn’t mark it done'));
    } finally {
      setTicking((t) => new Set([...t].filter((id) => id !== q.id)));
    }
  }, [ticking]);

  const shown = useMemo(() => sessions && withRail(sessions, rail.quests), [sessions, rail.quests]);

  return { sessions: shown, campaigns, error, tickError, ticking, ensure, tick };
}
