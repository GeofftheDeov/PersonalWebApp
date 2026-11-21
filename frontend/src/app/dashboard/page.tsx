"use client";

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Footer from "@/components/Footer";
import GameNightSummary from "@/components/GameNightSummary";
import ThreadList from '@/components/dashboard/ThreadList';
import ThreadLog, { NoThread } from '@/components/dashboard/ThreadLog';
import { useThreads, type ThreadFilter, type ThreadSummary } from '@/lib/letters';
import { useRequiredSession } from '@/lib/session';

/**
 * The dashboard (#233): the Profile card with your chats beneath it (campaign
 * threads and friend DMs), and the open chat's log in the right-hand column.
 * At phone width the columns stack and take turns: picking a chat shows its
 * log, and the log's back control returns to the list. Personal tasks live on
 * the profile's Almanac and their own pages (/calendar/tasks/:id).
 */
export default function DashboardPage() {
    // Signed out goes to log in and comes back here (#210).
    const { user } = useRequiredSession();
    const [filter, setFilter] = useState<ThreadFilter>('all');
    const { threads, totalUnread, loading, error, markRead } = useThreads({ filter, enabled: !!user });
    const [open, setOpen] = useState<ThreadSummary | null>(null);
    // The list starts empty and not loading, before its first fetch: don't call that "no chats".
    const [fetched, setFetched] = useState(false);
    useEffect(() => { if (loading) setFetched(true); }, [loading]);
    const listRef = useRef<HTMLUListElement>(null);
    const [returnTo, setReturnTo] = useState<string | null>(null);
    const messagesRef = useRef<HTMLElement>(null);
    const openKey = open?.threadKey ?? null;

    // Opening a chat on a phone swaps the list for the log: start at the log's heading, not wherever the list was.
    useEffect(() => {
        if (openKey && window.matchMedia('(max-width: 767px)').matches) messagesRef.current?.scrollIntoView({ block: 'start' });
    }, [openKey]);

    // Back from a chat on a phone: put focus on its row again.
    useEffect(() => {
        if (!returnTo) return;
        const row = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-thread]') ?? [])
            .find(b => b.dataset.thread === returnTo);
        row?.focus();
        setReturnTo(null);
    }, [returnTo]);

    if (!user) {
        return <div className="min-h-screen flex items-center justify-center"><span className="text-4xl font-permanent text-teal-600">LOADING...</span></div>;
    }

    // The open chat's row, kept current (unread, last activity) while it's listed.
    const current = open && (threads.find(t => t.threadKey === open.threadKey) ?? open);

    return (
        <div className="min-h-[calc(100vh-76px)] flex flex-col overflow-hidden relative w-full">
            <div className="flex-grow w-full max-w-6xl mx-auto p-4 sm:p-8 md:p-16 relative z-10">

                <header className="mb-10 md:mb-16 relative">
                    <h1 className="text-4xl sm:text-5xl md:text-7xl font-permanent text-black dark:text-black leading-none tracking-tight uppercase break-words">
                        <span className="relative inline-block">
                            <span className="drop-shadow-[6px_6px_0px_rgba(250,204,21,1)]">YOUR</span>
                        </span>
                        <span className="text-yellow-400 ml-2 sm:ml-4">
                            <span className="drop-shadow-[6px_6px_0px_rgba(0,0,0,1)]">DASHBOARD</span>
                        </span>
                    </h1>
                </header>

                <div className="flex flex-col md:grid md:grid-cols-2 gap-8 text-left">
                    {/* At phone width the list gives way to the open chat */}
                    <div className={`relative min-w-0 ${current ? 'hidden md:block' : ''}`}>
                        <h2 className="text-3xl sm:text-4xl md:text-5xl font-permanent text-yellow-400 uppercase relative w-fit mb-6">
                            <span className="drop-shadow-[4px_4px_0px_rgba(0,0,0,1)]">Profile</span>
                        </h2>
                        <Link href="/profile" className="block p-6 border-4 border-black dark:border-white bg-zinc-200 dark:bg-slate-800 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] hover:shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] transition-shadow group">
                            <div className="flex items-center gap-5">
                                <div className="w-16 h-16 border-4 border-black dark:border-white shrink-0 overflow-hidden bg-zinc-300 dark:bg-zinc-700">
                                    {user.profilePicture ? (
                                        <img src={user.profilePicture} alt="Profile" className="w-full h-full object-cover" />
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center">
                                            <span className="text-3xl font-permanent text-teal-600 dark:text-yellow-400">
                                                {(user.name || user.firstName || 'U').charAt(0).toUpperCase()}
                                            </span>
                                        </div>
                                    )}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-2xl font-permanent text-teal-600 dark:text-yellow-400 uppercase tracking-tight truncate">
                                        {user.name || `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'USER'}
                                    </p>
                                    <p className="text-base font-medium tracking-wider text-zinc-500 dark:text-zinc-400 uppercase break-words">
                                        {user.handle ? `@${user.handle}` : user.email}
                                    </p>
                                </div>
                            </div>
                            <p className="mt-4 text-sm font-medium tracking-wider uppercase text-zinc-500 dark:text-zinc-400">
                                VIEW &amp; EDIT PROFILE
                            </p>
                        </Link>

                        <section aria-labelledby="dash-chats-h" className="mt-10">
                            <h2 id="dash-chats-h" className="flex items-baseline gap-4 text-3xl sm:text-4xl font-permanent text-yellow-400 uppercase relative mb-6">
                                <span className="drop-shadow-[4px_4px_0px_rgba(0,0,0,1)]">Chats</span>
                                {totalUnread > 0 && (
                                    <span className="text-base text-teal-600 dark:text-teal-400">{totalUnread} unread</span>
                                )}
                            </h2>
                            <ThreadList
                                ref={listRef}
                                threads={threads}
                                filter={filter}
                                onFilter={setFilter}
                                selectedKey={current?.threadKey ?? null}
                                onSelect={setOpen}
                                settled={fetched && !loading}
                                error={error}
                            />
                        </section>
                    </div>

                    <section ref={messagesRef} aria-labelledby="dash-messages-h" className={`relative min-w-0 scroll-mt-24 ${current ? "" : "hidden md:block"}`}>
                        <h2 id="dash-messages-h" className="text-3xl sm:text-4xl md:text-5xl font-permanent mb-6 text-teal-600 uppercase relative w-fit">
                            <span className="drop-shadow-[4px_4px_0px_rgba(0,0,0,1)]">Messages</span>
                        </h2>
                        {current ? (
                            <ThreadLog
                                key={current.threadKey}
                                thread={current}
                                markRead={markRead}
                                onBack={() => { setReturnTo(current.threadKey); setOpen(null); }}
                            />
                        ) : <NoThread />}
                    </section>
                </div>

                <GameNightSummary />
            </div>

            <Footer>
                <div className="inline-block border-4 sm:border-8 border-black dark:border-black px-6 sm:px-12 py-6 sm:py-8 mb-12 mx-3 bg-teal-600 shadow-[6px_6px_0px_0px_rgba(249,115,22,1)] sm:shadow-[12px_12px_0px_0px_rgba(249,115,22,1)]">
                    <p className="text-2xl sm:text-3xl md:text-4xl font-permanent text-white uppercase leading-tight">
                        Authenticated.<br/>Secure.<br/>Ready to Build.
                    </p>
                </div>
            </Footer>
        </div>
    );
}
