"use client";

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { Map, ArrowLeft, Calendar, Book, Users, Shield, ChevronRight, Crown, Save, X, Pencil, UserPlus, Check, Copy, Link2, Plus, Wifi } from 'lucide-react';
import CampaignChat from '@/components/CampaignChat';

interface Session {
    _id: string;
    title: string;
    date: string;
    location?: string;
    isOnline?: boolean;
    summary?: string;
}

interface Member {
    _id: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    status?: string;
    playerId?: string | null;
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

/** Is the logged-in user the Game Master of this campaign (or an admin)? */
const computeIsGM = (members: Member[]) => {
    try {
        const me = JSON.parse(localStorage.getItem('user') || 'null');
        if (!me) return false;
        if (me.role === 'admin') return true;
        return members.some(m =>
            m.status === 'Game Master' &&
            ((m.email && me.email && m.email.toLowerCase() === me.email.toLowerCase()) || (m.playerId && m.playerId === me.id))
        );
    } catch {
        return false;
    }
};

const Toggle = ({ on, onClick, label, icon }: { on: boolean; onClick: () => void; label: string; icon?: React.ReactNode }) => (
    <button type="button" role="switch" aria-checked={on} onClick={onClick} className="flex items-center gap-3 w-fit">
        <span className={`relative inline-block w-12 h-6 border-2 border-black transition-colors shrink-0 ${on ? 'bg-teal-500' : 'bg-zinc-600'}`}>
            <span className={`absolute top-0 h-full w-6 bg-white border-r-2 border-l-2 border-black transition-all ${on ? 'left-6' : 'left-0'}`} />
        </span>
        <span className="font-permanent text-xs text-white uppercase flex items-center gap-1 text-left">{icon}{label}</span>
    </button>
);

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
    const [showInviteModal, setShowInviteModal] = useState(false);
    const [copied, setCopied] = useState(false);
    const [form, setForm] = useState<any>({});
    const [friends, setFriends] = useState<any[]>([]);
    const [inviteStatus, setInviteStatus] = useState<Record<string, string>>({});
    const [isGM, setIsGM] = useState(false);

    const EMPTY_SESSION = { title: '', date: '', endDate: '', location: '', isOnline: false, agenda: '', createDiscordEvent: false, createGoogleEvent: false };
    const [showSessionModal, setShowSessionModal] = useState(false);
    const [sessionForm, setSessionForm] = useState<any>(EMPTY_SESSION);
    const [savingSession, setSavingSession] = useState(false);
    const [sessionError, setSessionError] = useState<string | null>(null);
    const [sessionWarnings, setSessionWarnings] = useState<string[]>([]);

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
            setForm({ title: c.title, description: c.description || '', status: c.status, startDate: toDateInput(c.startDate), endDate: toDateInput(c.endDate), discordGuildId: c.discordGuildId || '', discordChannelId: c.discordChannelId || '' });
            if (sessRes.ok) setSessions(await sessRes.json());
            if (membRes.ok) {
                const memberRows = await membRes.json();
                setMembers(memberRows);
                setIsGM(computeIsGM(memberRows));
            }
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

    const handleCreateSession = async (e: React.FormEvent) => {
        e.preventDefault();
        // External events need both start and end times
        if ((sessionForm.createDiscordEvent || sessionForm.createGoogleEvent)) {
            if (!sessionForm.date || !sessionForm.endDate) {
                setSessionError('Start and end date/time are required for Discord or Google Calendar events');
                return;
            }
            if (new Date(sessionForm.endDate) <= new Date(sessionForm.date)) {
                setSessionError('End time must be after the start time');
                return;
            }
            if (sessionForm.createDiscordEvent && !campaign.discordChannelId && !sessionForm.location.trim() && !sessionForm.isOnline) {
                setSessionError('Discord events need a location — enter one or mark the session as online');
                return;
            }
        }
        setSavingSession(true);
        setSessionError(null);
        try {
            const res = await fetch('/api/tabletop/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
                body: JSON.stringify({ ...sessionForm, campaign: id }),
            });
            if (res.ok) {
                const created = await res.json();
                setSessionWarnings(created.warnings || []);
                setSessions(prev => [created, ...prev].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()));
                setShowSessionModal(false);
                setSessionForm(EMPTY_SESSION);
            } else {
                const err = await res.json().catch(() => ({}));
                setSessionError(err.error || 'Failed to create session');
            }
        } catch {
            setSessionError('Failed to create session');
        } finally {
            setSavingSession(false);
        }
    };

    const needsTimes = sessionForm.createDiscordEvent || sessionForm.createGoogleEvent;
    const needsLocation = sessionForm.createDiscordEvent && !campaign?.discordChannelId && !sessionForm.isOnline;

    const inviteUrl = typeof window !== 'undefined' ? `${window.location.origin}/game-night/join/${id}` : '';

    const handleCopyInvite = () => {
        navigator.clipboard.writeText(inviteUrl);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    // Load friends when the invite modal opens (for direct invites).
    useEffect(() => {
        if (!showInviteModal) return;
        fetch('/api/friends/list', { headers: { Authorization: `Bearer ${token()}` } })
            .then(res => res.ok ? res.json() : [])
            .then(setFriends)
            .catch(() => setFriends([]));
    }, [showInviteModal]);

    const handleInviteFriend = async (friendId: string) => {
        setInviteStatus(prev => ({ ...prev, [friendId]: 'sending' }));
        try {
            const res = await fetch('/api/campaign-invites', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
                body: JSON.stringify({ campaignId: id, toUserId: friendId }),
            });
            if (res.ok) {
                setInviteStatus(prev => ({ ...prev, [friendId]: 'sent' }));
            } else {
                const err = await res.json().catch(() => ({}));
                setInviteStatus(prev => ({ ...prev, [friendId]: err.error || 'failed' }));
            }
        } catch {
            setInviteStatus(prev => ({ ...prev, [friendId]: 'failed' }));
        }
    };

    if (loading) return <div className="min-h-screen flex items-center justify-center"><span className="text-3xl font-permanent text-teal-600 animate-pulse">LOADING CAMPAIGN...</span></div>;
    if (!campaign) return null;

    return (
        <div className="min-h-[calc(100vh-76px)] flex flex-col">
            <div className="flex-grow w-full max-w-4xl mx-auto p-4 sm:p-6 md:p-12">

                <div className="mb-8">
                    <Link href="/game-night" className="inline-flex items-center gap-2 px-4 py-2 bg-yellow-400 text-black border-4 border-black font-permanent text-sm shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-white transition-colors uppercase w-fit">
                        <ArrowLeft className="w-4 h-4" /> BACK TO GAME NIGHT
                    </Link>
                </div>

                {/* Header */}
                <div className="mb-8 pb-6 border-b-8 border-black flex flex-wrap items-start justify-between gap-4">
                    <div className="flex items-start gap-3 sm:gap-4 min-w-0 flex-1">
                        <div className="p-3 bg-teal-500 border-4 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] shrink-0">
                            <Map className="w-6 h-6 sm:w-8 sm:h-8 text-white" />
                        </div>
                        <div className="min-w-0">
                            <p className="font-permanent text-xs text-zinc-400 uppercase mb-1">Campaign</p>
                            <h1 className="text-2xl sm:text-3xl md:text-4xl font-permanent text-black dark:text-white uppercase leading-tight break-words">{campaign.title}</h1>
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
                        <div className="pt-2 border-t-2 border-white/10">
                            <p className="font-permanent text-xs text-teal-400 uppercase mb-3">Discord Integration</p>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label className={LABEL_CLS}>Discord Server ID</label>
                                    <input className={INPUT_CLS} placeholder="123456789012345678" value={form.discordGuildId} onChange={e => setForm({ ...form, discordGuildId: e.target.value.trim() })} />
                                </div>
                                <div>
                                    <label className={LABEL_CLS}>Voice Channel ID (Optional)</label>
                                    <input className={INPUT_CLS} placeholder="123456789012345678" value={form.discordChannelId} onChange={e => setForm({ ...form, discordChannelId: e.target.value.trim() })} />
                                </div>
                            </div>
                            <p className="text-[10px] text-zinc-500 mt-2 font-permanent uppercase leading-relaxed">
                                Enables Discord event creation for new sessions. Your bot (token in your API Key Vault under "discord") must be in this server with Manage Events. With a voice channel ID, events are voice events; without one, external events using the session location. Right-click the server/channel with Developer Mode on to copy IDs.
                            </p>
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
                        <div className="pt-4 border-t-2 border-black/10 dark:border-white/10 flex flex-wrap gap-x-10 gap-y-3">
                            <div>
                                <p className="font-permanent text-xs text-zinc-400 uppercase mb-1">Created</p>
                                <p className="font-permanent text-black dark:text-white uppercase text-sm">{new Date(campaign.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }).toUpperCase()}</p>
                            </div>
                            <div>
                                <p className="font-permanent text-xs text-zinc-400 uppercase mb-1">Discord Server</p>
                                <p className="font-permanent text-black dark:text-white uppercase text-sm">
                                    {campaign.discordGuildId ? `LINKED${campaign.discordChannelId ? ' (VOICE CHANNEL)' : ''}` : 'NOT LINKED'}
                                </p>
                            </div>
                        </div>
                    </div>
                )}

                {/* Table Talk + Players */}
                <div className="flex flex-col lg:flex-row gap-6 mb-10">
                    {/* Players sidebar */}
                    <div className="lg:w-64 shrink-0">
                        <div className="flex items-center justify-between mb-4">
                            <h2 className="text-2xl font-permanent text-black dark:text-white uppercase flex items-center gap-2">
                                <Users className="w-5 h-5 text-yellow-500" /> Players <span className="ml-1 text-sm text-zinc-400">({members.length})</span>
                            </h2>
                            <button
                                onClick={() => setShowInviteModal(true)}
                                className="flex items-center gap-2 px-3 py-1.5 border-2 border-black bg-yellow-400 text-black font-permanent uppercase text-xs hover:bg-white transition-colors shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]"
                            >
                                <UserPlus className="w-3 h-3" /> INVITE
                            </button>
                        </div>
                        {members.length === 0 ? (
                            <div className="py-10 border-4 border-dashed border-zinc-300 dark:border-zinc-700 text-center">
                                <Users className="w-10 h-10 text-zinc-300 dark:text-zinc-600 mx-auto mb-2" />
                                <p className="font-permanent text-sm text-zinc-400 uppercase">No players yet.</p>
                            </div>
                        ) : (
                            <div className="space-y-2">
                                {members.map(m => {
                                    const row = (
                                        <>
                                            <div className={`p-1.5 border-2 border-black shrink-0 ${m.status === 'Game Master' ? 'bg-yellow-400' : 'bg-teal-500'}`}>
                                                {m.status === 'Game Master' ? <Crown className="w-4 h-4 text-black" /> : <Shield className="w-4 h-4 text-white" />}
                                            </div>
                                            <div className="flex-grow min-w-0">
                                                <p className="font-permanent text-sm text-black dark:text-white uppercase truncate">{memberName(m)}</p>
                                                {m.status && <p className="text-xs font-permanent text-teal-600 dark:text-yellow-400 uppercase">{m.status}</p>}
                                            </div>
                                        </>
                                    );
                                    const cls = "flex items-center gap-3 p-3 border-4 border-black bg-white dark:bg-slate-800 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]";
                                    return m.playerId ? (
                                        <Link key={m._id} href={`/players/${m.playerId}`} className={`${cls} hover:-translate-y-0.5 transition-transform`} title="View profile">
                                            {row}
                                        </Link>
                                    ) : (
                                        <div key={m._id} className={cls}>{row}</div>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    {/* Live campaign chat (event bus → SSE) */}
                    <div className="flex-grow min-w-0">
                        <CampaignChat campaignId={id} />
                    </div>
                </div>

                {/* Sessions */}
                <div>
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-2xl font-permanent text-black dark:text-white uppercase flex items-center gap-2">
                            <Book className="w-5 h-5 text-teal-500" /> Sessions <span className="ml-1 text-sm text-zinc-400">({sessions.length})</span>
                        </h2>
                        {isGM && (
                            <button
                                onClick={() => { setSessionForm(EMPTY_SESSION); setSessionError(null); setShowSessionModal(true); }}
                                className="flex items-center gap-2 px-3 py-1.5 border-2 border-black bg-yellow-400 text-black font-permanent uppercase text-xs hover:bg-white transition-colors shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]"
                            >
                                <Plus className="w-3 h-3" /> ADD SESSION
                            </button>
                        )}
                    </div>
                    {sessionWarnings.length > 0 && (
                        <div className="mb-4 p-3 border-4 border-black bg-yellow-100 dark:bg-yellow-900/40 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]">
                            <div className="flex justify-between items-start gap-2">
                                <div className="space-y-1">
                                    {sessionWarnings.map((w, i) => (
                                        <p key={i} className="font-permanent text-xs text-yellow-800 dark:text-yellow-200 uppercase">{w}</p>
                                    ))}
                                </div>
                                <button onClick={() => setSessionWarnings([])} className="text-zinc-500 hover:text-black dark:hover:text-white shrink-0"><X className="w-4 h-4" /></button>
                            </div>
                        </div>
                    )}
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
                                            {s.isOnline && (
                                                <span className="flex items-center gap-1 px-1.5 text-xs font-permanent uppercase border-2 border-black bg-teal-500 text-white">
                                                    <Wifi className="w-3 h-3" /> ONLINE
                                                </span>
                                            )}
                                        </div>
                                        {s.summary && <p className="mt-1 text-xs font-permanent text-zinc-500 dark:text-zinc-400 uppercase line-clamp-1">{s.summary}</p>}
                                    </div>
                                    <ChevronRight className="w-4 h-4 text-zinc-300 dark:text-zinc-600 shrink-0 self-center group-hover:text-teal-500 transition-colors" />
                                </Link>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Add Session Modal */}
            {showSessionModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={() => setShowSessionModal(false)}>
                    <form
                        onSubmit={handleCreateSession}
                        className="w-full max-w-md bg-slate-900 border-4 border-black shadow-[8px_8px_0px_0px_rgba(13,148,136,1)] p-6 space-y-4 max-h-[90vh] overflow-y-auto"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between">
                            <h2 className="font-permanent text-lg text-white uppercase flex items-center gap-2">
                                <Plus className="w-5 h-5 text-teal-400" /> Add Session
                            </h2>
                            <button type="button" onClick={() => setShowSessionModal(false)} className="text-zinc-400 hover:text-white transition-colors">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div><label className={LABEL_CLS}>Title *</label><input required className={INPUT_CLS} value={sessionForm.title} onChange={e => setSessionForm({ ...sessionForm, title: e.target.value })} /></div>
                        <div className="grid grid-cols-2 gap-4">
                            <div><label className={LABEL_CLS}>Starts {needsTimes && '*'}</label><input required={needsTimes} type="datetime-local" className={INPUT_CLS} value={sessionForm.date} onChange={e => setSessionForm({ ...sessionForm, date: e.target.value })} /></div>
                            <div><label className={LABEL_CLS}>Ends {needsTimes && '*'}</label><input required={needsTimes} type="datetime-local" className={INPUT_CLS} value={sessionForm.endDate} onChange={e => setSessionForm({ ...sessionForm, endDate: e.target.value })} /></div>
                        </div>
                        <div><label className={LABEL_CLS}>Location {needsLocation && '*'}</label><input required={needsLocation} className={INPUT_CLS} placeholder={sessionForm.isOnline ? 'ONLINE' : "GEOFF'S BASEMENT"} value={sessionForm.location} onChange={e => setSessionForm({ ...sessionForm, location: e.target.value })} /></div>
                        <Toggle
                            on={sessionForm.isOnline}
                            onClick={() => setSessionForm({ ...sessionForm, isOnline: !sessionForm.isOnline })}
                            label="Online Session"
                            icon={<Wifi className={`w-3 h-3 ${sessionForm.isOnline ? 'text-teal-400' : 'text-zinc-500'}`} />}
                        />
                        <div><label className={LABEL_CLS}>Agenda / Prep Notes</label><textarea className={INPUT_CLS} rows={3} value={sessionForm.agenda} onChange={e => setSessionForm({ ...sessionForm, agenda: e.target.value })} /></div>
                        <div className="pt-3 border-t-2 border-white/10 space-y-3">
                            <p className="font-permanent text-xs text-teal-400 uppercase">External Events</p>
                            <Toggle
                                on={sessionForm.createDiscordEvent}
                                onClick={() => setSessionForm({ ...sessionForm, createDiscordEvent: !sessionForm.createDiscordEvent })}
                                label={campaign.discordGuildId ? 'Create Discord Event' : 'Create Discord Event (link a server on this campaign first)'}
                            />
                            <Toggle
                                on={sessionForm.createGoogleEvent}
                                onClick={() => setSessionForm({ ...sessionForm, createGoogleEvent: !sessionForm.createGoogleEvent })}
                                label="Create Google Calendar Event"
                            />
                            {(sessionForm.createDiscordEvent || sessionForm.createGoogleEvent) && (
                                <p className="text-[10px] text-zinc-500 font-permanent uppercase leading-relaxed">
                                    External events require start and end times{sessionForm.createDiscordEvent && !campaign.discordChannelId ? ', and Discord needs a location (or online)' : ''}. The agenda becomes the event description.
                                </p>
                            )}
                        </div>
                        {sessionError && <p className="font-permanent text-xs text-red-400 uppercase">{sessionError}</p>}
                        <div className="flex gap-3 pt-2">
                            <button type="submit" disabled={savingSession} className="flex-1 flex items-center justify-center gap-2 p-3 border-4 border-black bg-teal-600 text-white font-permanent uppercase hover:bg-teal-500 transition-colors disabled:opacity-50">
                                <Save className="w-4 h-4" /> {savingSession ? 'CREATING...' : 'CREATE SESSION'}
                            </button>
                            <button type="button" onClick={() => setShowSessionModal(false)} className="px-6 p-3 border-4 border-black bg-zinc-700 text-white font-permanent uppercase hover:bg-zinc-600 transition-colors">CANCEL</button>
                        </div>
                    </form>
                </div>
            )}

            {/* Invite Modal */}
            {showInviteModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={() => { setShowInviteModal(false); setCopied(false); }}>
                    <div className="w-full max-w-md bg-slate-900 border-4 border-black shadow-[8px_8px_0px_0px_rgba(13,148,136,1)] p-6 space-y-5 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between">
                            <h2 className="font-permanent text-lg text-white uppercase flex items-center gap-2">
                                <UserPlus className="w-5 h-5 text-teal-400" /> Invite Players
                            </h2>
                            <button onClick={() => { setShowInviteModal(false); setCopied(false); }} className="text-zinc-400 hover:text-white transition-colors">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <p className="font-permanent text-xs text-zinc-400 uppercase">Share this link to invite friends to join the campaign.</p>
                        <div className="flex items-center gap-0 border-4 border-black">
                            <div className="p-3 bg-teal-500 border-r-4 border-black shrink-0">
                                <Link2 className="w-4 h-4 text-white" />
                            </div>
                            <input
                                readOnly
                                value={inviteUrl}
                                className="flex-1 p-3 bg-white text-black font-permanent text-xs uppercase outline-none truncate"
                                onFocus={e => e.target.select()}
                            />
                        </div>
                        <button
                            onClick={handleCopyInvite}
                            className={`w-full flex items-center justify-center gap-2 p-3 border-4 border-black font-permanent uppercase text-sm transition-colors shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] ${copied ? 'bg-teal-500 text-white' : 'bg-yellow-400 text-black hover:bg-white'}`}
                        >
                            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                            {copied ? 'LINK COPIED!' : 'COPY INVITE LINK'}
                        </button>

                        <div className="pt-4 border-t-2 border-white/10">
                            <p className="font-permanent text-xs text-teal-400 uppercase mb-3">Or invite a friend directly</p>
                            {friends.length === 0 ? (
                                <p className="font-permanent text-xs text-zinc-500 uppercase">No friends yet — add some from the Social Hub.</p>
                            ) : (
                                <div className="space-y-2 max-h-48 overflow-y-auto">
                                    {friends.map((f: any) => {
                                        const status = inviteStatus[f._id];
                                        return (
                                            <div key={f._id} className="flex items-center gap-3 p-2 border-2 border-black bg-zinc-800">
                                                <div className="min-w-0 flex-grow">
                                                    <p className="font-permanent text-xs text-white uppercase truncate">@{f.handle}</p>
                                                    <p className="font-permanent text-[10px] text-zinc-500">#{f.userNumber}</p>
                                                </div>
                                                <button
                                                    onClick={() => handleInviteFriend(f._id)}
                                                    disabled={status === 'sending' || status === 'sent'}
                                                    className={`px-3 py-1.5 border-2 border-black font-permanent text-[10px] uppercase transition-colors shrink-0 ${
                                                        status === 'sent'
                                                            ? 'bg-teal-500 text-white'
                                                            : 'bg-yellow-400 text-black hover:bg-white disabled:opacity-50'
                                                    }`}
                                                >
                                                    {status === 'sent' ? 'INVITED!' : status === 'sending' ? '...' : 'INVITE'}
                                                </button>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                            {Object.values(inviteStatus).some(s => s !== 'sent' && s !== 'sending') && (
                                <p className="mt-2 font-permanent text-[10px] text-red-400 uppercase">
                                    {Object.entries(inviteStatus).find(([, s]) => s !== 'sent' && s !== 'sending')?.[1]}
                                </p>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
