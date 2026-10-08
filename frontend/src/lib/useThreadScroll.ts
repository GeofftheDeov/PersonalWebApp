"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Scrolling for a message log (#101), headless: pair it with useThread.
 *
 * - Opens at the bottom (the newest message).
 * - Scrolling near the top calls `onNearTop` (load older messages). When they
 *   arrive above, the view keeps its place instead of jumping to them.
 * - A new message at the bottom scrolls into view if you were already at the
 *   bottom, or if it's one you sent; otherwise your place is kept.
 * - If the first page doesn't fill the box, older pages load until it does.
 *
 *   const onScroll = useThreadScroll(ref, t.messages, { onNearTop: t.loadOlder, canLoadMore: t.hasMore, myId });
 *   <div ref={ref} onScroll={onScroll} className="overflow-y-auto">…</div>
 */
export function useThreadScroll(
    ref: RefObject<HTMLElement | null>,
    entries: readonly { key: string; state?: string }[],
    { onNearTop, canLoadMore, thresholdPx = 64 }: { onNearTop: () => void; canLoadMore: boolean; thresholdPx?: number },
) {
    const last = useRef<{ first: string | null; last: string | null; height: number; top: number; atBottom: boolean }>(
        { first: null, last: null, height: 0, top: 0, atBottom: true });
    const nearTop = useRef(onNearTop);
    nearTop.current = onNearTop;

    // The browser's own scroll anchoring would shift the view a second time.
    useEffect(() => {
        if (ref.current) ref.current.style.overflowAnchor = 'none';
    }, [ref]);

    const remember = useCallback((el: HTMLElement) => {
        last.current.height = el.scrollHeight;
        last.current.top = el.scrollTop;
        last.current.atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < thresholdPx;
    }, [thresholdPx]);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const first = entries[0]?.key ?? null;
        const newest = entries[entries.length - 1] ?? null;
        const prev = last.current;

        if (!prev.first || !first) {
            el.scrollTop = el.scrollHeight; // opened (or emptied): start at the newest
        } else if (first !== prev.first && newest?.key === prev.last) {
            el.scrollTop = prev.top + (el.scrollHeight - prev.height); // older loaded above: stay put
        } else if (newest && newest.key !== prev.last && (prev.atBottom || newest.state === 'sending')) {
            el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        }
        last.current.first = first;
        last.current.last = newest?.key ?? null;
        remember(el);
        // The box isn't full yet, so there's no scrolling to ask for more.
        if (canLoadMore && el.scrollHeight <= el.clientHeight) nearTop.current();
    }, [entries, ref, canLoadMore, remember]);

    return useCallback(() => {
        const el = ref.current;
        if (!el) return;
        remember(el);
        if (el.scrollTop < thresholdPx && canLoadMore) nearTop.current();
    }, [ref, remember, canLoadMore, thresholdPx]);
}
