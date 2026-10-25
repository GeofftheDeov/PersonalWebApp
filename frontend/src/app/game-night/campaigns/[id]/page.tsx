"use client";

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { Map, ArrowLeft, Calendar, Book, Users, Shield, ChevronRight, Crown, Save, X, Pencil, UserPlus, Check, Copy, Link2, Plus, Wifi, Flame, ImagePlus, Sword, UserCheck, UserMinus, LogOut, Moon } from 'lucide-react';
import CampaignChat from '@/components/CampaignChat';
import CampaignCharacters from '@/components/CampaignCharacters';
import { memberName, type MemberPerson } from '@/lib/memberName';
import CampaignBanner from '@/components/CampaignBanner';
import BannerEditor from '@/components/BannerEditor';
import NoticeBoard, { ComingUp, useNoticeBoard } from '@/components/NoticeBoard';
import { sessionWhen } from '@/lib/sessions';
import { DEFAULT_GM_TITLE, gmTitleOf, roleLabel } from '@/lib/campaigns';
import { canAdmin, fetchCapabilities } from '@/lib/capabilities';

interface Session {
    _id: string;
    title: string;
    date: string;
    location?: string;
    isOnline?: boolean;
    summary?: string;
    status?: string;
    gmOverride?: string | null;
    /** Players recorded as there (#37). */
    attendeeCount?: number;
    /** Set once the GM has taken attendance, even if nobody came. */
    attendanceConfirmedAt?: string | null;
}

interface Member {
    _id: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    status?: string;
    playerId?: string | null;
    person?: MemberPerson | null;
    /** False once a GM has deactivated them here (#37). Only GMs and admins are sent inactive members. */
    isActive?: boolean;
}

const INPUT_CLS = "w-full p-3 border-4 border-black bg-white text-black font-permanent text-base uppercase focus:border-yellow-400 outline-none";
const LABEL_CLS = "block text-teal-400 font-permanent uppercase text-xs mb-1";

const statusColor = (status: string) => {
    if (status === 'In Progress') return 'bg-teal-500 text-white';
    if (status === 'Completed') return 'bg-zinc-600 text-white';
    return 'bg-yellow-400 text-black';
};

const toDateInput = (d?: string) => d ? new Date(d).toISOString().split('T')[0] : '';

/** Is the logged-in user the Game Master of this campaign (or an admin)? */
const computeIsGM = (members: Member[]) => {
    try {
        const me = JSON.parse(localStorage.getItem('user') || 'null');
        if (!me) return false;
        if (me.appRole === 'admin') return true;
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
    const [isOwner, setIsOwner] = useState(false);
    const [isAdmin, setIsAdmin] = useState(false);
    // Leaving, or a GM removing someone: the member row in flight, and any refusal.
    const [removingId, setRemovingId] = useState<string | null>(null);
    const [membershipError, setMembershipError] = useState<string | null>(null);
    const [settingsError, setSettingsError] = useState<string | null>(null);
    // Passing the torch permanently (#89): the chosen player while the GM is choosing, else null.
    const [torchTo, setTorchTo] = useState<string | null>(null);
    // An admin who isn't a GM names who steps down when there's more than one.
    const [torchFrom, setTorchFrom] = useState('');
    const [torchBusy, setTorchBusy] = useState(false);
    const [torchError, setTorchError] = useState<string | null>(null);
    const [showBannerEditor, setShowBannerEditor] = useState(false);
    const [recordsTab, setRecordsTab] = useState<'sessions' | 'characters'>('sessions');

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
            setForm({ title: c.title, description: c.description || '', status: c.status, startDate: toDateInput(c.startDate), endDate: toDateInput(c.endDate), discordGuildId: c.discordGuildId || '', discordChannelId: c.discordChannelId || '', quorum: c.quorum ?? '', tableLink: c.tableLink || '', gmTitle: c.gmTitle || DEFAULT_GM_TITLE });
            // Planning settings belong to the campaign's owner or an admin (#57).
            // Display only: the server enforces it.
            const me = JSON.parse(localStorage.getItem('user') || 'null');
            const caps = await fetchCapabilities(t);
            setIsOwner(Boolean((me?.id && c.owner === me.id) || canAdmin(caps)));
            setIsAdmin(canAdmin(caps));
            if (sessRes.ok) setSessions(await sessRes.json());
            if (membRes.ok) {
                const memberRows = await membRes.json();
                setMembers(memberRows);
                setIsGM(computeIsGM(memberRows));
            }
        }).catch(() => router.push('/game-night'))
          .finally(() => setLoading(false));
    }, [id, router]);

    const reloadSessions = useCallback(async () => {
        const res = await fetch(`/api/campaigns/${id}/sessions`, { headers: { Authorization: `Bearer ${token()}` } });
        if (res.ok) setSessions(await res.json());
    }, [id]);

    const reloadMembers = useCallback(async () => {
        const res = await fetch(`/api/campaigns/${id}/members`, { headers: { Authorization: `Bearer ${token()}` } });
        if (!res.ok) return;
        const memberRows = await res.json();
        setMembers(memberRows);
        setIsGM(computeIsGM(memberRows));
    }, [id]);

    // The Notice Board's data (#57), shared with Coming up and live. Re-read
    // on a GM rename or a torch pass, which change who can plan.
    const gmIds = members.filter(m => m.status === 'Game Master').map(m => m._id).join();
    const boardKey = campaign ? `${gmTitleOf(campaign)}|${gmIds}` : '';
    const board = useNoticeBoard(campaign ? id : null, { onSessionsChanged: reloadSessions, refreshKey: boardKey });

    // A pass or claim can give an admin-managed campaign its owner: show it, and
    // the owner's settings if that's the viewer.
    const setOwner = (owner: string | null) => {
        setCampaign((c: any) => ({ ...c, owner }));
        const meId = JSON.parse(localStorage.getItem('user') || 'null')?.id;
        if (owner && owner === meId) setIsOwner(true);
    };

    const handlePassTorch = async (e: React.FormEvent) => {
        e.preventDefault();
        const target = members.find(m => m.playerId === torchTo);
        if (!target) return;
        const title = gmTitleOf(campaign);
        // A GM passing it steps down themselves; an admin who isn't one names who does.
        const meId = JSON.parse(localStorage.getItem('user') || 'null')?.id;
        const gms = members.filter(m => m.status === 'Game Master' && m.playerId);
        const iAmGm = gms.some(m => m.playerId === meId);
        const from = iAmGm ? null : gms.length === 1 ? gms[0] : gms.find(m => m.playerId === torchFrom);
        if (!iAmGm && gms.length > 1 && !from) { setTorchError(`Choose which ${title} steps down.`); return; }
        const stepsDown = iAmGm ? 'you become a player' : from ? `${memberName(from)} becomes a player` : 'no one steps down';
        // An admin-managed campaign is owned by whoever first holds the torch.
        const ownership = campaign.owner ? "Ownership doesn't change." : 'They become its owner, too.';
        if (!window.confirm(`Pass the torch to ${memberName(target)}? They become the ${title} and ${stepsDown}. ${ownership}`)) return;
        setTorchBusy(true);
        setTorchError(null);
        try {
            const res = await fetch(`/api/campaigns/${id}/torch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
                body: JSON.stringify(from ? { to: torchTo, from: from.playerId } : { to: torchTo }),
            });
            if (!res.ok) { setTorchError((await res.json().catch(() => ({}))).error || 'Could not pass the torch.'); return; }
            setTorchTo(null);
            setOwner((await res.json()).owner);
            await reloadMembers();
        } catch {
            setTorchError('Could not reach the server.');
        } finally {
            setTorchBusy(false);
        }
    };

    // Claiming the torch: an admin-managed campaign with no GM lets a player take it.
    const handleClaimTorch = async () => {
        const title = gmTitleOf(campaign);
        if (!window.confirm(`Claim the torch? You become the ${title} and owner of ${campaign.title}, and plan its sessions.`)) return;
        setTorchBusy(true);
        setTorchError(null);
        try {
            const res = await fetch(`/api/campaigns/${id}/torch/claim`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token()}` },
            });
            if (!res.ok) { setTorchError((await res.json().catch(() => ({}))).error || 'Could not claim the torch.'); return; }
            setOwner((await res.json()).owner);
            await reloadMembers();
        } catch {
            setTorchError('Could not reach the server.');
        } finally {
            setTorchBusy(false);
        }
    };

    // Leave the campaign (your own row) or remove someone from it (GM). The
    // server refuses the last GM leaving while anyone else is in the party.
    const handleRemoveMember = async (member: Member, self: boolean) => {
        const question = self
            ? `Leave ${campaign.title}? You'll need the invite link to rejoin.`
            : `Remove ${memberName(member)} from ${campaign.title}?`;
        if (!window.confirm(question)) return;
        setRemovingId(member._id);
        setMembershipError(null);
        try {
            const res = await fetch(`/api/campaign-members/${member._id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token()}` },
            });
            if (!res.ok) {
                setMembershipError((await res.json().catch(() => ({}))).error || (self ? 'Could not leave the campaign.' : 'Could not remove them.'));
                return;
            }
            if (self) { router.push('/game-night'); return; }
            await reloadMembers();
        } catch {
            setMembershipError('Could not reach the server.');
        } finally {
            setRemovingId(null);
        }
    };

    // Making a player inactive here, or bringing them back (#37). GM only; the server decides.
    const [activityBusy, setActivityBusy] = useState<string | null>(null);
    const [activityError, setActivityError] = useState<string | null>(null);
    const setMemberActive = async (m: Member, active: boolean) => {
        if (!active && !window.confirm(`Make ${memberName(m)} inactive? The campaign leaves their list and they can't read or post in Table Talk. Their characters and history stay, and you can bring them back.`)) return;
        setActivityBusy(m._id);
        setActivityError(null);
        try {
            const res = await fetch(`/api/campaign-members/${m._id}/active`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
                body: JSON.stringify({ active }),
            });
            if (!res.ok) { setActivityError((await res.json().catch(() => ({}))).error || 'Could not change that.'); return; }
            await reloadMembers();
        } catch {
            setActivityError('Could not reach the server.');
        } finally {
            setActivityBusy(null);
        }
    };

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        setSettingsError(null);
        const { quorum, tableLink, gmTitle, ...details } = form;
        const res = await fetch(`/api/campaigns/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
            body: JSON.stringify(details),
        });
        if (!res.ok) { setSaving(false); return; }
        let updated = await res.json();
        let settingsOk = true;
        if (isOwner) {
            const settings = await fetch(`/api/campaigns/${id}/settings`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
                body: JSON.stringify({ quorum: quorum === '' ? null : Number(quorum), tableLink, gmTitle }),
            });
            const body = await settings.json().catch(() => ({}));
            settingsOk = settings.ok;
            updated = settings.ok
                ? { ...updated, quorum: body.quorum, tableLink: body.tableLink, gmTitle: body.gmTitle }
                : { ...updated, quorum: campaign.quorum, tableLink: campaign.tableLink, gmTitle: campaign.gmTitle };
            if (!settings.ok) setSettingsError(body.error || 'Could not save the planning settings.');
        }
        setCampaign(updated);
        if (settingsOk) setEditing(false);
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
                board.reload(); // a session still to come belongs under Coming up
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
    // The owner is separate from the Game Master (#80): who set the campaign up.
    const ownerMember = campaign.owner ? members.find(m => m.playerId === campaign.owner) : undefined;
    // Inactive players (#37) are only sent to GMs, and count for nothing but the list.
    const activeMembers = members.filter(m => m.isActive !== false);
    const inactiveMembers = members.filter(m => m.isActive === false);
    // Who the torch can pass to (#89): active party members with an account who aren't a GM already.
    const torchCandidates = activeMembers.filter(m => m.playerId && m.status !== 'Game Master');
    const gmMembers = members.filter(m => m.status === 'Game Master' && m.playerId);
    const viewerId = JSON.parse(localStorage.getItem('user') || 'null')?.id;
    const torchNeedsFrom = gmMembers.length > 1 && !gmMembers.some(m => m.playerId === viewerId);
    // An admin-managed campaign with nobody holding the torch: a player may claim it
    // (an admin passes it instead).
    const canClaimTorch = !campaign.owner && gmMembers.length === 0 && !isGM && members.some(m => m.playerId === viewerId);
    // Leaving and removing (display only: the server enforces both). A GM
    // removes players; another GM is an admin's call. The last GM passes the
    // torch before leaving anyone behind.
    const myMembership = viewerId ? members.find(m => m.playerId === viewerId) : undefined;
    const isLastGm = myMembership?.status === 'Game Master'
        && !members.some(m => m.status === 'Game Master' && m.playerId !== viewerId)
        && members.some(m => m.playerId !== viewerId);
    const canRemove = (m: Member) => m.playerId !== viewerId && (isAdmin || (isGM && m.status !== 'Game Master'));
    // Scheduled sessions still to come show under Coming up, and ones being
    // planned on the Notice Board, so this list is the campaign's past.
    const upcomingIds = new Set((board.board?.upcoming ?? []).map(u => u.id));
    const now = Date.now();
    const pastSessions = sessions.filter(s => s.status !== 'planning' && !upcomingIds.has(s._id)
        && !(s.status === 'scheduled' && s.date && new Date(s.date).getTime() > now));
    const standInName = (personId: string) => {
        const m = members.find(x => x.playerId === personId);
        return m ? memberName(m) : 'someone';
    };

    return (
        <div className="min-h-[calc(100vh-76px)] flex flex-col">
            <div className="flex-grow w-full max-w-6xl mx-auto p-4 sm:p-6 md:p-8">

                <div className="mb-8">
                    <Link href="/game-night" className="inline-flex items-center gap-2 px-4 py-2 bg-yellow-400 text-black border-4 border-black font-permanent text-sm shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-white transition-colors uppercase w-fit">
                        <ArrowLeft className="w-4 h-4" /> BACK TO GAME NIGHT
                    </Link>
                </div>

                {/* Banner (#81): the owner's image, or a fallback in the campaign's colours */}
                <CampaignBanner url={campaign.bannerUrl} seed={id} title={campaign.title} className="mb-8 border-4 border-black shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]">
                    {isOwner && (
                        <button
                            type="button"
                            onClick={() => setShowBannerEditor(true)}
                            className="absolute bottom-2 right-2 sm:bottom-3 sm:right-3 flex items-center gap-1.5 px-3 py-1.5 border-2 border-black bg-yellow-400 text-black font-permanent text-xs uppercase hover:bg-white transition-colors shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]"
                        >
                            <ImagePlus className="w-4 h-4" /> {campaign.bannerUrl ? 'Change banner' : 'Add banner'}
                        </button>
                    )}
                </CampaignBanner>
                {showBannerEditor && (
                    <BannerEditor
                        campaignId={id}
                        hasBanner={!!campaign.bannerKey}
                        onClose={() => setShowBannerEditor(false)}
                        onSaved={banner => { setCampaign((c: any) => ({ ...c, ...banner })); setShowBannerEditor(false); }}
                    />
                )}

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
                        {isOwner && (
                            <div className="pt-2 border-t-2 border-white/10">
                                <p className="font-permanent text-xs text-teal-400 uppercase mb-3">Planning</p>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <div className="sm:col-span-2">
                                        <label className={LABEL_CLS}>Game Master title</label>
                                        <input required maxLength={40} className={INPUT_CLS} placeholder={DEFAULT_GM_TITLE.toUpperCase()} value={form.gmTitle} onChange={e => setForm({ ...form, gmTitle: e.target.value })} />
                                    </div>
                                    <div>
                                        <label className={LABEL_CLS}>Quorum (players a night needs)</label>
                                        <input type="number" min={1} max={50} className={INPUT_CLS} placeholder={`WHOLE PARTY (${activeMembers.length})`} value={form.quorum} onChange={e => setForm({ ...form, quorum: e.target.value })} />
                                    </div>
                                    <div>
                                        <label className={LABEL_CLS}>Table link (online sessions)</label>
                                        <input type="url" className={INPUT_CLS + " normal-case"} placeholder="https://foundry.example/game" value={form.tableLink} onChange={e => setForm({ ...form, tableLink: e.target.value.trim() })} />
                                    </div>
                                </div>
                                <p className="text-[10px] text-zinc-500 mt-2 font-permanent uppercase leading-relaxed">
                                    The Game Master title is what this campaign calls its Game Master: Dungeon Master, Host, Organizer. Leave quorum empty to need the whole party. The table link (Foundry, Roll20, a Discord voice channel) shows on every online session.
                                </p>
                                {settingsError && <p role="alert" className="mt-2 font-permanent text-xs text-red-400 uppercase">{settingsError}</p>}
                            </div>
                        )}
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
                                <p className="font-permanent text-xs text-zinc-400 uppercase mb-1">{gmTitleOf(campaign)}</p>
                                <p className="font-permanent text-black dark:text-white uppercase text-sm">
                                    {members.filter(m => m.status === 'Game Master').map(memberName).join(', ') || 'None yet'}
                                </p>
                                {isGM && torchTo === null && torchCandidates.length > 0 && (
                                    <button type="button" onClick={() => { setTorchTo(''); setTorchError(null); }}
                                        className="mt-1 flex items-center gap-1 font-permanent text-[10px] uppercase text-orange-600 dark:text-orange-400 hover:underline">
                                        <Flame className="w-3 h-3" /> Pass the torch
                                    </button>
                                )}
                                {canClaimTorch && (
                                    <button type="button" onClick={handleClaimTorch} disabled={torchBusy}
                                        className="mt-2 flex items-center gap-1 px-2 py-1 border-2 border-black bg-orange-500 text-black font-permanent uppercase text-[10px] hover:bg-white disabled:opacity-40 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">
                                        <Flame className="w-3 h-3" /> Claim the torch
                                    </button>
                                )}
                                {torchTo !== null && (
                                    <form onSubmit={handlePassTorch} className="mt-2 flex flex-wrap items-center gap-2">
                                        <label htmlFor="torch-to" className="sr-only">New {gmTitleOf(campaign)}</label>
                                        <select id="torch-to" value={torchTo} onChange={e => setTorchTo(e.target.value)}
                                            className="p-1.5 border-2 border-black bg-white text-black font-permanent text-xs uppercase outline-none focus:border-teal-500 max-w-full">
                                            <option value="">New {gmTitleOf(campaign)}…</option>
                                            {torchCandidates.map(m => <option key={m._id} value={m.playerId!}>{memberName(m)}</option>)}
                                        </select>
                                        {torchNeedsFrom && (
                                            <>
                                                <label htmlFor="torch-from" className="sr-only">Who steps down</label>
                                                <select id="torch-from" value={torchFrom} onChange={e => setTorchFrom(e.target.value)}
                                                    className="p-1.5 border-2 border-black bg-white text-black font-permanent text-xs uppercase outline-none focus:border-teal-500 max-w-full">
                                                    <option value="">Who steps down…</option>
                                                    {gmMembers.map(m => <option key={m._id} value={m.playerId!}>{memberName(m)}</option>)}
                                                </select>
                                            </>
                                        )}
                                        <button type="submit" disabled={torchBusy || !torchTo || (torchNeedsFrom && !torchFrom)}
                                            className="flex items-center gap-1 px-2 py-1 border-2 border-black bg-orange-500 text-black font-permanent uppercase text-[10px] hover:bg-white disabled:opacity-40 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">
                                            <Flame className="w-3 h-3" /> Pass it
                                        </button>
                                        <button type="button" onClick={() => setTorchTo(null)} aria-label="Cancel" className="text-zinc-400 hover:text-black dark:hover:text-white">
                                            <X className="w-4 h-4" />
                                        </button>
                                    </form>
                                )}
                                {torchError && <p role="alert" className="mt-1 font-permanent text-[10px] text-red-600 uppercase">{torchError}</p>}
                            </div>
                            <div>
                                <p className="font-permanent text-xs text-zinc-400 uppercase mb-1">Owner</p>
                                <p className="font-permanent text-black dark:text-white uppercase text-sm">
                                    {!campaign.owner ? 'Admin-managed' : ownerMember ? memberName(ownerMember) : 'Not in the party'}
                                </p>
                            </div>
                            <div>
                                <p className="font-permanent text-xs text-zinc-400 uppercase mb-1">Quorum</p>
                                <p className="font-permanent text-black dark:text-white uppercase text-sm">{campaign.quorum ? `${campaign.quorum} of the party` : 'Whole party'}</p>
                            </div>
                            <div className="min-w-0">
                                <p className="font-permanent text-xs text-zinc-400 uppercase mb-1">Table</p>
                                {campaign.tableLink
                                    ? <a href={campaign.tableLink} target="_blank" rel="noopener noreferrer" className="font-permanent text-teal-600 dark:text-yellow-400 text-sm underline break-all">{campaign.tableLink}</a>
                                    : <p className="font-permanent text-black dark:text-white uppercase text-sm">Not set</p>}
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

                {/* The Notice Board: session planning (#57) */}
                <div id="notice-board" className="mb-10 scroll-mt-24">
                    {/* Keyed on the GM title and the GMs, so a rename or a torch pass starts its forms afresh. */}
                    <NoticeBoard key={boardKey} campaignId={id} data={board} />
                </div>

                {/* Table Talk + Players */}
                <div className="flex flex-col lg:flex-row gap-6 mb-10">
                    {/* Players sidebar */}
                    <div className="lg:w-64 shrink-0">
                        <div className="flex items-center justify-between mb-4">
                            <h2 className="text-2xl font-permanent text-black dark:text-white uppercase flex items-center gap-2">
                                <Users className="w-5 h-5 text-yellow-500" /> Players <span className="ml-1 text-sm text-zinc-400">({activeMembers.length})</span>
                            </h2>
                            <button
                                onClick={() => setShowInviteModal(true)}
                                className="flex items-center gap-2 px-3 py-1.5 border-2 border-black bg-yellow-400 text-black font-permanent uppercase text-xs hover:bg-white transition-colors shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]"
                            >
                                <UserPlus className="w-3 h-3" /> INVITE
                            </button>
                        </div>
                        {activityError && <p role="alert" className="mb-2 font-permanent text-[10px] text-red-600 uppercase">{activityError}</p>}
                        {members.length === 0 ? (
                            <div className="py-10 border-4 border-dashed border-zinc-300 dark:border-zinc-700 text-center">
                                <Users className="w-10 h-10 text-zinc-300 dark:text-zinc-600 mx-auto mb-2" />
                                <p className="font-permanent text-sm text-zinc-400 uppercase">No players yet.</p>
                            </div>
                        ) : (
                            <div className="space-y-2">
                                {activeMembers.map(m => {
                                    const row = (
                                        <>
                                            <div className={`p-1.5 border-2 border-black shrink-0 ${m.status === 'Game Master' ? 'bg-yellow-400' : 'bg-teal-500'}`}>
                                                {m.status === 'Game Master' ? <Crown className="w-4 h-4 text-black" /> : <Shield className="w-4 h-4 text-white" />}
                                            </div>
                                            <div className="flex-grow min-w-0">
                                                <p className="font-permanent text-sm text-black dark:text-white uppercase truncate">{memberName(m)}</p>
                                                {(m.status || m === ownerMember) && (
                                                    <p className="text-xs font-permanent text-teal-600 dark:text-yellow-400 uppercase">
                                                        {[roleLabel(m.status, campaign), m === ownerMember ? 'Owner' : ''].filter(Boolean).join(' · ')}
                                                    </p>
                                                )}
                                            </div>
                                        </>
                                    );
                                    // The GM's actions on this player live inside their card, beside
                                    // the profile link (a button can't sit inside the link itself).
                                    // A GM can't be made inactive: pass the torch first (#37).
                                    const canDeactivate = isGM && m.status !== 'Game Master';
                                    const actionCls = "p-1 border-2 border-black bg-white dark:bg-slate-700 disabled:opacity-40 transition-colors";
                                    return (
                                        <div key={m._id} className="flex items-center gap-2 p-3 border-4 border-black bg-white dark:bg-slate-800 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] transition-transform has-[a:hover]:-translate-y-0.5">
                                            {m.playerId ? (
                                                <Link href={`/players/${m.playerId}`} className="flex items-center gap-3 flex-grow min-w-0" title="View profile">
                                                    {row}
                                                </Link>
                                            ) : (
                                                <div className="flex items-center gap-3 flex-grow min-w-0">{row}</div>
                                            )}
                                            {(canDeactivate || canRemove(m)) && (
                                                <div className="flex items-center gap-1 shrink-0">
                                                    {canDeactivate && (
                                                        <button type="button" onClick={() => setMemberActive(m, false)} disabled={activityBusy === m._id}
                                                            aria-label={`Make ${memberName(m)} inactive`} title="Make inactive"
                                                            className={`${actionCls} text-zinc-600 dark:text-zinc-200 hover:bg-zinc-600 hover:text-white`}>
                                                            <Moon className="w-3.5 h-3.5" />
                                                        </button>
                                                    )}
                                                    {canRemove(m) && (
                                                        <button type="button" onClick={() => handleRemoveMember(m, false)} disabled={removingId !== null}
                                                            aria-label={`Remove ${memberName(m)}`} title="Remove from campaign"
                                                            className={`${actionCls} text-red-600 hover:bg-red-600 hover:text-white`}>
                                                            <UserMinus className="w-3.5 h-3.5" />
                                                        </button>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                                {inactiveMembers.length > 0 && (
                                    <div className="pt-3">
                                        <p className="font-permanent text-[10px] text-zinc-400 uppercase mb-2">Inactive ({inactiveMembers.length}), shown to GMs only</p>
                                        {inactiveMembers.map(m => (
                                            <div key={m._id} className="flex items-center gap-3 p-2 mb-2 border-2 border-dashed border-zinc-400 bg-zinc-100 dark:bg-slate-900 opacity-70">
                                                <p className="flex-grow min-w-0 font-permanent text-sm text-zinc-500 uppercase truncate">{memberName(m)}</p>
                                                <button type="button" onClick={() => setMemberActive(m, true)} disabled={activityBusy === m._id}
                                                    className="shrink-0 px-2 py-1 border-2 border-black bg-teal-500 text-white font-permanent text-[10px] uppercase hover:bg-teal-400 disabled:opacity-50">
                                                    Reactivate
                                                </button>
                                                {canRemove(m) && (
                                                    <button type="button" onClick={() => handleRemoveMember(m, false)} disabled={removingId !== null}
                                                        aria-label={`Remove ${memberName(m)}`} title="Remove from campaign"
                                                        className="shrink-0 p-1 border-2 border-black bg-white text-red-600 hover:bg-red-600 hover:text-white disabled:opacity-40">
                                                        <UserMinus className="w-3 h-3" />
                                                    </button>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                        {myMembership && (
                            <div className="mt-4">
                                {isLastGm ? (
                                    <p className="font-permanent text-[10px] text-zinc-400 uppercase">
                                        You&apos;re the only {gmTitleOf(campaign)}: pass the torch before you leave.
                                    </p>
                                ) : (
                                    <button type="button" onClick={() => handleRemoveMember(myMembership, true)} disabled={removingId !== null}
                                        className="flex items-center gap-2 px-3 py-1.5 border-2 border-black bg-white dark:bg-slate-800 text-red-600 font-permanent uppercase text-xs hover:bg-red-600 hover:text-white disabled:opacity-40 transition-colors shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">
                                        <LogOut className="w-3 h-3" /> Leave campaign
                                    </button>
                                )}
                            </div>
                        )}
                        {membershipError && <p role="alert" className="mt-2 font-permanent text-[10px] text-red-600 uppercase">{membershipError}</p>}
                    </div>

                    {/* Live campaign chat (event bus → SSE) */}
                    <div className="flex-grow min-w-0">
                        <CampaignChat campaignId={id} />
                    </div>
                </div>

                {/* Sessions | Characters (#36) */}
                <div role="tablist" aria-label="Campaign records" className="flex gap-0 mb-6 border-b-4 border-black">
                    {(['sessions', 'characters'] as const).map(tab => (
                        <button
                            key={tab}
                            type="button"
                            role="tab"
                            id={`tab-${tab}`}
                            aria-selected={recordsTab === tab}
                            aria-controls={`panel-${tab}`}
                            onClick={() => setRecordsTab(tab)}
                            className={`flex items-center gap-2 px-4 py-2 border-4 border-b-0 border-black font-permanent uppercase text-sm -mb-[4px] transition-colors ${recordsTab === tab ? 'bg-yellow-400 text-black' : 'bg-white dark:bg-slate-800 text-zinc-500 hover:text-black dark:hover:text-white'}`}
                        >
                            {tab === 'sessions' ? <Book className="w-4 h-4" /> : <Sword className="w-4 h-4" />} {tab}
                        </button>
                    ))}
                </div>

                {recordsTab === 'characters' && (
                    <div role="tabpanel" id="panel-characters" aria-labelledby="tab-characters">
                        <CampaignCharacters campaignId={id} />
                    </div>
                )}

                {/* Sessions: what's coming up beside what's been played */}
                <div role="tabpanel" id="panel-sessions" aria-labelledby="tab-sessions" className={`${recordsTab === 'sessions' ? 'grid' : 'hidden'} grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-6 items-start`}>
                <ComingUp campaignId={id} data={board} />
                <div>
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-2xl font-permanent text-black dark:text-white uppercase flex items-center gap-2">
                            <Book className="w-5 h-5 text-teal-500" /> Previous sessions <span className="ml-1 text-sm text-zinc-400">({pastSessions.length})</span>
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
                    {pastSessions.length === 0 ? (
                        <div className="py-10 border-4 border-dashed border-zinc-300 dark:border-zinc-700 text-center">
                            <Book className="w-10 h-10 text-zinc-300 dark:text-zinc-600 mx-auto mb-2" />
                            <p className="font-permanent text-sm text-zinc-400 uppercase">No sessions logged yet.</p>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {pastSessions.map(s => (
                                <Link key={s._id} href={`/game-night/sessions/${s._id}`} className="flex gap-4 p-4 border-4 border-black bg-white dark:bg-slate-800 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 transition-transform items-start group block">
                                    <div className="p-2 bg-teal-500 border-2 border-black shrink-0"><Book className="w-4 h-4 text-white" /></div>
                                    <div className="flex-grow min-w-0">
                                        <h3 className="font-permanent text-sm text-black dark:text-white uppercase group-hover:text-teal-600 transition-colors truncate">{s.title}</h3>
                                        <div className="flex gap-3 mt-1 flex-wrap">
                                            <span className={`text-xs font-permanent uppercase ${s.status === 'planning' ? 'px-1.5 border-2 border-black bg-yellow-400 text-black' : s.status === 'cancelled' ? 'text-zinc-400 line-through' : 'text-teal-600 dark:text-yellow-400'}`}>{sessionWhen(s, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                                            {s.location && <span className="text-xs font-permanent text-zinc-400 uppercase">{s.location}</span>}
                                            {s.isOnline && (
                                                <span className="flex items-center gap-1 px-1.5 text-xs font-permanent uppercase border-2 border-black bg-teal-500 text-white">
                                                    <Wifi className="w-3 h-3" /> ONLINE
                                                </span>
                                            )}
                                            {s.attendeeCount !== undefined && s.status !== 'cancelled' && (
                                                <span className="flex items-center gap-1 text-xs font-permanent uppercase text-zinc-500 dark:text-zinc-400" title="Players the GM marked as there">
                                                    <UserCheck className="w-3 h-3" /> {s.attendanceConfirmedAt || s.attendeeCount > 0 ? `${s.attendeeCount} attended` : 'Attendance not taken'}
                                                </span>
                                            )}
                                            {s.gmOverride && (
                                                <span className="flex items-center gap-1 text-xs font-permanent uppercase text-orange-600 dark:text-orange-400">
                                                    <Flame className="w-3 h-3" /> {gmTitleOf(campaign)} for this session: {standInName(s.gmOverride)}
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
