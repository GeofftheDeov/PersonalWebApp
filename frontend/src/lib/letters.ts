"use client";

import { createLetters } from '@gtd/shared/letters';
import { useThread as useSharedThread, type UseThreadOptions } from '@gtd/shared/letters/react';
import { usePresence as useSharedPresence, useTyping as useSharedTyping } from '@gtd/shared/realtime/react';
import { api } from './api';
import { session } from './session';

export { campaignThreadKey } from '@gtd/shared/realtime';
export { useAttachmentDraft, useThreadScroll } from '@gtd/shared/letters/react';

/**
 * The portfolio's Letters (#211): the shared Letters hooks, the live channel
 * and the top bar run on this, beside the session and API clients. One per
 * tab; see @gtd/shared/letters.
 */
export const letters = createLetters({ api, session });

/** The tab's one live-channel client (the Notice Board listens on it). */
export const getLiveClient = () => letters.liveClient();

/** One open thread: history, live updates, send and mark read. */
export const useThread = (threadKey: string | null, options?: UseThreadOptions) =>
    useSharedThread(letters, threadKey, options);

/** "Theo is writing…" for one thread. */
export const useTyping = (threadKey: string | null) => useSharedTyping(letters, threadKey);

/** Who has a campaign's Table Talk open. */
export const usePresence = (threadKey: string | null) => useSharedPresence(letters, threadKey);
