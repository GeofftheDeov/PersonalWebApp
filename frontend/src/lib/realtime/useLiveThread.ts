import { useEffect, useRef, useState } from 'react';
import { LiveClient, type LiveMessage, type LiveStatus } from './liveClient';

export type { LiveMessage, LiveStatus } from './liveClient';
export { campaignThreadKey } from './threadKeys';

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
 * the last one unmounts. It reads the JWT from localStorage at each connect.
 */

let shared: LiveClient | null = null;

/** The tab's one client. Same-origin: `/api/live` goes through the frontend's /api rewrite. */
export function getLiveClient(): LiveClient {
    if (!shared) {
        shared = new LiveClient({
            url: () => `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/api/live`,
            getToken: () => {
                try { return window.localStorage.getItem('token'); } catch { return null; }
            },
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
 * Returns the connection status.
 */
export function useLiveThread(thread: string | null, handlers: LiveThreadHandlers): LiveStatus {
    const latest = useRef(handlers);
    latest.current = handlers;
    const status = useLiveStatus();

    useEffect(() => {
        if (!thread) return;
        return getLiveClient().subscribe(thread, {
            onMessage: (m) => latest.current.onMessage?.(m),
            onReconnect: () => latest.current.onReconnect?.(),
        });
    }, [thread]);

    return status;
}
