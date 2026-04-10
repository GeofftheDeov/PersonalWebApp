"use client";

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { Sword, ArrowLeft, Star, Skull, Map, User, Save, X, Pencil } from 'lucide-react';

const INPUT_CLS = "w-full p-3 border-4 border-black bg-white text-black font-permanent text-base uppercase focus:border-yellow-400 outline-none";
const LABEL_CLS = "block text-teal-400 font-permanent uppercase text-xs mb-1";

export default function CharacterDetailPage() {
    const router = useRouter();
    const params = useParams();
    const id = params?.id as string;

    const [character, setCharacter] = useState<any>(null);
    const [campaigns, setCampaigns] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [form, setForm] = useState<any>({});

    const token = () => localStorage.getItem('token');

    useEffect(() => {
        const t = token();
        if (!t) { router.push('/login'); return; }
        const headers = { Authorization: `Bearer ${t}` };
        Promise.all([
            fetch(`/api/tabletop/characters/${id}`, { headers }),
            fetch('/api/campaigns', { headers }),
        ]).then(async ([charRes, campRes]) => {
            if (charRes.status === 401) { localStorage.clear(); router.push('/login'); return; }
            if (charRes.ok) {
                const c = await charRes.json();
                setCharacter(c);
                setForm({
                    name: c.name,
                    class: c.class || '',
                    level: c.level || 1,
                    gameType: c.gameType || '',
                    campaign: c.campaign?._id || '',
                    isDead: c.isDead || false,
                });
            } else router.push('/game-night');
            if (campRes.ok) setCampaigns(await campRes.json());
        }).catch(() => router.push('/game-night'))
          .finally(() => setLoading(false));
    }, [id, router]);

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        const res = await fetch(`/api/tabletop/characters/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
            body: JSON.stringify(form),
        });
        if (res.ok) { setCharacter(await res.json()); setEditing(false); }
        setSaving(false);
    };

    if (loading) return <div className="min-h-screen flex items-center justify-center"><span className="text-3xl font-permanent text-yellow-500 animate-pulse">LOADING CHARACTER...</span></div>;
    if (!character) return null;

    const levelStars = Math.min(character.level || 1, 20);

    return (
        <div className="min-h-[calc(100vh-76px)] flex flex-col">
            <div className="flex-grow w-full max-w-3xl mx-auto p-6 md:p-12">

                <div className="mb-8">
                    <Link href="/game-night" className="flex items-center gap-1 font-permanent text-sm text-teal-600 uppercase hover:text-yellow-500 transition-colors w-fit">
                        <ArrowLeft className="w-4 h-4" /> BACK TO GAME NIGHT
                    </Link>
                </div>

                {/* Header */}
                <div className="mb-8 pb-6 border-b-8 border-black flex items-start justify-between gap-4">
                    <div className="flex items-start gap-4">
                        <div className={`p-3 border-4 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] shrink-0 ${character.isDead ? 'bg-zinc-600' : 'bg-yellow-400'}`}>
                            {character.isDead ? <Skull className="w-8 h-8 text-white" /> : <Sword className="w-8 h-8 text-black" />}
                        </div>
                        <div>
                            <p className="font-permanent text-xs text-zinc-400 uppercase mb-1">Character</p>
                            <h1 className={`text-3xl md:text-4xl font-permanent uppercase leading-tight ${character.isDead ? 'text-zinc-400 dark:text-zinc-500 line-through' : 'text-black dark:text-white'}`}>
                                {character.name}
                            </h1>
                            <div className="flex flex-wrap items-center gap-3 mt-2">
                                <span className="px-2 py-1 text-sm font-permanent uppercase border-2 border-black bg-teal-500 text-white">
                                    {character.class || '—'} · LV {character.level || 1}
                                </span>
                                {character.isDead && <span className="px-2 py-1 text-sm font-permanent uppercase border-2 border-black bg-zinc-700 text-white">DECEASED</span>}
                            </div>
                            <div className="flex flex-wrap mt-3 gap-1">
                                {Array.from({ length: levelStars }).map((_, i) => <Star key={i} className="w-4 h-4 fill-yellow-400 text-yellow-400" />)}
                            </div>
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
                    <form onSubmit={handleSave} className="mb-8 p-6 border-4 border-black bg-slate-900 shadow-[8px_8px_0px_0px_rgba(250,204,21,1)] space-y-4">
                        <div className="flex justify-between items-center mb-2">
                            <h2 className="font-permanent text-lg text-white uppercase flex items-center gap-2"><Pencil className="w-4 h-4 text-yellow-400" /> Edit Character</h2>
                            <button type="button" onClick={() => setEditing(false)} className="text-zinc-400 hover:text-white transition-colors"><X className="w-5 h-5" /></button>
                        </div>
                        <div><label className={LABEL_CLS}>Name *</label><input required className={INPUT_CLS} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
                        <div className="grid grid-cols-2 gap-4">
                            <div><label className={LABEL_CLS}>Class</label><input className={INPUT_CLS} placeholder="PALADIN" value={form.class} onChange={e => setForm({ ...form, class: e.target.value })} /></div>
                            <div><label className={LABEL_CLS}>Level</label><input type="number" min={1} max={20} className={INPUT_CLS} value={form.level} onChange={e => setForm({ ...form, level: Number(e.target.value) })} /></div>
                        </div>
                        <div><label className={LABEL_CLS}>Game System</label><input className={INPUT_CLS} placeholder="D&D 5E" value={form.gameType} onChange={e => setForm({ ...form, gameType: e.target.value })} /></div>
                        <div>
                            <label className={LABEL_CLS}>Campaign</label>
                            <select className={INPUT_CLS + " appearance-none"} value={form.campaign} onChange={e => setForm({ ...form, campaign: e.target.value })}>
                                <option value="">--- NONE / UNASSIGNED ---</option>
                                {campaigns.map(c => <option key={c._id} value={c._id}>{c.title}</option>)}
                            </select>
                        </div>
                        <div className="flex items-center gap-3 p-3 border-4 border-black bg-zinc-800">
                            <input
                                id="isDead"
                                type="checkbox"
                                className="w-5 h-5 border-2 border-black accent-red-500"
                                checked={form.isDead}
                                onChange={e => setForm({ ...form, isDead: e.target.checked })}
                            />
                            <label htmlFor="isDead" className="font-permanent text-sm text-white uppercase cursor-pointer flex items-center gap-2">
                                <Skull className="w-4 h-4 text-zinc-400" /> Mark as Deceased
                            </label>
                        </div>
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
                    <>
                        <div className="p-6 border-4 border-black bg-white dark:bg-slate-800 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] space-y-6">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                {character.campaign && (
                                    <div className="flex items-start gap-2">
                                        <Map className="w-4 h-4 text-teal-500 mt-0.5 shrink-0" />
                                        <div>
                                            <p className="font-permanent text-xs text-zinc-400 uppercase">Campaign</p>
                                            <Link href={`/game-night/campaigns/${character.campaign._id}`} className="font-permanent text-teal-600 dark:text-yellow-400 uppercase text-sm hover:underline">
                                                {character.campaign.title}
                                            </Link>
                                        </div>
                                    </div>
                                )}
                                {character.gameType && (
                                    <div className="flex items-start gap-2">
                                        <Sword className="w-4 h-4 text-yellow-500 mt-0.5 shrink-0" />
                                        <div>
                                            <p className="font-permanent text-xs text-zinc-400 uppercase">Game System</p>
                                            <p className="font-permanent text-black dark:text-white uppercase text-sm">{character.gameType}</p>
                                        </div>
                                    </div>
                                )}
                                <div className="flex items-start gap-2">
                                    <Sword className="w-4 h-4 text-teal-500 mt-0.5 shrink-0" />
                                    <div>
                                        <p className="font-permanent text-xs text-zinc-400 uppercase">Class</p>
                                        <p className="font-permanent text-black dark:text-white uppercase text-sm">{character.class || '—'}</p>
                                    </div>
                                </div>
                                <div className="flex items-start gap-2">
                                    <Star className="w-4 h-4 text-yellow-500 mt-0.5 shrink-0" />
                                    <div>
                                        <p className="font-permanent text-xs text-zinc-400 uppercase">Level</p>
                                        <p className="font-permanent text-black dark:text-white uppercase text-sm">{character.level || 1}</p>
                                    </div>
                                </div>
                                {character.player && (
                                    <div className="flex items-start gap-2">
                                        <User className="w-4 h-4 text-zinc-500 mt-0.5 shrink-0" />
                                        <div>
                                            <p className="font-permanent text-xs text-zinc-400 uppercase">Player</p>
                                            <p className="font-permanent text-black dark:text-white uppercase text-sm">{character.player.name || character.player.email || character.player._id}</p>
                                        </div>
                                    </div>
                                )}
                            </div>
                            <div className="pt-4 border-t-2 border-black/10 dark:border-white/10">
                                <p className="font-permanent text-xs text-zinc-400 uppercase mb-1">Created</p>
                                <p className="font-permanent text-black dark:text-white uppercase text-sm">{new Date(character.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }).toUpperCase()}</p>
                            </div>
                        </div>

                        {/* Level Progress Bar */}
                        <div className="mt-6 p-4 border-4 border-black bg-zinc-100 dark:bg-zinc-800">
                            <div className="flex justify-between font-permanent text-xs text-zinc-500 uppercase mb-2">
                                <span>LEVEL {character.level || 1}</span><span>MAX LV 20</span>
                            </div>
                            <div className="h-4 border-2 border-black bg-white dark:bg-zinc-700 overflow-hidden">
                                <div className="h-full bg-yellow-400 border-r-2 border-black transition-all" style={{ width: `${((character.level || 1) / 20) * 100}%` }} />
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
