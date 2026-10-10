import { useCallback, useEffect, useRef, useState } from 'react';
import { getLiveClient } from './useLiveThread';
import { TypingTracker, typingLabel, type Typist } from './typing';

export type { Typist } from './typing';
export { TYPING_THROTTLE_MS, TYPING_EXPIRY_MS } from './typing';

/**
 * Typing indicators for one thread (#103): a React wrapper around
 * TypingTracker (typing.ts) on the tab's shared live client. Headless.
 *
 *   const { label, typing, sent } = useTyping(threadKey);
 *   <input onChange={e => { setDraft(e.target.value); if (e.target.value.trim()) typing(); }} />
 *   // after a successful send: sent();
 *   <p aria-live="polite">{label}</p>   // "Theo is writing…"
 *
 * `typing()` is safe to call on every keystroke: it sends at most one frame
 * every 3 s. Each typist disappears 5 s after their last frame, or when their
 * message arrives. Pass null to pause. `typing` and `sent` never change identity.
 */
export function useTyping(thread: string | null): {
    typists: Typist[];
    label: string;
    typing: () => void;
    sent: () => void;
} {
    const tracker = useRef<TypingTracker | null>(null);
    const [typists, setTypists] = useState<Typist[]>([]);

    useEffect(() => {
        if (!thread) return;
        const current = new TypingTracker({ client: getLiveClient(), thread });
        tracker.current = current;
        const off = current.onChange(setTypists);
        return () => {
            off();
            current.dispose();
            if (tracker.current === current) tracker.current = null;
            setTypists([]);
        };
    }, [thread]);

    const typing = useCallback(() => tracker.current?.typing(), []);
    const sent = useCallback(() => tracker.current?.sent(), []);
    return { typists, label: typingLabel(typists), typing, sent };
}
