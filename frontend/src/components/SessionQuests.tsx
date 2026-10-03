"use client";

import { useCallback, useEffect, useState } from 'react';
import { ScrollText, Check, Plus, X } from 'lucide-react';
import { KIND_LABEL, questApi, questDue, type Quest } from '@/lib/quests';

/**
 * A session's quests (#90), on the session page. The party sees every quest;
 * a quest's owner or the Game Master can mark it done; the Game Master adds
 * quests for anyone in the party and can hand one to someone else. Backed by
 * /api/quests/sessions/:id.
 */

interface SessionQuestsState {
    session: { id: string; title: string; date: string | null; status: string };
    gmTitle: string;
    viewer: { id: string; isGameMaster: boolean };
    party: { id: string; name: string }[];
    quests: Quest[];
}

const BTN = "flex items-center gap-1.5 px-3 py-1.5 border-2 border-black font-permanent uppercase text-xs transition-colors shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] disabled:opacity-40";
const INPUT_CLS = "w-full p-2 border-2 border-black bg-white text-black font-permanent text-sm uppercase outline-none focus:border-teal-500";
const LABEL_CLS = "block text-teal-700 dark:text-teal-400 font-permanent uppercase text-[10px] mb-1";

/** A datetime-local value -> ISO, or undefined to keep the default (the session's start). */
const localToIso = (v: string) => (v ? new Date(v).toISOString() : undefined);

export default function SessionQuests({ sessionId }: { sessionId: string }) {
    const [state, setState] = useState<SessionQuestsState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [adding, setAdding] = useState(false);
    const [form, setForm] = useState({ title: '', assigneeId: '', notes: '', dueAt: '' });

    const load = useCallback(async () => {
        try {
            setState(await questApi<SessionQuestsState>(`/sessions/${sessionId}`));
            setError(null);
        } catch (err: any) {
            setError(err.message);
        }
    }, [sessionId]);

    useEffect(() => { load(); }, [load]);

    // The bell links here with #quests; the section renders after the fetch, so scroll once it exists.
    useEffect(() => {
        if (state && typeof window !== 'undefined' && window.location.hash === '#quests') {
            document.getElementById('quests')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }, [state]);

    const act = async (fn: () => Promise<unknown>) => {
        setBusy(true);
        try {
            await fn();
            await load();
        } catch (err: any) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    };

    if (!state) {
        return error ? <p className="font-permanent text-xs text-red-600 uppercase">{error}</p> : null;
    }

    const { viewer, party, quests } = state;
    const canAdd = viewer.isGameMaster && state.session.status !== 'cancelled' && state.session.status !== 'completed';

    const submit = (e: React.FormEvent) => {
        e.preventDefault();
        act(async () => {
            await questApi(`/sessions/${sessionId}`, {
                method: 'POST',
                body: { title: form.title, assigneeId: form.assigneeId, notes: form.notes || undefined, dueAt: localToIso(form.dueAt) },
            });
            setForm({ title: '', assigneeId: '', notes: '', dueAt: '' });
            setAdding(false);
        });
    };

    return (
        <section id="quests" aria-labelledby="quests-h" className="scroll-mt-24">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                <h2 id="quests-h" className="font-permanent text-xs text-zinc-400 uppercase flex items-center gap-2">
                    <ScrollText className="w-4 h-4 text-teal-500" /> Quests
                </h2>
                {canAdd && !adding && (
                    <button onClick={() => setAdding(true)} className={`${BTN} bg-yellow-400 text-black hover:bg-white`}>
                        <Plus className="w-3.5 h-3.5" /> Add quest
                    </button>
                )}
            </div>

            {error && <p className="mb-2 font-permanent text-xs text-red-600 uppercase">{error}</p>}

            {adding && (
                <form onSubmit={submit} className="mb-4 p-4 border-2 border-black bg-amber-50 dark:bg-slate-900 space-y-3">
                    <div className="flex justify-between items-center">
                        <p className="font-permanent text-sm text-black dark:text-white uppercase">New quest</p>
                        <button type="button" onClick={() => setAdding(false)} aria-label="Close" className="text-zinc-500 hover:text-black dark:hover:text-white"><X className="w-4 h-4" /></button>
                    </div>
                    <div>
                        <label htmlFor="quest-title" className={LABEL_CLS}>What needs doing *</label>
                        <input id="quest-title" required maxLength={120} className={INPUT_CLS} placeholder="PRINT THE HANDOUT"
                            value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                            <label htmlFor="quest-assignee" className={LABEL_CLS}>Who *</label>
                            <select id="quest-assignee" required className={`${INPUT_CLS} appearance-none`}
                                value={form.assigneeId} onChange={e => setForm({ ...form, assigneeId: e.target.value })}>
                                <option value="">— Pick a party member —</option>
                                {party.map(p => <option key={p.id} value={p.id}>{p.id === viewer.id ? `${p.name} (you)` : p.name}</option>)}
                            </select>
                        </div>
                        <div>
                            <label htmlFor="quest-due" className={LABEL_CLS}>Due (default: session start)</label>
                            <input id="quest-due" type="datetime-local" className={INPUT_CLS}
                                value={form.dueAt} onChange={e => setForm({ ...form, dueAt: e.target.value })} />
                        </div>
                    </div>
                    <div>
                        <label htmlFor="quest-notes" className={LABEL_CLS}>Notes</label>
                        <textarea id="quest-notes" rows={2} maxLength={1000} className={INPUT_CLS} placeholder="TWO COPIES, IN COLOUR"
                            value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
                    </div>
                    <button type="submit" disabled={busy} className={`${BTN} bg-teal-600 text-white hover:bg-teal-500`}>
                        <Plus className="w-3.5 h-3.5" /> {busy ? 'Adding...' : 'Add quest'}
                    </button>
                </form>
            )}

            {quests.length === 0 ? (
                <p className="font-permanent text-sm text-zinc-500 dark:text-zinc-400 uppercase">
                    No quests for this session{canAdd ? ' yet.' : '.'}
                </p>
            ) : (
                <ul className="space-y-2">
                    {quests.map(q => {
                        const done = q.status === 'done';
                        const canFinish = !done && (q.assignee?.id === viewer.id || viewer.isGameMaster);
                        return (
                            <li key={q.id} className={`flex items-start gap-3 p-3 border-2 border-black ${done ? 'bg-zinc-100 dark:bg-zinc-900' : 'bg-white dark:bg-slate-700'}`}>
                                <span className={`mt-0.5 w-6 h-6 shrink-0 grid place-items-center border-2 border-black ${done ? 'bg-teal-500 text-white' : 'bg-white'}`}>
                                    {done && <Check className="w-4 h-4" />}
                                </span>
                                <div className="min-w-0 flex-1">
                                    <p className={`font-permanent text-sm uppercase break-words ${done ? 'text-zinc-500 dark:text-zinc-400 line-through' :'text-black dark:text-white'}`}>{q.title}</p>
                                    {q.notes && <p className="font-permanent text-[11px] text-zinc-600 dark:text-zinc-300 uppercase break-words">{q.notes}</p>}
                                    <p className="mt-1 font-permanent text-[10px] uppercase text-teal-700 dark:text-teal-300 flex flex-wrap gap-x-2">
                                        {q.kind !== 'custom' && <span className="text-black dark:text-white">{KIND_LABEL[q.kind]}</span>}
                                        <span>{q.assignee ? (q.assignee.id === viewer.id ? 'You' : q.assignee.name) : 'Unclaimed'}</span>
                                        <span>{done ? 'Done' : questDue(q)}</span>
                                    </p>
                                    {viewer.isGameMaster && !done && (
                                        <label className="mt-2 flex items-center gap-2 font-permanent text-[10px] uppercase text-zinc-600 dark:text-zinc-300">
                                            Hand to
                                            <select aria-label={`Reassign "${q.title}"`} disabled={busy}
                                                className="p-1 border-2 border-black bg-white text-black font-permanent text-[10px] uppercase"
                                                value={q.assignee?.id ?? ''}
                                                onChange={e => act(() => questApi(`/${q.id}`, { method: 'PATCH', body: { assigneeId: e.target.value } }))}>
                                                {!q.assignee && <option value="">Unclaimed</option>}
                                                {party.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                                            </select>
                                        </label>
                                    )}
                                </div>
                                {canFinish && (
                                    <button onClick={() => act(() => questApi(`/${q.id}/done`, { method: 'POST' }))} disabled={busy}
                                        className={`${BTN} shrink-0 bg-teal-600 text-white hover:bg-teal-500`}>
                                        <Check className="w-3.5 h-3.5" /> Done
                                    </button>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}
