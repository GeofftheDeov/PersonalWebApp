import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveSource } from "./connection";
import type { LiveMessage, LivePresence, LiveStatus, ThreadStatus } from "./liveClient";
import { TypingTracker, typingLabel, type Typist } from "./typing";

/**
 * The realtime hooks (#98, #103, #37): React on the tab's one live-channel
 * socket. Headless: no markup. Each takes the app's live source (its
 * `createLiveConnection`, or its Letters, which carries one) first:
 *
 *   const status = useLiveThread(letters, campaignThreadKey(id), {
 *       onMessage: (m) => append(m),
 *       onReconnect: () => refetchLatestPage(),   // nothing is replayed
 *   });
 *
 * The socket opens with the first subscriber and closes a few seconds after
 * the last one unmounts.
 */

/** The live channel's connection status, for a LIVE / OFFLINE badge. */
export function useLiveStatus(live: LiveSource): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>("idle");
  useEffect(() => {
    const client = live.liveClient();
    setStatus(client.status);
    return client.onStatus(setStatus);
  }, [live]);
  return status;
}

export interface LiveThreadHandlers {
  onMessage?: (message: LiveMessage) => void;
  onReconnect?: () => void;
}

/**
 * Subscribe to one thread's live events while mounted. Handlers may change on
 * every render; the subscription only follows `thread`. Pass null to pause.
 * Returns this thread's status: `open` only while its events are flowing,
 * `unavailable` when the socket is open but the server didn't subscribe it to
 * this thread (see LiveClient.threadStatus).
 */
export function useLiveThread(live: LiveSource, thread: string | null, handlers: LiveThreadHandlers): ThreadStatus {
  const latest = useRef(handlers);
  latest.current = handlers;
  const status = useLiveStatus(live);
  // The server's thread set changes on each `ready`, including one re-sent
  // on the open socket when access changes (#105), which doesn't change
  // `status`: re-render on it so the thread's own status is read fresh.
  const [, setThreadsSeen] = useState(0);
  useEffect(() => live.liveClient().onThreads(() => setThreadsSeen((n) => n + 1)), [live]);

  useEffect(() => {
    if (!thread) return;
    return live.liveClient().subscribe(thread, {
      onMessage: (m) => latest.current.onMessage?.(m),
      onReconnect: () => latest.current.onReconnect?.(),
    });
  }, [live, thread]);

  return thread && status === "open" ? live.liveClient().threadStatus(thread) : status;
}

/**
 * Who has a campaign's Table Talk open right now (#37, plan §4.2), you
 * included. Mounting it says you're here; unmounting says you've gone. Pass
 * null to stay out (and see nobody).
 *
 *   const people = usePresence(letters, threadKey);
 */
export function usePresence(live: LiveSource, thread: string | null): LivePresence[] {
  const [people, setPeople] = useState<LivePresence[]>([]);

  useEffect(() => {
    if (!thread) return;
    const client = live.liveClient();
    // Subscribing keeps the socket open and receives the list; holding
    // presence is what puts you on it.
    const off = client.subscribe(thread, { onPresence: (list) => setPeople(list) });
    const release = client.holdPresence(thread);
    // A dropped socket's list is stale; the next `ready` brings a fresh one.
    const offStatus = client.onStatus((status) => { if (status !== "open") setPeople([]); });
    return () => {
      release();
      off();
      offStatus();
      setPeople([]);
    };
  }, [live, thread]);

  return people;
}

/**
 * Typing indicators for one thread (#103): a React wrapper around
 * TypingTracker (typing.ts). Headless.
 *
 *   const { label, typing, sent } = useTyping(letters, threadKey);
 *   <input onChange={e => { setDraft(e.target.value); if (e.target.value.trim()) typing(); }} />
 *   // after a successful send: sent();
 *   <p aria-live="polite">{label}</p>   // "Theo is writing…"
 *
 * `typing()` is safe to call on every keystroke: it sends at most one frame
 * every 3 s. Each typist disappears 5 s after their last frame, or when their
 * message arrives. Pass null to pause. `typing` and `sent` never change identity.
 */
export function useTyping(live: LiveSource, thread: string | null): {
  typists: Typist[];
  label: string;
  typing: () => void;
  sent: () => void;
} {
  const tracker = useRef<TypingTracker | null>(null);
  const [typists, setTypists] = useState<Typist[]>([]);

  useEffect(() => {
    if (!thread) return;
    const current = new TypingTracker({ client: live.liveClient(), thread });
    tracker.current = current;
    const off = current.onChange(setTypists);
    return () => {
      off();
      current.dispose();
      if (tracker.current === current) tracker.current = null;
      setTypists([]);
    };
  }, [live, thread]);

  const typing = useCallback(() => tracker.current?.typing(), []);
  const sent = useCallback(() => tracker.current?.sent(), []);
  return { typists, label: typingLabel(typists), typing, sent };
}
