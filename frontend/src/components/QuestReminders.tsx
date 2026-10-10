"use client";

import { useState } from 'react';
import { Bell, BellPlus, Check, X } from 'lucide-react';
import {
    MAX_REMINDERS, describeOffset, questApi, reminderPresets, reminderTime, type Quest,
} from '@/lib/quests';

/**
 * Reminder timing for one quest (#91), for its owner: the reminders they've
 * chosen, each with when it goes out, and presets to add more. Each change
 * saves straight away (PUT /api/quests/:id/reminders) and hands the updated
 * quest back. Used on the Quest Log and the session page.
 */
export default function QuestReminders({ quest, onChange }: { quest: Quest; onChange: (q: Quest) => void }) {
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const offsets = quest.reminderOffsets;
    const presets = reminderPresets(quest.dueAt).filter(p => !offsets.includes(p.minutes));
    const full = offsets.length >= MAX_REMINDERS;

    const save = async (next: number[]) => {
        setBusy(true);
        setError(null);
        try {
            onChange(await questApi<Quest>(`/${quest.id}/reminders`, { method: 'PUT', body: { offsets: next } }));
        } catch (err: any) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    };

    const CHIP = "inline-flex items-center gap-1 px-1.5 py-0.5 border-2 border-black font-permanent text-[10px] uppercase";

    return (
        <div className="mt-2">
            <div className="flex flex-wrap items-center gap-1.5">
                <Bell className="w-3.5 h-3.5 text-teal-600 shrink-0" aria-hidden />
                <span className="font-permanent text-[10px] uppercase text-zinc-600 dark:text-zinc-300">Remind me</span>
                {offsets.length === 0 && (
                    <span className="font-permanent text-[10px] uppercase text-zinc-500 dark:text-zinc-400">— not set</span>
                )}
                {offsets.map(m => {
                    const sent = quest.remindersSent.includes(m);
                    const when = reminderTime(m, quest.dueAt);
                    const label = describeOffset(m, quest.dueAt);
                    return (
                        <span key={m} title={when ? `${sent ? 'Sent' : 'Goes out'} ${when}` : 'Goes out once the night is set'}
                            className={`${CHIP} ${sent ? 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400' : 'bg-white text-black'}`}>
                            {sent && <Check className="w-3 h-3" aria-label="sent" />}
                            {label}
                            {when && <span className="normal-case text-zinc-500 hidden sm:inline">· {when}</span>}
                            <button onClick={() => save(offsets.filter(o => o !== m))} disabled={busy}
                                aria-label={`Remove the "${label}" reminder`}
                                className="ml-0.5 text-zinc-500 hover:text-red-600 disabled:opacity-40">
                                <X className="w-3 h-3" />
                            </button>
                        </span>
                    );
                })}
                {!full && (
                    <button onClick={() => setOpen(o => !o)} disabled={busy} aria-expanded={open}
                        className={`${CHIP} bg-yellow-400 text-black hover:bg-white disabled:opacity-40`}>
                        <BellPlus className="w-3 h-3" /> Add
                    </button>
                )}
            </div>
            {open && !full && (
                <div role="group" aria-label={`Add a reminder for "${quest.title}"`} className="mt-1.5 flex flex-wrap gap-1.5 pl-5">
                    {presets.map(p => (
                        <button key={p.minutes} disabled={busy}
                            onClick={() => { setOpen(false); save([...offsets, p.minutes]); }}
                            className={`${CHIP} bg-white text-black hover:bg-teal-500 hover:text-white disabled:opacity-40`}>
                            {p.label}
                        </button>
                    ))}
                    {!quest.dueAt && (
                        <span className="font-permanent text-[10px] uppercase text-zinc-500 dark:text-zinc-400 self-center">
                            Morning reminders appear once the night is set
                        </span>
                    )}
                </div>
            )}
            {error && <p className="mt-1 font-permanent text-[10px] text-red-600 uppercase">{error}</p>}
        </div>
    );
}
