import { useEffect, useState } from 'react';
import { getLiveClient } from './useLiveThread';
import type { LivePresence } from './liveClient';

export type { LivePresence } from './liveClient';

/**
 * Who has a campaign's Table Talk open right now (#37, plan §4.2), you
 * included, on the tab's shared live client. Mounting it says you're here;
 * unmounting says you've gone. Pass null to stay out (and see nobody).
 *
 *   const people = usePresence(threadKey);
 */
export function usePresence(thread: string | null): LivePresence[] {
    const [people, setPeople] = useState<LivePresence[]>([]);

    useEffect(() => {
        if (!thread) return;
        const client = getLiveClient();
        // Subscribing keeps the socket open and receives the list; holding
        // presence is what puts you on it.
        const off = client.subscribe(thread, { onPresence: (list) => setPeople(list) });
        const release = client.holdPresence(thread);
        // A dropped socket's list is stale; the next `ready` brings a fresh one.
        const offStatus = client.onStatus((status) => { if (status !== 'open') setPeople([]); });
        return () => {
            release();
            off();
            offStatus();
            setPeople([]);
        };
    }, [thread]);

    return people;
}
