"use client";

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sword, Book, Map, Plus, Save, Shield, X, ChevronRight, Skull, Star } from 'lucide-react';
import Footer from '@/components/Footer';
import Link from 'next/link';

interface Campaign {
    _id: string;
    title: string;
    description: string;
    status: string;
    startDate: string;
    endDate: string;
}

interface Session {
    _id: string;
    title: string;
    date: string;
    campaign?: { _id: string; title: string };
    summary?: string;
}

interface Character {
    _id: string;
    name: string;
    class: string;
    level: number;
    isDead: boolean;
    campaign?: { _id: string; title: string };
}

const INPUT_CLS = "w-full p-3 border-4 border-black bg-white text-black font-permanent text-lg uppercase focus:border-yellow-400 outline-none";
const LABEL_CLS = "block text-teal-400 font-permanent uppercase text-sm mb-1";

const MODAL_CLS = "fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4";
const FORM_CLS = "w-full max-w-lg bg-slate-900 border-4 border-black shadow-[10px_10px_0px_0px_rgba(13,148,136,1)] p-8 overflow-y-auto max-h-[90vh]";
const BTN_SUBMIT = "flex-1 flex items-center justify-center gap-2 p-4 border-4 border-black bg-teal-600 text-white font-permanent text-lg uppercase hover:bg-teal-500 transition-colors shadow-[4px_4px_0px_0px_rgba(255,255,255,1)]";
const BTN_CANCEL = "px-6 p-4 border-4 border-black bg-zinc-700 text-white font-permanent text-lg uppercase hover:bg-zinc-600 transition-colors";

export default function GameNightPage() {
    const router = useRouter();
    const [tab, setTab] = useState<'campaigns' | 'sessions' | 'characters'>('campaigns');
    const [campaigns, setCampaigns] = useState<Campaign[]>([]);
    const [sessions, setSessions] = useState<Session[]>([]);
    const [characters, setCharacters] = useState<Character[]>([]);
    const [loading, setLoading] = useState(true);

    const [showCreateCampaign, setShowCreateCampaign] = useState(false);
    const [showCreateSession, setShowCreateSession] = useState(false);
    const [showCreateCharacter, setShowCreateCharacter] = useState(false);

    const [campaignForm, setCampaignForm] = useState({
        title: '', description: '', status: 'Not Started', startDate: '', endDate: ''
    });
    const [sessionForm, setSessionForm] = useState({
        title: '', campaignId: '', date: '', location: '', agenda: '', summary: ''
    });
    const [characterForm, setCharacterForm] = useState({
        name: '', class: '', level: 1, campaignId: '', gameType: ''
    });

    const fetchAll = async () => {
        const token = localStorage.getItem('token');
        if (!token) { router.push('/login'); return; }
        setLoading(true);
        try {
            const [campRes, sessRes, charRes] = await Promise.all([
                fetch('/api/campaigns', { headers: { Authorization: `Bearer ${token}` } }),
                fetch('/api/tabletop/sessions', { headers: { Authorization: `Bearer ${token}` } }),
                fetch('/api/tabletop/characters', { headers: { Authorization: `Bearer ${token}` } }),
            ]);
            if (campRes.status === 401 || sessRes.status === 401 || charRes.status === 401) {
                localStorage.clear();
                router.push('/login');
                return;
            }
            if (campRes.ok) setCampaigns(await campRes.json());
            if (sessRes.ok) setSessions(await sessRes.json());
            if (charRes.ok) setCharacters(await charRes.json());
        } catch (err) {
            console.error('Failed to fetch game night data:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { fetchAll(); }, []);

    const handleCreateCampaign = async (e: React.FormEvent) => {
        e.preventDefault();
        const token = localStorage.getItem('token');
        const res = await fetch('/api/campaigns', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(campaignForm),
        });
        if (res.ok) {
            setShowCreateCampaign(false);
            setCampaignForm({ title: '', description: '', status: 'Not Started', startDate: '', endDate: '' });
            fetchAll();
        }
    };

    const handleCreateSession = async (e: React.FormEvent) => {
        e.preventDefault();
        const token = localStorage.getItem('token');
        const userStr = localStorage.getItem('user');
        const user = userStr ? JSON.parse(userStr) : {};
        const res = await fetch('/api/tabletop/prepare-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({
                title: sessionForm.title,
                campaignId: sessionForm.campaignId,
                date: sessionForm.date,
                location: sessionForm.location,
                agenda: sessionForm.agenda,
                summary: sessionForm.summary,
                ownerId: user.id || user._id,
                ownerName: user.name,
            }),
        });
        if (res.ok) {
            setShowCreateSession(false);
            setSessionForm({ title: '', campaignId: '', date: '', location: '', agenda: '', summary: '' });
            fetchAll();
        }
    };

    const handleCreateCharacter = async (e: React.FormEvent) => {
        e.preventDefault();
        const token = localStorage.getItem('token');
        const userStr = localStorage.getItem('user');
        const user = userStr ? JSON.parse(userStr) : {};
        const res = await fetch('/api/tabletop/characters', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({
                name: characterForm.name,
                class: characterForm.class,
                level: characterForm.level,
                campaign: characterForm.campaignId || undefined,
                gameType: characterForm.gameType,
                player: user.id || user._id,
            }),
        });
        if (res.ok) {
            setShowCreateCharacter(false);
            setCharacterForm({ name: '', class: '', level: 1, campaignId: '', gameType: '' });
            fetchAll();
        }
    };

    const statusColor = (status: string) => {
        if (status === 'In Progress') return 'bg-teal-500 text-white';
        if (status === 'Completed') return 'bg-zinc-600 text-white';
        return 'bg-yellow-400 text-black';
    };

    const tabs = [
        { id: 'campaigns', label: 'CAMPAIGNS', icon: <Map className="w-5 h-5" /> },
        { id: 'sessions', label: 'SESSIONS', icon: <Book className="w-5 h-5" /> },
        { id: 'characters', label: 'CHARACTERS', icon: <Sword className="w-5 h-5" /> },
    ] as const;

    const createButton = (onClick: () => void, label: string, id: string) => (
        <button
            id={id}
            onClick={onClick}
            className="flex items-center gap-2 px-6 py-3 border-4 border-black bg-yellow-400 text-black font-permanent text-xl uppercase hover:bg-white transition-colors shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]"
        >
            <Plus className="w-5 h-5" /> {label}
        </button>
    );

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <span className="text-4xl font-permanent text-teal-600 animate-pulse">LOADING GAME NIGHT...</span>
            </div>
        );
    }

    return (
        <div className="min-h-[calc(100vh-76px)] flex flex-col">
            <div className="flex-grow w-full max-w-6xl mx-auto p-6 md:p-12">

                {/* Header */}
                <header className="mb-10 flex flex-col md:flex-row md:items-end justify-between gap-6 border-b-8 border-black pb-6">
                    <div>
                        <p className="text-teal-600 font-permanent uppercase text-sm tracking-widest mb-1">
                            <Link href="/dashboard" className="hover:text-yellow-400 transition-colors">← DASHBOARD</Link>
                        </p>
                        <h1 className="text-5xl md:text-7xl font-permanent text-black dark:text-white uppercase leading-none">
                            <span className="drop-shadow-[4px_4px_0px_rgba(13,148,136,1)]">GAME</span>{' '}
                            <span className="text-teal-600 drop-shadow-[4px_4px_0px_rgba(0,0,0,1)]">NIGHT</span>
                        </h1>
                        <p className="font-permanent text-zinc-500 dark:text-zinc-400 uppercase text-sm mt-2">
                            {campaigns.length} Campaign{campaigns.length !== 1 ? 's' : ''} &middot; {sessions.length} Session{sessions.length !== 1 ? 's' : ''} &middot; {characters.length} Character{characters.length !== 1 ? 's' : ''}
                        </p>
                    </div>
                    {tab === 'campaigns' && createButton(() => setShowCreateCampaign(true), 'NEW CAMPAIGN', 'create-campaign-btn')}
                    {tab === 'sessions' && createButton(() => setShowCreateSession(true), 'NEW SESSION', 'create-session-btn')}
                    {tab === 'characters' && createButton(() => setShowCreateCharacter(true), 'NEW CHARACTER', 'create-character-btn')}
                </header>

                {/* Tabs */}
                <div className="flex gap-2 mb-8 border-b-4 border-black">
                    {tabs.map(t => (
                        <button
                            key={t.id}
                            onClick={() => setTab(t.id)}
                            className={`flex items-center gap-2 px-5 py-3 font-permanent uppercase text-sm border-4 border-b-0 border-black transition-all ${
                                tab === t.id
                                    ? 'bg-black text-white -mb-[4px] pb-[16px]'
                                    : 'bg-white dark:bg-zinc-800 text-black dark:text-white hover:bg-zinc-100 dark:hover:bg-zinc-700'
                            }`}
                        >
                            {t.icon} {t.label}
                        </button>
                    ))}
                </div>

                {/* === CAMPAIGNS TAB === */}
                {tab === 'campaigns' && (
                    <div>
                        {campaigns.length === 0 ? (
                            <div className="text-center py-20 border-4 border-dashed border-zinc-300 dark:border-zinc-700">
                                <Map className="w-16 h-16 text-zinc-300 dark:text-zinc-600 mx-auto mb-4" />
                                <p className="font-permanent text-xl text-zinc-500 dark:text-zinc-400 uppercase">No campaigns yet.</p>
                                <p className="font-permanent text-sm text-zinc-400 dark:text-zinc-500 mt-2">Create one to get started!</p>
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                {campaigns.map(c => (
                                    <Link key={c._id} href={`/game-night/campaigns/${c._id}`} className="relative p-6 border-4 border-black bg-white dark:bg-slate-800 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-1 transition-transform group block">
                                        <div className="flex justify-between items-start mb-3">
                                            <h3 className="font-permanent text-xl text-black dark:text-white uppercase leading-tight group-hover:text-teal-600 transition-colors">{c.title}</h3>
                                            <span className={`px-2 py-1 text-xs font-permanent uppercase border-2 border-black ${statusColor(c.status)}`}>
                                                {c.status}
                                            </span>
                                        </div>
                                        <p className="text-sm font-permanent text-zinc-500 dark:text-zinc-400 uppercase mb-4 leading-relaxed">{c.description}</p>
                                        <div className="flex gap-4 text-xs font-permanent text-teal-600 dark:text-teal-400 uppercase">
                                            {c.startDate && <span>Start: {new Date(c.startDate).toLocaleDateString()}</span>}
                                            {c.endDate && <span>End: {new Date(c.endDate).toLocaleDateString()}</span>}
                                        </div>
                                        <div className="absolute bottom-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <Shield className="w-5 h-5 text-teal-400" />
                                        </div>
                                    </Link>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* === SESSIONS TAB === */}
                {tab === 'sessions' && (
                    <div className="space-y-4">
                        {sessions.length === 0 ? (
                            <div className="text-center py-20 border-4 border-dashed border-zinc-300 dark:border-zinc-700">
                                <Book className="w-16 h-16 text-zinc-300 dark:text-zinc-600 mx-auto mb-4" />
                                <p className="font-permanent text-xl text-zinc-500 dark:text-zinc-400 uppercase">No sessions logged yet.</p>
                            </div>
                        ) : (
                            sessions.map(s => (
                                <Link key={s._id} href={`/game-night/sessions/${s._id}`} className="flex gap-4 p-5 border-4 border-black bg-white dark:bg-slate-800 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 transition-transform items-start group block">
                                    <div className="p-2 bg-teal-500 border-2 border-black shrink-0">
                                        <Book className="w-5 h-5 text-white" />
                                    </div>
                                    <div className="flex-grow">
                                        <h3 className="font-permanent text-lg text-black dark:text-white uppercase group-hover:text-teal-600 transition-colors">{s.title}</h3>
                                        <div className="flex gap-3 mt-1 flex-wrap">
                                            <span className="text-xs font-permanent text-teal-600 dark:text-yellow-400 uppercase">{new Date(s.date).toLocaleDateString()}</span>
                                            {s.campaign && <span className="text-xs font-permanent text-zinc-500 dark:text-zinc-400 uppercase">{s.campaign.title}</span>}
                                        </div>
                                        {s.summary && <p className="mt-2 text-sm font-permanent text-zinc-500 dark:text-zinc-400 uppercase">{s.summary}</p>}
                                    </div>
                                    <ChevronRight className="w-5 h-5 text-zinc-300 dark:text-zinc-600 shrink-0 self-center group-hover:text-teal-500 transition-colors" />
                                </Link>
                            ))
                        )}
                    </div>
                )}

                {/* === CHARACTERS TAB === */}
                {tab === 'characters' && (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {characters.length === 0 ? (
                            <div className="col-span-3 text-center py-20 border-4 border-dashed border-zinc-300 dark:border-zinc-700">
                                <Sword className="w-16 h-16 text-zinc-300 dark:text-zinc-600 mx-auto mb-4" />
                                <p className="font-permanent text-xl text-zinc-500 dark:text-zinc-400 uppercase">No characters yet.</p>
                            </div>
                        ) : (
                            characters.map(c => (
                                <Link key={c._id} href={`/game-night/characters/${c._id}`} className={`relative block p-5 border-4 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-1 transition-transform group ${c.isDead ? 'bg-zinc-800' : 'bg-white dark:bg-slate-800'}`}>
                                    <div className="flex justify-between items-start mb-2">
                                        <h3 className={`font-permanent text-lg uppercase group-hover:text-teal-600 transition-colors ${c.isDead ? 'text-zinc-400 line-through' : 'text-black dark:text-white'}`}>{c.name}</h3>
                                        {c.isDead ? (
                                            <Skull className="w-5 h-5 text-zinc-400" />
                                        ) : (
                                            <span className="px-2 py-0.5 text-xs font-permanent bg-teal-500 text-white border-2 border-black uppercase">Ready</span>
                                        )}
                                    </div>
                                    <p className="text-sm font-permanent text-teal-600 dark:text-yellow-400 uppercase">{c.class} &middot; Level {c.level}</p>
                                    {c.campaign && <p className="text-xs font-permanent text-zinc-400 uppercase mt-1">{c.campaign.title}</p>}
                                    <div className="flex mt-3 gap-1">
                                        {Array.from({ length: Math.min(c.level, 10) }).map((_, i) => (
                                            <Star key={i} className="w-3 h-3 fill-yellow-400 text-yellow-400" />
                                        ))}
                                    </div>
                                </Link>
                            ))
                        )}
                    </div>
                )}
            </div>

            {/* === CREATE CAMPAIGN MODAL === */}
            {showCreateCampaign && (
                <div className={MODAL_CLS}>
                    <form onSubmit={handleCreateCampaign} className={FORM_CLS}>
                        <div className="flex justify-between items-center mb-6">
                            <h2 className="text-2xl font-permanent text-white uppercase flex items-center gap-2">
                                <Plus className="w-6 h-6 text-teal-400" /> New Campaign
                            </h2>
                            <button type="button" onClick={() => setShowCreateCampaign(false)} className="p-1 text-zinc-400 hover:text-white transition-colors"><X className="w-6 h-6" /></button>
                        </div>
                        <div className="space-y-4">
                            <div>
                                <label className={LABEL_CLS}>Campaign Title *</label>
                                <input required className={INPUT_CLS} placeholder="THE LOST MINES OF PHANDELVER" value={campaignForm.title} onChange={e => setCampaignForm({ ...campaignForm, title: e.target.value })} />
                            </div>
                            <div>
                                <label className={LABEL_CLS}>Description *</label>
                                <textarea required className={INPUT_CLS} rows={3} placeholder="A CLASSIC ADVENTURE AWAITS..." value={campaignForm.description} onChange={e => setCampaignForm({ ...campaignForm, description: e.target.value })} />
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className={LABEL_CLS}>Start Date *</label>
                                    <input required type="date" className={INPUT_CLS} value={campaignForm.startDate} onChange={e => setCampaignForm({ ...campaignForm, startDate: e.target.value })} />
                                </div>
                                <div>
                                    <label className={LABEL_CLS}>End Date</label>
                                    <input type="date" className={INPUT_CLS} value={campaignForm.endDate} onChange={e => setCampaignForm({ ...campaignForm, endDate: e.target.value })} />
                                </div>
                            </div>
                            <div>
                                <label className={LABEL_CLS}>Status *</label>
                                <select required className={INPUT_CLS + " appearance-none"} value={campaignForm.status} onChange={e => setCampaignForm({ ...campaignForm, status: e.target.value })}>
                                    <option value="Not Started">Not Started</option>
                                    <option value="In Progress">In Progress</option>
                                    <option value="Completed">Completed</option>
                                </select>
                            </div>
                        </div>
                        <div className="flex gap-3 mt-8">
                            <button type="submit" className={BTN_SUBMIT}><Save className="w-5 h-5" /> CREATE CAMPAIGN</button>
                            <button type="button" onClick={() => setShowCreateCampaign(false)} className={BTN_CANCEL}>CANCEL</button>
                        </div>
                    </form>
                </div>
            )}

            {/* === CREATE SESSION MODAL === */}
            {showCreateSession && (
                <div className={MODAL_CLS}>
                    <form onSubmit={handleCreateSession} className={FORM_CLS}>
                        <div className="flex justify-between items-center mb-6">
                            <h2 className="text-2xl font-permanent text-white uppercase flex items-center gap-2">
                                <Book className="w-6 h-6 text-teal-400" /> New Session
                            </h2>
                            <button type="button" onClick={() => setShowCreateSession(false)} className="p-1 text-zinc-400 hover:text-white transition-colors"><X className="w-6 h-6" /></button>
                        </div>
                        <div className="space-y-4">
                            <div>
                                <label className={LABEL_CLS}>Session Title *</label>
                                <input required className={INPUT_CLS} placeholder="THE DUNGEON OF DOOM" value={sessionForm.title} onChange={e => setSessionForm({ ...sessionForm, title: e.target.value })} />
                            </div>
                            <div>
                                <label className={LABEL_CLS}>Campaign *</label>
                                <select required className={INPUT_CLS + " appearance-none"} value={sessionForm.campaignId} onChange={e => setSessionForm({ ...sessionForm, campaignId: e.target.value })}>
                                    <option value="">--- SELECT CAMPAIGN ---</option>
                                    {campaigns.map(c => <option key={c._id} value={c._id}>{c.title}</option>)}
                                </select>
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className={LABEL_CLS}>Date & Time *</label>
                                    <input required type="datetime-local" className={INPUT_CLS} value={sessionForm.date} onChange={e => setSessionForm({ ...sessionForm, date: e.target.value })} />
                                </div>
                                <div>
                                    <label className={LABEL_CLS}>Location</label>
                                    <input className={INPUT_CLS} placeholder="GEOFF'S BASEMENT" value={sessionForm.location} onChange={e => setSessionForm({ ...sessionForm, location: e.target.value })} />
                                </div>
                            </div>
                            <div>
                                <label className={LABEL_CLS}>Agenda / Prep Notes</label>
                                <textarea className={INPUT_CLS} rows={2} placeholder="WHAT'S PLANNED FOR THIS SESSION..." value={sessionForm.agenda} onChange={e => setSessionForm({ ...sessionForm, agenda: e.target.value })} />
                            </div>
                            <div>
                                <label className={LABEL_CLS}>Summary</label>
                                <textarea className={INPUT_CLS} rows={2} placeholder="WHAT HAPPENED THIS SESSION..." value={sessionForm.summary} onChange={e => setSessionForm({ ...sessionForm, summary: e.target.value })} />
                            </div>
                        </div>
                        <div className="flex gap-3 mt-8">
                            <button type="submit" className={BTN_SUBMIT}><Save className="w-5 h-5" /> CREATE SESSION</button>
                            <button type="button" onClick={() => setShowCreateSession(false)} className={BTN_CANCEL}>CANCEL</button>
                        </div>
                    </form>
                </div>
            )}

            {/* === CREATE CHARACTER MODAL === */}
            {showCreateCharacter && (
                <div className={MODAL_CLS}>
                    <form onSubmit={handleCreateCharacter} className={FORM_CLS}>
                        <div className="flex justify-between items-center mb-6">
                            <h2 className="text-2xl font-permanent text-white uppercase flex items-center gap-2">
                                <Sword className="w-6 h-6 text-teal-400" /> New Character
                            </h2>
                            <button type="button" onClick={() => setShowCreateCharacter(false)} className="p-1 text-zinc-400 hover:text-white transition-colors"><X className="w-6 h-6" /></button>
                        </div>
                        <div className="space-y-4">
                            <div>
                                <label className={LABEL_CLS}>Character Name *</label>
                                <input required className={INPUT_CLS} placeholder="ARAGORN STONEFIST" value={characterForm.name} onChange={e => setCharacterForm({ ...characterForm, name: e.target.value })} />
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className={LABEL_CLS}>Class *</label>
                                    <input required className={INPUT_CLS} placeholder="PALADIN" value={characterForm.class} onChange={e => setCharacterForm({ ...characterForm, class: e.target.value })} />
                                </div>
                                <div>
                                    <label className={LABEL_CLS}>Level *</label>
                                    <input required type="number" min={1} max={20} className={INPUT_CLS} value={characterForm.level} onChange={e => setCharacterForm({ ...characterForm, level: Number(e.target.value) })} />
                                </div>
                            </div>
                            <div>
                                <label className={LABEL_CLS}>Game System</label>
                                <input className={INPUT_CLS} placeholder="D&D 5E" value={characterForm.gameType} onChange={e => setCharacterForm({ ...characterForm, gameType: e.target.value })} />
                            </div>
                            <div>
                                <label className={LABEL_CLS}>Campaign</label>
                                <select className={INPUT_CLS + " appearance-none"} value={characterForm.campaignId} onChange={e => setCharacterForm({ ...characterForm, campaignId: e.target.value })}>
                                    <option value="">--- NONE / UNASSIGNED ---</option>
                                    {campaigns.map(c => <option key={c._id} value={c._id}>{c.title}</option>)}
                                </select>
                            </div>
                        </div>
                        <div className="flex gap-3 mt-8">
                            <button type="submit" className={BTN_SUBMIT}><Save className="w-5 h-5" /> CREATE CHARACTER</button>
                            <button type="button" onClick={() => setShowCreateCharacter(false)} className={BTN_CANCEL}>CANCEL</button>
                        </div>
                    </form>
                </div>
            )}

            <Footer>
                <div className="inline-block border-8 border-black px-12 py-8 mb-12 bg-teal-600 shadow-[12px_12px_0px_0px_rgba(249,115,22,1)]">
                    <p className="text-3xl md:text-4xl font-permanent text-white uppercase leading-tight">
                        Roll for<br />Initiative.
                    </p>
                </div>
            </Footer>
        </div>
    );
}
