"use client";

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { Map, ArrowLeft, Calendar, Book, Users, Shield, ChevronRight, Crown, Save, X, Pencil, UserPlus, Check } from 'lucide-react';

interface Session {
    _id: string;
    title: string;
    date: string;
    location?: string;
    summary?: string;
}

interface Member {
    _id: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    status?: string;
    contact?: { name?: string };
    lead?: { firstName?: string; lastName?: string };
    account?: { name?: string };
}

const INPUT_CLS = "w-full p-3 border-4 border-black bg-white text-black font-permanent text-base uppercase focus:border-yellow-400 outline-none";
const LABEL_CLS = "block text-teal-400 font-permanent uppercase text-xs mb-1";

const statusColor = (status: string) => {
    if (status === 'In Progress') return 'bg-teal-500 text-white';
    if (status === 'Completed') return 'bg-zinc-600 text-white';
    return 'bg-yellow-400 text-black';
};

const memberName = (m: Member) => {
    if (m.firstName || m.lastName) return `${m.firstName || ''} ${m.lastName || ''}`.trim();
    if (m.contact?.name) return m.contact.name;
    if (m.lead?.firstName || m.lead?.lastName) return `${m.lead.firstName || ''} ${m.lead.lastName || ''}`.trim();
    if (m.account?.name) return m.account.name;
    return m.email || 'Unknown Player';
};

const toDateInput = (d?: string) => d ? new Date(d).toISOString().split('T')[0] : '';

export default function CampaignDetailPage() {
    const router = useRouter();
    const params = useParams();
    const id = params?.id as string;

    const [campaign, setCampaign] = useState<any>(null);
    const [sessions, setSessions] = useState<Session[]>([]);
    const [members, setMembers] = useState<Member[]>([]);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [copied, setCopied] = useState(false);
    const [form, setForm] = useState<any>({});

    const token = () => localStorage.getItem('token');

    useEffect(() => {
        const t = token();
        if (!t) { router.push('/login'); return; }
        const headers = { Authorization: `Bearer ${t}` };
        Promise.all([
            fetch(`/api/campaigns/${id}`, { headers }),
            fetch(`/api/campaigns/${id}/sessions`, { headers }),
            fetch(`/api/campaigns/${id}/members`, { headers }),
        ]).then(async ([campRes, sessRes, membRes]) => {
            if (campRes.status === 401) { localStorage.clear(); router.push('/login'); return; }
            if (!campRes.ok) { router.push('/game-night'); return; }
            const c = await campRes.json();
            setCampaign(c);
            setForm({ title: c.title, description: c.description || '', status: c.status, startDate: toDateInput(c.startDate), endDate: toDateInput(c.endDate) });
            if (sessRes.ok) setSessions(await sessRes.json());
            if (membRes.ok) setMembers(await membRes.json());
        }).catch(() => router.push('/game-night'))
          .finally(() => setLoading(false));
    }, [id, router]);

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        const res = await fetch(`/api/campaigns/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
            body: JSON.stringify(form),
        });
        if (res.ok) { setCampaign(await res.json()); setEditing(false); }
        setSaving(false);
    };

    const handleInvite = () => {
        navigator.clipboard.writeText(`${window.location.origin}/game-night/join/${id}`);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    if (loading) return <div className="min-h-screen flex items-center justify-center"><span className="text-3xl font-permanent text-teal-600 animate-pulse">LOADING CAMPAIGN...</span></div>;
    if (!campaign) return null;

    return (
        <div className="min-h-[calc(100vh-76px)] flex flex-col">
            <div className="flex-grow w-full max-w-4xl mx-auto p-6 md:p-12">

                <div className="mb-8">
                    <Link href="/game-night" className="inline-flex items-center gap-2 px-4 py-2 bg-yellow-400 text-black border-4 border-black font-permanent text-sm shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-white transition-colors uppercase w-fit">
                        <ArrowLeft className="w-4 h-4" /> BACK TO GAME NIGHT
                    </Link>
                </div>

                {/* Header */}
                <div className="mb-8 pb-6 border-b-8 border-black flex items-start justify-between gap-4">
                    <div className="flex items-start gap-4">
                        <div className="p-3 bg-teal-500 border-4 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] shrink-0">
                            <Map className="w-8 h-8 text-white" />
                        </div>
                        <div>
                            <p className="font-permanent text-xs text-zinc-400 uppercase mb-1">Campaign</p>
                            <h1 className="text-3xl md:text-4xl font-permanent text-black dark:text-white uppercase leading-tight">{campaign.title}</h1>
                            <div className="mt-2">
                                <span className={`px-3 py-1 text-sm font-permanent uppercase border-2 border-black ${statusColor(campaign.status)}`}>{campaign.status}</span>
                            </div>
                        </div>
                    </div>
                    {!editing && (
                        <button
                            onClick={() => setEditing(true)}
                            className="flex items-center gap-2 px-4 py-2 border-4 border-black bg-yellow-400 text-black font-permanent uppercase text-sm hover:bg-white transition-colors shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] shrink-0"
                        >
                            <Pencil className="w-4 h-4" /> EDIT
                        </button>
                    )}
                </div>

                {/* Edit Form */}
                {editing && (
                    <form onSubmit={handleSave} className="mb-8 p-6 border-4 border-black bg-slate-900 shadow-[8px_8px_0px_0px_rgba(13,148,136,1)] space-y-4">
                        <div className="flex justify-between items-center mb-2">
                            <h2 className="font-permanent text-lg text-white uppercase flex items-center gap-2"><Pencil className="w-4 h-4 text-teal-400" /> Edit Campaign</h2>
                            <button type="button" onClick={() => setEditing(false)} className="text-zinc-400 hover:text-white transition-colors"><X className="w-5 h-5" /></button>
                        </div>
                        <div><label className={LABEL_CLS}>Title *</label><input required className={INPUT_CLS} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></div>
                        <div><label className={LABEL_CLS}>Description</label><textarea className={INPUT_CLS} rows={3} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></div>
                        <div className="grid grid-cols-2 gap-4">
                            <div><label className={LABEL_CLS}>Start Date</label><input type="date" className={INPUT_CLS} value={form.startDate} onChange={e => setForm({ ...form, startDate: e.target.value })} /></div>
                            <div><label className={LABEL_CLS}>End Date</label><input type="date" className={INPUT_CLS} value={form.endDate} onChange={e => setForm({ ...form, endDate: e.target.value })} /></div>
                        </div>
                        <div>
                            <label className={LABEL_CLS}>Status</label>
                            <select className={INPUT_CLS + " appearance-none"} value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>
                                <option>Not Started</option><option>In Progress</option><option>Completed</option>
                            </select>
                        </div>
                        <div className="flex gap-3 pt-2">
                            <button type="submit" disabled={saving} className="flex-1 flex items-center justify-center gap-2 p-3 border-4 border-black bg-teal-600 text-white font-permanent uppercase hover:bg-teal-500 transition-colors">
                                <Save className="w-4 h-4" /> {saving ? 'SAVING...' : 'SAVE CHANGES'}
                            </button>
                            <button type="button" onClick={() => setEditing(false)} className="px-6 p-3 border-4 border-black bg-zinc-700 text-white font-permanent uppercase hover:bg-zinc-600 transition-colors">CANCEL</button>
                        </div>
                    </form>
                )}

                {/* Campaign Info */}
                {!editing && (
                    <div className="p-6 border-4 border-black bg-white dark:bg-slate-800 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] mb-8 space-y-5">
                        {campaign.description && (
                            <div>
                                <p className="font-permanent text-xs text-zinc-400 uppercase mb-1">Description</p>
                                <p className="font-permanent text-black dark:text-white uppercase text-sm leading-relaxed">{campaign.description}</p>
                            </div>
                        )}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                            {campaign.startDate && (
                                <div className="flex items-start gap-2">
                                    <Calendar className="w-4 h-4 text-teal-500 mt-0.5 shrink-0" />
                                    <div>
                                        <p className="font-permanent text-xs text-zinc-400 uppercase">Start Date</p>
                                        <p className="font-permanent text-black dark:text-white uppercase text-sm">{new Date(campaign.startDate).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }).toUpperCase()}</p>
                                    </div>
                                </div>
                            )}
                            {campaign.endDate && (
                                <div className="flex items-start gap-2">
                                    <Calendar className="w-4 h-4 text-yellow-500 mt-0.5 shrink-0" />
                                    <div>
                                        <p className="font-permanent text-xs text-zinc-400 uppercase">End Date</p>
                                        <p className="font-permanent text-black dark:text-white uppercase text-sm">{new Date(campaign.endDate).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }).toUpperCase()}</p>
                                    </div>
                                </div>
                            )}
                        </div>
                        <div className="pt-4 border-t-2 border-black/10 dark:border-white/10">
                            <p className="font-permanent text-xs text-zinc-400 uppercase mb-1">Created</p>
                            <p className="font-permanent text-black dark:text-white uppercase text-sm">{new Date(campaign.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }).toUpperCase()}</p>
                        </div>
                    </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                    {/* Sessions */}
                    <div className="lg:col-span-2">
                        <h2 className="text-2xl font-permanent text-black dark:text-white uppercase flex items-center gap-2 mb-4">
                            <Book className="w-5 h-5 text-teal-500" /> Sessions <span className="ml-1 text-sm text-zinc-400">({sessions.length})</span>
                        </h2>
                        {sessions.length === 0 ? (
                            <div className="py-10 border-4 border-dashed border-zinc-300 dark:border-zinc-700 text-center">
                                <Book className="w-10 h-10 text-zinc-300 dark:text-zinc-600 mx-auto mb-2" />
                                <p className="font-permanent text-sm text-zinc-400 uppercase">No sessions logged yet.</p>
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {sessions.map(s => (
                                    <Link key={s._id} href={`/game-night/sessions/${s._id}`} className="flex gap-4 p-4 border-4 border-black bg-white dark:bg-slate-800 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 transition-transform items-start group block">
                                        <div className="p-2 bg-teal-500 border-2 border-black shrink-0"><Book className="w-4 h-4 text-white" /></div>
                                        <div className="flex-grow min-w-0">
                                            <h3 className="font-permanent text-sm text-black dark:text-white uppercase group-hover:text-teal-600 transition-colors truncate">{s.title}</h3>
                                            <div className="flex gap-3 mt-1 flex-wrap">
                                                <span className="text-xs font-permanent text-teal-600 dark:text-yellow-400 uppercase">{new Date(s.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase()}</span>
                                                {s.location && <span className="text-xs font-permanent text-zinc-400 uppercase">{s.location}</span>}
                                            </div>
                                            {s.summary && <p className="mt-1 text-xs font-permanent text-zinc-500 dark:text-zinc-400 uppercase line-clamp-1">{s.summary}</p>}
                                        </div>
                                        <ChevronRight className="w-4 h-4 text-zinc-300 dark:text-zinc-600 shrink-0 self-center group-hover:text-teal-500 transition-colors" />
                                    </Link>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Players */}
                    <div>
                        <div className="flex items-center justify-between mb-4">
                            <h2 className="text-2xl font-permanent text-black dark:text-white uppercase flex items-center gap-2">
                                <Users className="w-5 h-5 text-yellow-500" /> Players <span className="ml-1 text-sm text-zinc-400">({members.length})</span>
                            </h2>
                            <button
                                onClick={handleInvite}
                                className={`flex items-center gap-2 px-3 py-1.5 border-2 border-black font-permanent uppercase text-xs transition-colors shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] ${copied ? 'bg-teal-500 text-white' : 'bg-white text-black hover:bg-zinc-100'}`}
                            >
                                {copied ? <Check className="w-3 h-3" /> : <UserPlus className="w-3 h-3" />}
                                {copied ? 'COPIED' : 'INVITE'}
                            </button>
                        </div>
                        {members.length === 0 ? (
                            <div className="py-10 border-4 border-dashed border-zinc-300 dark:border-zinc-700 text-center">
                                <Users className="w-10 h-10 text-zinc-300 dark:text-zinc-600 mx-auto mb-2" />
                                <p className="font-permanent text-sm text-zinc-400 uppercase">No players yet.</p>
                            </div>
                        ) : (
                            <div className="space-y-2">
                                {members.map(m => (
                                    <div key={m._id} className="flex items-center gap-3 p-3 border-4 border-black bg-white dark:bg-slate-800 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]">
                                        <div className={`p-1.5 border-2 border-black shrink-0 ${m.status === 'Game Master' ? 'bg-yellow-400' : 'bg-teal-500'}`}>
                                            {m.status === 'Game Master' ? <Crown className="w-4 h-4 text-black" /> : <Shield className="w-4 h-4 text-white" />}
                                        </div>
                                        <div className="flex-grow min-w-0">
                                            <p className="font-permanent text-sm text-black dark:text-white uppercase truncate">{memberName(m)}</p>
                                            {m.status && <p className="text-xs font-permanent text-teal-600 dark:text-yellow-400 uppercase">{m.status}</p>}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
