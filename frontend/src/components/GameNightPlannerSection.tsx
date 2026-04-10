"use client";

import React, { useEffect, useState } from 'react';
import { Sword, Book, Map, Users, Calendar, Plus, Save } from 'lucide-react';

interface Session {
    _id: string;
    title: string;
    date: string;
    summary: string;
}

interface Character {
    _id: string;
    name: string;
    class: string;
    level: number;
}

interface Campaign {
    _id: string;
    title: string;
}

export default function GameNightPlannerSection() {
    const [sessions, setSessions] = useState<Session[]>([]);
    const [characters, setCharacters] = useState<Character[]>([]);
    const [campaigns, setCampaigns] = useState<Campaign[]>([]);
    const [loading, setLoading] = useState(true);
    const [isShowPrepareForm, setIsShowPrepareForm] = useState(false);
    
    // Form state
    const [formData, setFormData] = useState({
        title: '',
        campaignId: '',
        date: '',
        agenda: '',
        location: '',
    });

    const fetchData = async () => {
        try {
            const token = localStorage.getItem('token');
            const [sessRes, charRes, campRes] = await Promise.all([
                fetch('/api/tabletop/sessions', { headers: { 'Authorization': `Bearer ${token}` } }),
                fetch('/api/tabletop/characters', { headers: { 'Authorization': `Bearer ${token}` } }),
                fetch('/api/campaigns', { headers: { 'Authorization': `Bearer ${token}` } })
            ]);
            
            if (sessRes.ok) setSessions(await sessRes.json());
            if (charRes.ok) setCharacters(await charRes.json());
            if (campRes.ok) setCampaigns(await campRes.json());
        } catch (err) {
            console.error("Failed to fetch tabletop data:", err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchData();
    }, []);

    const handlePrepareSession = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            const token = localStorage.getItem('token');
            const userStr = localStorage.getItem('user');
            if (!userStr) return;
            const user = JSON.parse(userStr);

            const payload = {
                ...formData,
                ownerId: user.id || user._id,
                ownerName: user.name,
            };

            const response = await fetch('/api/tabletop/prepare-session', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(payload)
            });

            if (response.ok) {
                setIsShowPrepareForm(false);
                setFormData({ title: '', campaignId: '', date: '', agenda: '', location: '' });
                fetchData(); // Refresh list
                alert("Session created! A preparation task and event have also been added to your dashboard.");
            }
        } catch (err) {
            console.error("Failed to prepare session:", err);
        }
    };

    const renderCard = (title: string, icon: React.ReactNode, content: React.ReactNode) => (
        <div className="relative mb-10 p-6 border-4 border-black bg-zinc-200 dark:bg-slate-800 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] dark:border-white group hover:-translate-y-1 transition-transform">
            <div className="flex items-center gap-3 mb-4">
                <div className="p-2 bg-yellow-400 border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">
                    {icon}
                </div>
                <h3 className="text-2xl font-permanent text-teal-600 dark:text-yellow-400 uppercase leading-none">
                    {title}
                </h3>
            </div>
            <div className="space-y-4">
                {content}
            </div>
        </div>
    );

    if (loading) {
        return <div className="p-4 font-permanent text-xl text-teal-600 animate-pulse">LOADING GAME NIGHT DATA...</div>;
    }

    return (
        <div className="mt-16 w-full">
            <div className="flex justify-between items-end mb-10 border-b-8 border-black pb-4">
                <h2 className="text-4xl md:text-6xl font-permanent text-teal-600 uppercase relative w-fit">
                    <span className="drop-shadow-[4px_4px_0px_rgba(0,0,0,1)]">Game Night Planner</span>
                </h2>
                <button 
                    onClick={() => setIsShowPrepareForm(!isShowPrepareForm)}
                    className="p-3 border-4 border-black bg-yellow-400 text-black font-permanent text-xl uppercase hover:bg-white transition-colors shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]"
                >
                    {isShowPrepareForm ? "CANCEL" : "PREPARE SESSION"}
                </button>
            </div>

            {isShowPrepareForm && (
                <form 
                    onSubmit={handlePrepareSession}
                    className="mb-12 p-8 border-4 border-black bg-slate-900 shadow-[10px_10px_0px_0px_rgba(13,148,136,1)]"
                >
                    <h3 className="text-3xl font-permanent text-white mb-6 uppercase flex items-center gap-2">
                        <Plus className="w-8 h-8 text-teal-500" />
                        Plan New Session
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                        <div>
                            <label className="block text-teal-500 font-permanent uppercase mb-2">Title</label>
                            <input 
                                required
                                value={formData.title}
                                onChange={e => setFormData({...formData, title: e.target.value})}
                                className="w-full p-3 border-4 border-black bg-white text-black font-permanent text-xl uppercase focus:border-yellow-400 outline-none"
                                placeholder="THE FINAL STAND"
                            />
                        </div>
                        <div>
                            <label className="block text-teal-500 font-permanent uppercase mb-2">Campaign</label>
                            <select 
                                required
                                value={formData.campaignId}
                                onChange={e => setFormData({...formData, campaignId: e.target.value})}
                                className="w-full p-3 border-4 border-black bg-white text-black font-permanent text-xl uppercase focus:border-yellow-400 outline-none appearance-none"
                            >
                                <option value="">--- SELECT CAMPAIGN ---</option>
                                {campaigns.map(c => (
                                    <option key={c._id} value={c._id}>{c.title}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="block text-teal-500 font-permanent uppercase mb-2">Session Date</label>
                            <input 
                                type="datetime-local"
                                required
                                value={formData.date}
                                onChange={e => setFormData({...formData, date: e.target.value})}
                                className="w-full p-3 border-4 border-black bg-white text-black font-permanent text-xl uppercase focus:border-yellow-400 outline-none"
                            />
                        </div>
                        <div>
                            <label className="block text-teal-500 font-permanent uppercase mb-2">Location</label>
                            <input 
                                value={formData.location}
                                onChange={e => setFormData({...formData, location: e.target.value})}
                                className="w-full p-3 border-4 border-black bg-white text-black font-permanent text-xl uppercase focus:border-yellow-400 outline-none"
                                placeholder="GEOFF'S BASEMENT / ONLINE"
                            />
                        </div>
                    </div>
                    <div className="mb-8">
                        <label className="block text-teal-500 font-permanent uppercase mb-2">Agenda / Prep Notes</label>
                        <textarea 
                            value={formData.agenda}
                            onChange={e => setFormData({...formData, agenda: e.target.value})}
                            className="w-full p-3 border-4 border-black bg-white text-black font-permanent text-xl uppercase focus:border-yellow-400 outline-none"
                            rows={3}
                            placeholder="GATHER THE ORBS FROM THE FIRE GIANT'S LAIR..."
                        />
                    </div>
                    <button 
                        type="submit"
                        className="w-full p-4 border-4 border-black bg-teal-600 text-white font-permanent text-2xl uppercase hover:bg-white hover:text-black transition-all shadow-[6px_6px_0px_0px_rgba(255,255,255,1)] flex items-center justify-center gap-3"
                    >
                        <Save className="w-8 h-8" />
                        INITIATE SESSION PREP
                    </button>
                </form>
            )}
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {renderCard("Recent Sessions", <Book className="w-6 h-6 text-black" />, (
                    <div className="space-y-4">
                        {sessions.length > 0 ? sessions.map(s => (
                            <div key={s._id} className="border-b-2 border-black/10 dark:border-white/10 pb-2">
                                <p className="font-permanent text-lg text-black dark:text-white uppercase">{s.title}</p>
                                <p className="text-sm font-permanent text-teal-600 dark:text-yellow-400">{new Date(s.date).toLocaleDateString()}</p>
                            </div>
                        )) : (
                            <p className="font-permanent text-black dark:text-zinc-400 italic text-sm">NO RECENT SESSIONS LOGGED.</p>
                        )}
                        <button className="w-full p-2 border-2 border-black bg-teal-500 text-white font-permanent uppercase hover:bg-teal-600 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] text-sm">
                            Session History
                        </button>
                    </div>
                ))}

                {renderCard("Active Characters", <Sword className="w-6 h-6 text-black" />, (
                    <div className="space-y-4">
                        {characters.length > 0 ? characters.map(c => (
                            <div key={c._id} className="border-b-2 border-black/10 dark:border-white/10 pb-2 flex justify-between items-end">
                                <div>
                                    <p className="font-permanent text-lg text-black dark:text-white uppercase">{c.name}</p>
                                    <p className="text-sm font-permanent text-teal-600 dark:text-yellow-400 uppercase">{c.class} - Level {c.level}</p>
                                </div>
                                <div className="text-xs px-2 py-1 bg-zinc-800 text-yellow-400 border border-black uppercase font-permanent">Ready</div>
                            </div>
                        )) : (
                            <p className="font-permanent text-black dark:text-zinc-400 italic text-sm">NO CHARACTERS CREATED.</p>
                        )}
                        <button className="w-full p-2 border-2 border-black bg-teal-500 text-white font-permanent uppercase hover:bg-teal-600 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] text-sm">
                            Manage Characters
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
}
