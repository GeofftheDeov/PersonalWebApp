"use client";

import React, { useEffect, useState } from 'react';
import { Book, Map, Sword, ChevronRight } from 'lucide-react';
import Link from 'next/link';

interface Campaign {
    _id: string;
    title: string;
    status: string;
}

interface Session {
    _id: string;
    title: string;
    date: string;
    campaign?: { _id: string; title: string };
}

interface Character {
    _id: string;
    name: string;
    class: string;
    level: number;
    isDead: boolean;
}

export default function GameNightSummary() {
    const [campaigns, setCampaigns] = useState<Campaign[]>([]);
    const [sessions, setSessions] = useState<Session[]>([]);
    const [characters, setCharacters] = useState<Character[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const token = localStorage.getItem('token');
        if (!token) return;

        const fetchData = async () => {
            try {
                const [campRes, sessRes, charRes] = await Promise.all([
                    fetch('/api/campaigns', { headers: { Authorization: `Bearer ${token}` } }),
                    fetch('/api/tabletop/sessions', { headers: { Authorization: `Bearer ${token}` } }),
                    fetch('/api/tabletop/characters', { headers: { Authorization: `Bearer ${token}` } }),
                ]);
                if (campRes.ok) setCampaigns(await campRes.json());
                if (sessRes.ok) setSessions(await sessRes.json());
                if (charRes.ok) setCharacters(await charRes.json());
            } catch (err) {
                console.error('GameNightSummary: Failed to fetch data', err);
            } finally {
                setLoading(false);
            }
        };
        fetchData();
    }, []);

    const statusBadge = (status: string) => {
        const cls =
            status === 'In Progress' ? 'bg-teal-500 text-white' :
            status === 'Completed' ? 'bg-zinc-500 text-white' :
            'bg-yellow-400 text-black';
        return <span className={`px-2 py-0.5 text-xs font-permanent uppercase border border-black ${cls}`}>{status}</span>;
    };

    if (loading) {
        return (
            <div className="mt-16 w-full">
                <div className="flex justify-between items-end mb-10 border-b-8 border-black pb-4">
                    <h2 className="text-4xl md:text-5xl font-permanent text-teal-600 uppercase drop-shadow-[4px_4px_0px_rgba(0,0,0,1)]">Game Night</h2>
                </div>
                <p className="font-permanent text-teal-600 animate-pulse uppercase">Loading...</p>
            </div>
        );
    }

    const recentSessions = sessions.slice(0, 4);
    const activeCampaigns = campaigns.filter(c => c.status === 'In Progress').slice(0, 3);
    const displayCampaigns = activeCampaigns.length > 0 ? activeCampaigns : campaigns.slice(0, 3);
    const recentChars = characters.filter(c => !c.isDead).slice(0, 4);

    const renderCard = (
        title: string,
        icon: React.ReactNode,
        content: React.ReactNode,
        tab: string
    ) => (
        <div className="relative mb-0 p-6 border-4 border-black bg-zinc-200 dark:bg-slate-800 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] dark:border-white hover:-translate-y-1 transition-transform flex flex-col">
            <div className="flex items-center gap-3 mb-4">
                <div className="p-2 bg-yellow-400 border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">
                    {icon}
                </div>
                <h3 className="text-xl font-permanent text-teal-600 dark:text-yellow-400 uppercase leading-none">{title}</h3>
            </div>
            <div className="space-y-3 flex-grow">{content}</div>
            <Link
                href={`/game-night?tab=${tab}`}
                className="mt-5 w-full flex items-center justify-center gap-1 p-2 border-2 border-black bg-teal-500 text-white font-permanent uppercase hover:bg-teal-600 transition-colors shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] text-sm"
            >
                View All <ChevronRight className="w-4 h-4" />
            </Link>
        </div>
    );

    return (
        <div className="mt-16 w-full">
            <div className="flex justify-between items-end mb-10 border-b-8 border-black pb-4">
                <h2 className="text-4xl md:text-5xl font-permanent text-teal-600 uppercase relative w-fit">
                    <span className="drop-shadow-[4px_4px_0px_rgba(0,0,0,1)]">Game Night</span>
                </h2>
                <Link
                    href="/game-night"
                    id="game-night-full-planner-link"
                    className="p-3 border-4 border-black bg-yellow-400 text-black font-permanent text-sm uppercase hover:bg-white transition-colors shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]"
                >
                    Full Planner →
                </Link>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">

                {/* Campaigns */}
                {renderCard(
                    'Campaigns',
                    <Map className="w-5 h-5 text-black" />,
                    displayCampaigns.length > 0 ? displayCampaigns.map(c => (
                        <div key={c._id} className="flex justify-between items-center border-b-2 border-black/10 dark:border-white/10 pb-2">
                            <p className="font-permanent text-sm text-black dark:text-white uppercase leading-tight">{c.title}</p>
                            {statusBadge(c.status)}
                        </div>
                    )) : (
                        <p className="font-permanent text-black dark:text-zinc-400 italic text-sm uppercase">No campaigns yet.</p>
                    ),
                    'campaigns'
                )}

                {/* Recent Sessions */}
                {renderCard(
                    'Recent Sessions',
                    <Book className="w-5 h-5 text-black" />,
                    recentSessions.length > 0 ? recentSessions.map(s => (
                        <div key={s._id} className="border-b-2 border-black/10 dark:border-white/10 pb-2">
                            <p className="font-permanent text-sm text-black dark:text-white uppercase">{s.title}</p>
                            <p className="text-xs font-permanent text-teal-600 dark:text-yellow-400 uppercase">{new Date(s.date).toLocaleDateString()}</p>
                        </div>
                    )) : (
                        <p className="font-permanent text-black dark:text-zinc-400 italic text-sm uppercase">No sessions logged.</p>
                    ),
                    'sessions'
                )}

                {/* Characters */}
                {renderCard(
                    'Characters',
                    <Sword className="w-5 h-5 text-black" />,
                    recentChars.length > 0 ? recentChars.map(c => (
                        <div key={c._id} className="flex justify-between items-end border-b-2 border-black/10 dark:border-white/10 pb-2">
                            <div>
                                <p className="font-permanent text-sm text-black dark:text-white uppercase">{c.name}</p>
                                <p className="text-xs font-permanent text-teal-600 dark:text-yellow-400 uppercase">{c.class} · Lv {c.level}</p>
                            </div>
                            <div className="text-xs px-2 py-1 bg-zinc-800 text-yellow-400 border border-black uppercase font-permanent">Ready</div>
                        </div>
                    )) : (
                        <p className="font-permanent text-black dark:text-zinc-400 italic text-sm uppercase">No characters created.</p>
                    ),
                    'characters'
                )}

            </div>
        </div>
    );
}
