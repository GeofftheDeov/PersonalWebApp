import { useEffect, useRef, useState } from 'react';
import { LiveClient, type LiveMessage, type LiveStatus, type ThreadStatus } from './liveClient';
import { session } from '../session';

export type { LiveMessage, LiveStatus, ThreadStatus } from './liveClient';
export { campaignThreadKey, dmThreadKey } from './threadKeys';

/**
 * The realtime hook (#98): one live-channel socket per browser tab, shared by
 * every component that subscribes to a thread. Headless: no markup, no page
 * imports. It lives here until #69's shared package takes it.
 *
 *   const status = useLiveThread(campaignThreadKey(id), {
 *       onMessage: (m) => append(m),
 *       onReconnect: () => refetchLatestPage(),   // nothing is replayed
 *   });
 *
 * The socket opens with the first subscriber and closes a few seconds after
 * the last one unmounts. The session cookie authenticates it (#107, #210).
 */

let shared: LiveClient | null = null;

/** The tab's one client. Same-origin: `/api/live` goes through the frontend's /api rewrite. */
export function getLiveClient(): LiveClient {
    if (!shared) {
        shared = new LiveClient({
            url: () => `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/api/live`,
            // The browser has no token (#210): the session cookie authenticates
            // the upgrade (#107), so no auth frame is sent.
            getToken: () => null,
            cookieAuth: true,
        });
        // A socket refused for an expired session (4001) stays closed; once
        // the person signs in again, connect with the new cookie. Signing out
        // closes it: the server would otherwise keep it open as them.
        // Signing in as someone else without logging out first reconnects
        // too, so the socket never carries the previous person's threads.
        const client = shared;
        let connectedAs: string | null = null;
        session.subscribe(() => {
            const { status, user } = session.getState();
            if (status === 'signedIn') {
                if (connectedAs !== null && connectedAs !== user.id) client.close();
                connectedAs = user.id;
                client.resume();
            } else if (status === 'signedOut') {
                connectedAs = null;
                client.close();
            }
        });
    }
    return shared;
}

/** The live channel's connection status, for a LIVE / OFFLINE badge. */
export function useLiveStatus(): LiveStatus {
    const [status, setStatus] = useState<LiveStatus>('idle');
    useEffect(() => {
        const client = getLiveClient();
        setStatus(client.status);
        return client.onStatus(setStatus);
    }, []);
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
export function useLiveThread(thread: string | null, handlers: LiveThreadHandlers): ThreadStatus {
    const latest = useRef(handlers);
    latest.current = handlers;
    const status = useLiveStatus();
    // The server's thread set changes on each `ready`, including one re-sent
    // on the open socket when access changes (#105), which doesn't change
    // `status`: re-render on it so the thread's own status is read fresh.
    const [, setThreadsSeen] = useState(0);
    useEffect(() => getLiveClient().onThreads(() => setThreadsSeen(n => n + 1)), []);

    useEffect(() => {
        if (!thread) return;
        return getLiveClient().subscribe(thread, {
            onMessage: (m) => latest.current.onMessage?.(m),
            onReconnect: () => latest.current.onReconnect?.(),
        });
    }, [thread]);

    return thread && status === 'open' ? getLiveClient().threadStatus(thread) : status;
}
