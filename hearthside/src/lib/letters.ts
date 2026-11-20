"use client";

import { createLetters } from '@gtd/shared/letters';
import {
    useThread as useSharedThread,
    useThreads as useSharedThreads,
    type UseThreadOptions,
} from '@gtd/shared/letters/react';
import {
    useHoldPresence as useSharedHoldPresence,
    usePresence as useSharedPresence,
    useTyping as useSharedTyping,
} from '@gtd/shared/realtime/react';
import type { ThreadFilter } from '@gtd/shared/letters';
import { api } from './api';
import { session } from './session';

export { campaignThreadKey } from '@gtd/shared/realtime';
export type { ThreadFilter, ThreadSummary } from '@gtd/shared/letters';
export { useAttachmentDraft, useThreadScroll } from '@gtd/shared/letters/react';

/**
 * Hearthside's Letters (#211, #216): the shared Letters hooks, the live
 * channel and the top bar run on this, beside the session and API clients.
 * The live channel is same-origin `/api/live`, through Hearthside's own
 * server (https-server.js), which proxies the WebSocket upgrade. One per tab;
 * see @gtd/shared/letters.
 */
export const letters = createLetters({ api, session });

/** The tab's one live-channel client. */
export const getLiveClient = () => letters.liveClient();

/** Your threads (campaign Table Talk and friend DMs), newest first, kept current by the live channel. */
export const useThreads = (options?: { filter?: ThreadFilter; enabled?: boolean }) =>
    useSharedThreads(letters, options);

/** One open thread: history, live updates, send and mark read. */
export const useThread = (threadKey: string | null, options?: UseThreadOptions) =>
    useSharedThread(letters, threadKey, options);

/** "Theo is writing…" for one thread. */
export const useTyping = (threadKey: string | null) => useSharedTyping(letters, threadKey);

/** Who has a campaign's thread open, in its Table Talk or in Letters. */
export const usePresence = (threadKey: string | null) => useSharedPresence(letters, threadKey);

/** Counts you among those here now in a campaign's thread while mounted (Letters, with the thread open). */
export const useHoldPresence = (threadKey: string | null) => useSharedHoldPresence(letters, threadKey);
