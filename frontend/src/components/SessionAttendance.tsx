"use client";

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { UserCheck, Check, Save } from 'lucide-react';

interface AttendanceRow {
    playerId: string;
    name: string;
    active: boolean;
    attended: boolean;
    ready: boolean | null;
}

interface Attendance {
    confirmedAt: string | null;
    canConfirm: boolean;
    open: boolean;
    people: AttendanceRow[];
}

/**
 * Who was at a session (#37, plan §4.4). Everyone in the party sees the list.
 * The session's Game Master gets a checklist instead: before attendance is
 * taken it's ticked from the ready check (who said they were ready), so the
 * usual case is one click to confirm (#32's hybrid).
 */
export default function SessionAttendance({ sessionId }: { sessionId: string }) {
    const [data, setData] = useState<Attendance | null>(null);
    const [checked, setChecked] = useState<Set<string>>(new Set());
    const [editing, setEditing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const apply = (a: Attendance) => {
        setData(a);
        // Not taken yet: start from the ready check. Taken: start from the record.
        setChecked(new Set(a.people.filter(p => (a.confirmedAt ? p.attended : p.attended || p.ready === true)).map(p => p.playerId)));
    };

    useEffect(() => {
        fetch(`/api/tabletop/sessions/${sessionId}/attendance`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } })
            .then(async res => {
                if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not load attendance.');
                apply(await res.json());
            })
            .catch(err => setError(err.message));
    }, [sessionId]);

    const save = async () => {
        setSaving(true);
        setError(null);
        try {
            const res = await fetch(`/api/tabletop/sessions/${sessionId}/attendance`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
                body: JSON.stringify({ playerIds: [...checked] }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.error || 'Could not save attendance.');
            apply(body);
            setEditing(false);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setSaving(false);
        }
    };

    if (!data) return error ? <p role="alert" className="font-permanent text-xs text-red-600 uppercase">{error}</p> : null;
    // Nothing to show before the session starts, unless some was recorded anyway (a Salesforce sync).
    const attendees = data.people.filter(p => p.attended);
    if (!data.open && attendees.length === 0) return null;

    const toggle = (id: string) => setChecked(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });
    const showChecklist = data.canConfirm && data.open && (editing || !data.confirmedAt);

    return (
        <section aria-labelledby="attendance-heading">
            <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2">
                    <UserCheck className="w-4 h-4 text-teal-500" />
                    <h3 id="attendance-heading" className="font-permanent text-xs text-zinc-400 uppercase">
                        Attendance {data.confirmedAt || attendees.length ? `(${attendees.length})` : ''}
                    </h3>
                </div>
                {data.canConfirm && data.open && data.confirmedAt && !editing && (
                    <button type="button" onClick={() => setEditing(true)}
                        className="font-permanent text-[10px] uppercase text-teal-600 dark:text-yellow-400 underline hover:no-underline">
                        Edit
                    </button>
                )}
            </div>

            {showChecklist ? (
                <div className="p-3 border-2 border-black bg-zinc-50 dark:bg-zinc-900 space-y-2">
                    <p className="font-permanent text-[10px] text-zinc-500 uppercase">
                        {data.confirmedAt ? 'Who was there?' : 'Who was there? Ticked from the ready check — confirm or change it.'}
                    </p>
                    {data.people.length === 0 ? (
                        <p className="font-permanent text-xs text-zinc-400 uppercase">Nobody in the party yet.</p>
                    ) : (
                        <ul className="space-y-1">
                            {data.people.map(p => (
                                <li key={p.playerId}>
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input type="checkbox" checked={checked.has(p.playerId)} onChange={() => toggle(p.playerId)}
                                            className="w-4 h-4 accent-teal-600" />
                                        <span className={`font-permanent text-sm uppercase ${p.active ? 'text-black dark:text-white' : 'text-zinc-400'}`}>{p.name}</span>
                                        {!p.active && <span className="font-permanent text-[10px] uppercase text-zinc-400">(inactive)</span>}
                                        {p.ready !== null && (
                                            <span className={`font-permanent text-[10px] uppercase ${p.ready ? 'text-teal-600 dark:text-teal-400' : 'text-zinc-400'}`}>
                                                {p.ready ? 'said ready' : "said can't make it"}
                                            </span>
                                        )}
                                    </label>
                                </li>
                            ))}
                        </ul>
                    )}
                    <div className="flex gap-2 pt-1">
                        <button type="button" onClick={save} disabled={saving}
                            className="flex items-center gap-1 px-3 py-1.5 border-2 border-black bg-teal-600 text-white font-permanent uppercase text-xs hover:bg-teal-500 disabled:opacity-50">
                            <Save className="w-3 h-3" /> {saving ? 'Saving…' : `Confirm ${checked.size} attended`}
                        </button>
                        {editing && (
                            <button type="button" onClick={() => { setEditing(false); apply(data); }}
                                className="px-3 py-1.5 border-2 border-black bg-zinc-700 text-white font-permanent uppercase text-xs hover:bg-zinc-600">
                                Cancel
                            </button>
                        )}
                    </div>
                </div>
            ) : attendees.length > 0 ? (
                <ul className="flex flex-wrap gap-2">
                    {attendees.map(p => (
                        <li key={p.playerId}>
                            {p.active ? (
                                <Link href={`/players/${p.playerId}`}
                                    className="inline-flex items-center gap-1 px-2 py-1 border-2 border-black bg-yellow-400 text-black font-permanent text-xs uppercase hover:bg-white">
                                    <Check className="w-3 h-3" /> {p.name}
                                </Link>
                            ) : (
                                // A former party member (#31): named, not linked, since their profile would 403.
                                <span className="inline-flex items-center gap-1 px-2 py-1 border-2 border-black bg-zinc-200 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-300 font-permanent text-xs uppercase" title="No longer in this campaign">
                                    <Check className="w-3 h-3" /> {p.name}
                                </span>
                            )}
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="font-permanent text-xs text-zinc-400 uppercase">
                    {data.confirmedAt ? 'Nobody came.' : 'Not taken yet.'}
                </p>
            )}
            {error && <p role="alert" className="mt-2 font-permanent text-xs text-red-600 uppercase">{error}</p>}
        </section>
    );
}
