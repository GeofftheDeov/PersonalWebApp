"use client";

import { useEffect, useSyncExternalStore } from 'react';
import { api } from './api';
import { getLiveClient } from './letters';
import { createQuestStore, type QuestRailState } from './quests';
import { session, useSession } from './session';

/**
 * Your quests, one store per tab (#221): the rail's Your Quests reads it, and
 * any page that ticks a quest (a session's slips, the Almanac) should tick it
 * through `completeQuest`, so the rail shows it done at once. A page that
 * changes quests some other way calls `refreshQuests()` afterwards.
 */
export const questStore = createQuestStore({ api });

/** Ticks one of your quests off (POST /api/quests/:id/done). */
export const completeQuest = (questId: string) => questStore.complete(questId);

/** How long to wait for more `noticeboard.changed` frames before reading again: one action can send several. */
const LIVE_REFETCH_MS = 250;

/** Fetches your quests again, e.g. after a page added or changed one. */
export const refreshQuests = () => questStore.load();

/**
 * Your quests for the rail: loaded when you're signed in (again when the tab
 * comes back into view), emptied when you sign out. Live: a quest assigned,
 * claimed, edited or done in any of your campaigns sends that campaign's
 * `noticeboard.changed`, and the list is read again; after a reconnect too,
 * since nothing is replayed.
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => questStore.load(), LIVE_REFETCH_MS);
    };
    const off = getLiveClient().subscribePerson({ onNoticeBoard: soon, onReconnect: soon });
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      off();
      clearTimeout(timer);
    };
  }, [signedIn, userId]);

  return useSyncExternalStore(questStore.subscribe, questStore.getState, questStore.getState);
}
