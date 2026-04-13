"use client";

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { Book, ArrowLeft, Calendar, MapPin, FileText, Map, Save, X, Pencil } from 'lucide-react';

const INPUT_CLS = "w-full p-3 border-4 border-black bg-white text-black font-permanent text-base uppercase focus:border-yellow-400 outline-none";
const LABEL_CLS = "block text-teal-400 font-permanent uppercase text-xs mb-1";

const toDatetimeInput = (d?: string) => {
    if (!d) return '';
    const dt = new Date(d);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
};

export default function SessionDetailPage() {
    const router = useRouter();
    const params = useParams();
    const id = params?.id as string;

    const [session, setSession] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [form, setForm] = useState<any>({});

    const token = () => localStorage.getItem('token');

    useEffect(() => {
        const t = token();
        if (!t) { router.push('/login'); return; }
        fetch(`/api/tabletop/sessions/${id}`, { headers: { Authorization: `Bearer ${t}` } })
            .then(async res => {
                if (res.status === 401) { localStorage.clear(); router.push('/login'); return; }
                if (res.ok) {
                    const s = await res.json();
                    setSession(s);
                    setForm({ title: s.title, date: toDatetimeInput(s.date), location: s.location || '', agenda: s.agenda || '', summary: s.summary || '', vodUrl: s.vodUrl || '' });
                } else router.push('/game-night');
            })
            .catch(() => router.push('/game-night'))
            .finally(() => setLoading(false));
    }, [id, router]);

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        const res = await fetch(`/api/tabletop/sessions/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
            body: JSON.stringify(form),
        });
        if (res.ok) { setSession(await res.json()); setEditing(false); }
        setSaving(false);
    };

    if (loading) return <div className="min-h-screen flex items-center justify-center"><span className="text-3xl font-permanent text-teal-600 animate-pulse">LOADING SESSION...</span></div>;
    if (!session) return null;

    const sessionDate = session.date ? new Date(session.date) : null;

    return (
        <div className="min-h-[calc(100vh-76px)] flex flex-col">
            <div className="flex-grow w-full max-w-3xl mx-auto p-6 md:p-12">

                <div className="mb-8">
                    <Link href="/game-night" className="inline-flex items-center gap-2 px-4 py-2 bg-yellow-400 text-black border-4 border-black font-permanent text-sm shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-white transition-colors uppercase w-fit">
                        <ArrowLeft className="w-4 h-4" /> BACK TO GAME NIGHT
                    </Link>
                </div>

                {/* Header */}
                <div className="mb-8 pb-6 border-b-8 border-black flex items-start justify-between gap-4">
                    <div className="flex items-start gap-4">
                        <div className="p-3 bg-teal-500 border-4 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] shrink-0">
                            <Book className="w-8 h-8 text-white" />
                        </div>
                        <div>
                            <p className="font-permanent text-xs text-zinc-400 uppercase mb-1">Session</p>
                            <h1 className="text-3xl md:text-4xl font-permanent text-black dark:text-white uppercase leading-tight">{session.title}</h1>
                            {session.campaign && (
                                <Link href={`/game-night/campaigns/${session.campaign._id}`} className="flex items-center gap-1 mt-2 font-permanent text-sm text-teal-600 uppercase hover:text-yellow-500 transition-colors w-fit">
                                    <Map className="w-3 h-3" /> {session.campaign.title}
                                </Link>
                            )}
                        </div>
                    </div>
                    {!editing && (
                        <button onClick={() => setEditing(true)} className="flex items-center gap-2 px-4 py-2 border-4 border-black bg-yellow-400 text-black font-permanent uppercase text-sm hover:bg-white transition-colors shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] shrink-0">
                            <Pencil className="w-4 h-4" /> EDIT
                        </button>
                    )}
                </div>

                {/* Edit Form */}
                {editing && (
                    <form onSubmit={handleSave} className="mb-8 p-6 border-4 border-black bg-slate-900 shadow-[8px_8px_0px_0px_rgba(13,148,136,1)] space-y-4">
                        <div className="flex justify-between items-center mb-2">
                            <h2 className="font-permanent text-lg text-white uppercase flex items-center gap-2"><Pencil className="w-4 h-4 text-teal-400" /> Edit Session</h2>
                            <button type="button" onClick={() => setEditing(false)} className="text-zinc-400 hover:text-white transition-colors"><X className="w-5 h-5" /></button>
                        </div>
                        <div><label className={LABEL_CLS}>Title *</label><input required className={INPUT_CLS} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></div>
                        <div className="grid grid-cols-2 gap-4">
                            <div><label className={LABEL_CLS}>Date & Time</label><input type="datetime-local" className={INPUT_CLS} value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} /></div>
                            <div><label className={LABEL_CLS}>Location</label><input className={INPUT_CLS} placeholder="GEOFF'S BASEMENT" value={form.location} onChange={e => setForm({ ...form, location: e.target.value })} /></div>
                        </div>
                        <div><label className={LABEL_CLS}>Agenda / Prep Notes</label><textarea className={INPUT_CLS} rows={3} value={form.agenda} onChange={e => setForm({ ...form, agenda: e.target.value })} /></div>
                        <div><label className={LABEL_CLS}>Summary</label><textarea className={INPUT_CLS} rows={3} value={form.summary} onChange={e => setForm({ ...form, summary: e.target.value })} /></div>
                        <div><label className={LABEL_CLS}>VOD / Recording URL</label><input className={INPUT_CLS} placeholder="HTTPS://..." value={form.vodUrl} onChange={e => setForm({ ...form, vodUrl: e.target.value })} /></div>
                        <div className="flex gap-3 pt-2">
                            <button type="submit" disabled={saving} className="flex-1 flex items-center justify-center gap-2 p-3 border-4 border-black bg-teal-600 text-white font-permanent uppercase hover:bg-teal-500 transition-colors">
                                <Save className="w-4 h-4" /> {saving ? 'SAVING...' : 'SAVE CHANGES'}
                            </button>
                            <button type="button" onClick={() => setEditing(false)} className="px-6 p-3 border-4 border-black bg-zinc-700 text-white font-permanent uppercase hover:bg-zinc-600 transition-colors">CANCEL</button>
                        </div>
                    </form>
                )}

                {/* View */}
                {!editing && (
                    <div className="p-6 border-4 border-black bg-white dark:bg-slate-800 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] space-y-6">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            {sessionDate && (
                                <div className="flex items-start gap-2">
                                    <Calendar className="w-4 h-4 text-teal-500 mt-0.5 shrink-0" />
                                    <div>
                                        <p className="font-permanent text-xs text-zinc-400 uppercase">Date</p>
                                        <p className="font-permanent text-black dark:text-white uppercase text-sm">{sessionDate.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).toUpperCase()}</p>
                                        <p className="font-permanent text-teal-600 dark:text-yellow-400 uppercase text-xs mt-0.5">{sessionDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</p>
                                    </div>
                                </div>
                            )}
                            {session.location && (
                                <div className="flex items-start gap-2">
                                    <MapPin className="w-4 h-4 text-yellow-500 mt-0.5 shrink-0" />
                                    <div>
                                        <p className="font-permanent text-xs text-zinc-400 uppercase">Location</p>
                                        <p className="font-permanent text-black dark:text-white uppercase text-sm">{session.location}</p>
                                    </div>
                                </div>
                            )}
                        </div>
                        {session.agenda && (
                            <div>
                                <div className="flex items-center gap-2 mb-2"><FileText className="w-4 h-4 text-teal-500" /><p className="font-permanent text-xs text-zinc-400 uppercase">Agenda / Prep Notes</p></div>
                                <div className="p-3 border-2 border-black/20 dark:border-white/20 bg-zinc-50 dark:bg-zinc-900">
                                    <p className="font-permanent text-black dark:text-white uppercase text-sm leading-relaxed">{session.agenda}</p>
                                </div>
                            </div>
                        )}
                        {session.summary && (
                            <div>
                                <div className="flex items-center gap-2 mb-2"><FileText className="w-4 h-4 text-yellow-500" /><p className="font-permanent text-xs text-zinc-400 uppercase">Session Summary</p></div>
                                <div className="p-3 border-2 border-black/20 dark:border-white/20 bg-zinc-50 dark:bg-zinc-900">
                                    <p className="font-permanent text-black dark:text-white uppercase text-sm leading-relaxed">{session.summary}</p>
                                </div>
                            </div>
                        )}
                        {session.vodUrl && (
                            <div>
                                <p className="font-permanent text-xs text-zinc-400 uppercase mb-1">VOD / Recording</p>
                                <a href={session.vodUrl} target="_blank" rel="noopener noreferrer" className="font-permanent text-teal-600 dark:text-yellow-400 uppercase text-sm underline hover:no-underline">{session.vodUrl}</a>
                            </div>
                        )}
                        <div className="pt-4 border-t-2 border-black/10 dark:border-white/10">
                            <p className="font-permanent text-xs text-zinc-400 uppercase mb-1">Logged</p>
                            <p className="font-permanent text-black dark:text-white uppercase text-sm">{new Date(session.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }).toUpperCase()}</p>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
