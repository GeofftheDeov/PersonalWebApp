"use client";

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ScrollText, Check, ChevronRight } from 'lucide-react';
import { KIND_LABEL, questApi, questDue, type Quest } from '@/lib/quests';
import QuestReminders from './QuestReminders';

/**
 * The Quest Log (#90): the signed-in player's open quests for sessions being
 * planned or still to come, soonest first. Shown on the Game Night home
 * screen. Backed by GET /api/quests/mine.
 */
export default function QuestLog() {
    const [quests, setQuests] = useState<Quest[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setQuests((await questApi<{ quests: Quest[] }>('/mine')).quests);
            setError(null);
        } catch (err: any) {
            setError(err.message);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const markDone = async (q: Quest) => {
        setBusy(q.id);
        try {
            await questApi(`/${q.id}/done`, { method: 'POST' });
            setQuests(prev => prev?.filter(x => x.id !== q.id) ?? null);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setBusy(null);
        }
    };

    return (
        <section aria-labelledby="quest-log-h" className="mb-8 md:mb-10 p-5 border-4 border-black bg-amber-50 dark:bg-slate-800 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]">
            <h2 id="quest-log-h" className="text-2xl font-permanent text-black dark:text-white uppercase flex items-center gap-2">
                <ScrollText className="w-5 h-5 text-teal-600" /> Quest Log
                {quests && quests.length > 0 && <span className="text-sm text-zinc-500 dark:text-zinc-400">({quests.length})</span>}
            </h2>
            <p className="font-permanent text-[10px] text-zinc-600 dark:text-zinc-300 uppercase mb-4">What you owe for upcoming sessions</p>

            {error && <p className="mb-3 font-permanent text-xs text-red-600 uppercase">{error}</p>}
            {quests === null && !error && (
                <p className="font-permanent text-xs text-zinc-500 uppercase animate-pulse">Unrolling the log...</p>
            )}
            {quests?.length === 0 && (
                <p className="font-permanent text-sm text-zinc-500 dark:text-zinc-400 uppercase">No quests. You&apos;re all set for game night.</p>
            )}
            {quests && quests.length > 0 && (
                <ul className="space-y-2">
                    {quests.map(q => (
                        <li key={q.id} className="flex items-start gap-3 p-3 border-2 border-black bg-white dark:bg-slate-700">
                            <button
                                onClick={() => markDone(q)}
                                disabled={busy === q.id}
                                aria-label={`Mark "${q.title}" done`}
                                title="Mark done"
                                className="mt-0.5 w-6 h-6 shrink-0 grid place-items-center border-2 border-black bg-white hover:bg-teal-500 hover:text-white text-transparent transition-colors disabled:opacity-40"
                            >
                                <Check className="w-4 h-4" />
                            </button>
                            <div className="min-w-0 flex-1">
                                <p className="font-permanent text-sm text-black dark:text-white uppercase break-words">{q.title}</p>
                                {q.notes && <p className="font-permanent text-[11px] text-zinc-600 dark:text-zinc-300 uppercase break-words">{q.notes}</p>}
                                <p className="mt-1 font-permanent text-[10px] uppercase text-teal-700 dark:text-teal-300 flex flex-wrap gap-x-2">
                                    {q.kind !== 'custom' && <span className="text-black dark:text-white">{KIND_LABEL[q.kind]}</span>}
                                    <span>{questDue(q)}</span>
                                    <span className="text-zinc-500 dark:text-zinc-400">{q.session.campaign.title}</span>
                                </p>
                                <QuestReminders quest={q}
                                    onChange={next => setQuests(prev => prev?.map(x => x.id === next.id ? next : x) ?? null)} />
                            </div>
                            <Link href={`/game-night/sessions/${q.sessionId}#quests`}
                                className="shrink-0 self-center flex items-center gap-1 font-permanent text-[10px] uppercase text-zinc-600 dark:text-zinc-300 hover:text-teal-600 max-w-[40%]">
                                <span className="truncate">{q.session.title}</span> <ChevronRight className="w-4 h-4 shrink-0" />
                            </Link>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
