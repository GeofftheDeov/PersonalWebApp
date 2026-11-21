"use client";

import { forwardRef } from 'react';
import { threadWhen } from '@gtd/shared/letters';
import type { ThreadFilter, ThreadSummary } from '@/lib/letters';

export const THREAD_FILTERS: { value: ThreadFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'campaigns', label: 'Campaigns' },
    { value: 'friends', label: 'Friends' },
];

const EMPTY: Record<ThreadFilter, string> = {
    all: 'No chats yet. Your active campaigns and your friends show up here.',
    campaigns: 'No active campaigns.',
    friends: 'No friends to write to yet.',
};

/**
 * The dashboard's chats (#233), under the Profile card: campaign threads for
 * active campaigns and friend DMs, with All, Campaigns and Friends filters.
 * A row shows only the name, its subtitle, the last activity and an unread
 * mark, never message text; the open one is highlighted. Draws what
 * useThreads (the shared Letters hook) gives it, nothing more.
 */
const ThreadList = forwardRef<HTMLUListElement, {
    threads: ThreadSummary[];
    filter: ThreadFilter;
    onFilter: (filter: ThreadFilter) => void;
    selectedKey: string | null;
    onSelect: (thread: ThreadSummary) => void;
    /** The first fetch has finished, so an empty list really is empty. */
    settled: boolean;
    error: string | null;
}>(function ThreadList({ threads, filter, onFilter, selectedKey, onSelect, settled, error }, listRef) {
    return (
        <div className="border-4 border-black dark:border-white bg-zinc-200 dark:bg-slate-800 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]">
            <div className="flex gap-2 p-3 border-b-4 border-black dark:border-white" role="tablist" aria-label="Show chats from">
                {THREAD_FILTERS.map(f => (
                    <button
                        key={f.value}
                        type="button"
                        role="tab"
                        aria-selected={filter === f.value}
                        aria-controls="dash-threads"
                        onClick={() => onFilter(f.value)}
                        className={`flex-1 min-w-0 px-1 sm:px-2 py-1.5 border-4 border-black font-permanent uppercase text-xs sm:text-sm truncate transition-colors ${filter === f.value
                            ? 'bg-black text-white dark:bg-white dark:text-black'
                            : 'bg-white dark:bg-zinc-800 text-black dark:text-white hover:bg-yellow-100 dark:hover:bg-zinc-700 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]'}`}
                    >
                        {f.label}
                    </button>
                ))}
            </div>

            <ul ref={listRef} id="dash-threads" aria-label="Chats" className="max-h-[28rem] overflow-y-auto">
                {threads.map(t => {
                    const selected = t.threadKey === selectedKey;
                    const when = threadWhen(t.lastActivityAt);
                    return (
                        <li key={t.threadKey} className="border-b-2 border-black/20 dark:border-white/20 last:border-b-0">
                            <button
                                type="button"
                                data-thread={t.threadKey}
                                aria-current={selected ? 'true' : undefined}
                                onClick={() => onSelect(t)}
                                className={`w-full flex items-center gap-3 p-3 text-left transition-colors ${selected
                                    ? 'bg-yellow-400 text-black'
                                    : 'bg-white dark:bg-slate-900 hover:bg-yellow-100 dark:hover:bg-slate-700'}`}
                            >
                                <span aria-hidden="true" className={`w-10 h-10 shrink-0 flex items-center justify-center border-2 border-black font-permanent text-sm uppercase ${t.kind === 'campaign' ? 'bg-teal-600 text-white' : 'bg-yellow-400 text-black'}`}>
                                    {t.avatarHint}
                                </span>
                                <span className="flex-1 min-w-0">
                                    <span className={`block font-permanent uppercase truncate ${selected ? 'text-black' : 'text-teal-600 dark:text-yellow-400'}`}>
                                        {t.title}
                                    </span>
                                    <span className={`block text-xs font-medium tracking-wider uppercase truncate ${selected ? 'text-zinc-800' : 'text-zinc-500 dark:text-zinc-400'}`}>
                                        {t.subtitle}
                                    </span>
                                </span>
                                <span className="shrink-0 flex flex-col items-end gap-1">
                                    {when && <span className={`text-xs font-permanent uppercase ${selected ? 'text-zinc-800' : 'text-zinc-500 dark:text-zinc-400'}`}>{when}</span>}
                                    {t.unreadCount > 0 && (
                                        <span className="min-w-[1.5rem] h-6 px-1 flex items-center justify-center border-2 border-black bg-orange-500 text-white font-permanent text-xs">
                                            <span aria-hidden="true">{t.unreadCount > 99 ? '99+' : t.unreadCount}</span>
                                            <span className="sr-only">, {t.unreadCount} unread</span>
                                        </span>
                                    )}
                                </span>
                            </button>
                        </li>
                    );
                })}
            </ul>

            {threads.length === 0 && !error && (
                <p className="p-4 font-permanent text-sm uppercase text-zinc-500 dark:text-zinc-400">
                    {settled ? EMPTY[filter] : 'Loading chats…'}
                </p>
            )}
            {error && <p role="alert" className="p-4 font-permanent text-sm uppercase text-red-600 dark:text-red-400">{error}</p>}
        </div>
    );
});

export default ThreadList;
