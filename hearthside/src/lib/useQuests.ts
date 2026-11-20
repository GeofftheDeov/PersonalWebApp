"use client";

import { useEffect, useSyncExternalStore } from 'react';
import { api } from './api';
import { createQuestStore, type QuestRailState } from './quests';
import { session, useSession } from './session';

/**
 * Your quests, one store per tab (#221): the rail's Your Quests reads it, and
 * any page that ticks a quest (a session's slips, the Almanac) should tick it
 * through `setQuestDone`, so the rail shows it at once. A page that changes
 * quests some other way calls `refreshQuests()` afterwards.
 */
export const questStore = createQuestStore({ api });

/** Ticks one of your quests off, or back on (POST or DELETE /api/quests/:id/done). */
export const setQuestDone = (questId: string, done: boolean) => questStore.setDone(questId, done);

/** Fetches your quests again, e.g. after a page added or changed one. */
export const refreshQuests = () => questStore.load();

/**
 * Your quests for the rail: loaded when you're signed in (again when the tab
 * comes back into view), emptied when you sign out.
 */
export function useYourQuests(): QuestRailState {
  const { status, user } = useSession();
  const signedIn = status === 'signedIn';
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!signedIn) {
      if (session.getState().status === 'signedOut') questStore.reset();
      return;
    }
    questStore.reset();
    questStore.load();
    const onVisible = () => { if (document.visibilityState === 'visible') questStore.load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [signedIn, userId]);

  return useSyncExternalStore(questStore.subscribe, questStore.getState, questStore.getState);
}
