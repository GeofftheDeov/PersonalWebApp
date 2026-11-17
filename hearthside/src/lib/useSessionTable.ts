"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { api, errorOf, getOrNull } from './api';
import type { Quest } from './quests';
import type { Attendance, CampaignCharacter, QuestViewer, ReadyCheck } from './sessionTable';
import { completeQuest, questStore, refreshQuests } from './useQuests';

/** GET /api/quests/sessions/:id: the session's quests (not cancelled), and whether the viewer is its GM. */
interface SessionQuests {
  viewer: QuestViewer;
  quests: Quest[];
}

export interface SessionTableData {
  /** Null until they come, or if they couldn't be fetched. */
  quests: Quest[] | null;
  viewer: QuestViewer | null;
  attendance: Attendance | null;
  characters: CampaignCharacter[] | null;
}

const enc = encodeURIComponent;

/**
 * What a session's round table needs beyond the page's own read (#227): its
 * quests, its attendance and the party's adventurers, plus what the table
 * does with them. Each read is left out if it fails; the table shows what
 * it has.
 *
 * Ticking goes through the rail's store (`completeQuest`) when the quest is
 * one of yours there, so Your Quests shows it done at once; a quest the rail
 * doesn't hold (someone else's, for the GM, or one from a session that's
 * over) is ticked directly. A quest ticked in the rail shows done here too.
 */
export function useSessionTable(sessionId: string, campaignId: string | null) {
  const [data, setData] = useState<SessionTableData>({ quests: null, viewer: null, attendance: null, characters: null });
  const [ticking, setTicking] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const rail = useSyncExternalStore(questStore.subscribe, questStore.getState, questStore.getState);

  const load = useCallback(async () => {
    const [q, attendance, characters] = await Promise.all([
      getOrNull<SessionQuests>(`/api/quests/sessions/${enc(sessionId)}`),
      getOrNull<Attendance>(`/api/tabletop/sessions/${enc(sessionId)}/attendance`),
      campaignId ? getOrNull<CampaignCharacter[]>(`/api/tabletop/characters?campaign=${enc(campaignId)}`) : null,
    ]);
    setData({ quests: q?.quests ?? null, viewer: q?.viewer ?? null, attendance, characters: Array.isArray(characters) ? characters : null });
  }, [sessionId, campaignId]);

  useEffect(() => { load(); }, [load]);

  const setQuest = (id: string, change: (q: Quest) => Quest) =>
    setData((d) => ({ ...d, quests: d.quests?.map((q) => (q.id === id ? change(q) : q)) ?? null }));

  /** Ticks a quest off: done at once, undone again (with the reason shown) if the server refuses. */
  const tick = useCallback(async (q: Quest) => {
    if (ticking.has(q.id)) return;
    setError(null);
    setTicking((t) => new Set([...t, q.id]));
    setQuest(q.id, (x) => ({ ...x, status: 'done' }));
    try {
      if (questStore.getState().quests.some((x) => x.id === q.id)) {
        await completeQuest(q.id);
        const after = questStore.getState();
        if (after.quests.find((x) => x.id === q.id)?.status !== 'done') throw new Error(after.error ?? "Couldn't mark it done");
      } else {
        const done = await api.post<Quest>(`/api/quests/${enc(q.id)}/done`);
        if (done?.id) setQuest(q.id, () => done);
      }
    } catch (err) {
      setQuest(q.id, (x) => ({ ...x, status: q.status }));
      setError(errorOf(err, "Couldn't mark it done"));
    } finally {
      setTicking((t) => new Set([...t].filter((id) => id !== q.id)));
    }
  }, [ticking]);

  /** The GM's "+ quest" on a seat: a quest for that player, due when the session starts. Throws if refused. */
  const addQuest = useCallback(async (assigneeId: string, title: string) => {
    const made = await api.post<Quest>(`/api/quests/sessions/${enc(sessionId)}`, { title, assigneeId });
    if (made?.id) setData((d) => ({ ...d, quests: [...(d.quests ?? []), made] }));
    refreshQuests();
  }, [sessionId]);

  /** The GM confirms exactly who came. Throws if refused. */
  const confirmAttendance = useCallback(async (playerIds: string[]) => {
    const saved = await api.put<Attendance>(`/api/tabletop/sessions/${enc(sessionId)}/attendance`, { playerIds });
    if (saved) setData((d) => ({ ...d, attendance: saved }));
  }, [sessionId]);

  /** Answers the ready check (POST /api/tabletop/sessions/:id/ready); returns the check as it now stands. */
  const answerReady = useCallback(async (ready: boolean) => {
    const res = await api.post<{ readyCheck: ReadyCheck }>(`/api/tabletop/sessions/${enc(sessionId)}/ready`, { ready });
    return res?.readyCheck ?? null;
  }, [sessionId]);

  // A quest of yours ticked in the rail shows done here too.
  const quests = useMemo(() => data.quests?.map((q) => {
    const there = rail.quests.find((x) => x.id === q.id);
    return there?.status === 'done' && q.status === 'open' ? { ...q, status: 'done' as const } : q;
  }) ?? null, [data.quests, rail.quests]);

  return { ...data, quests, ticking, error, tick, addQuest, confirmAttendance, answerReady, reload: load };
}
