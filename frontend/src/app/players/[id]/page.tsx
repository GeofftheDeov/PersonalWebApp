"use client";

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, User, Map, Crown, Shield, Gamepad2, Calendar, Lock } from 'lucide-react';

interface SharedCampaign {
    _id: string;
    title: string;
    status: string;
    isGameMaster: boolean;
}

interface PlayerProfile {
    _id: string;
    recordType: string;
    name: string;
    handle: string | null;
    userNumber: string | null;
    profilePicture: string | null;
    favoriteGames: string[];
    discordHandle: string | null;
    createdAt: string | null;
    isFriend: boolean;
    sharedCampaigns: SharedCampaign[];
}

/**
 * Read-only view of another player's profile. Deliberately exposes no edit
 * controls and no child-record creation (characters, API keys, etc.) — those
 * live only on your own /profile page.
 */
export default function PlayerProfilePage() {
    const router = useRouter();
    const params = useParams();
    const id = params?.id as string;

    const [profile, setProfile] = useState<PlayerProfile | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const token = localStorage.getItem('token');
        if (!token) { router.push('/login'); return; }
        fetch(`/api/users/players/${id}`, { headers: { Authorization: `Bearer ${token}` } })
            .then(async res => {
                if (res.status === 401) { localStorage.clear(); router.push('/login'); return; }
                const data = await res.json().catch(() => ({}));
                if (res.ok) setProfile(data);
                else setError(data.error || 'Could not load this profile');
            })
            .catch(() => setError('Could not load this profile'))
            .finally(() => setLoading(false));
    }, [id, router]);

    if (loading) return <div className="min-h-screen flex items-center justify-center"><span className="text-3xl font-permanent text-teal-600 animate-pulse">LOADING PLAYER...</span></div>;

    if (error || !profile) {
        return (
            <div className="min-h-[calc(100vh-76px)] flex flex-col items-center justify-center gap-6 p-6">
                <div className="p-4 bg-zinc-700 border-4 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
                    <Lock className="w-10 h-10 text-white" />
                </div>
                <p className="font-permanent text-lg text-black dark:text-white uppercase text-center max-w-md">{error || 'Profile unavailable'}</p>
                <button onClick={() => router.back()} className="inline-flex items-center gap-2 px-4 py-2 bg-yellow-400 text-black border-4 border-black font-permanent text-sm shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-white transition-colors uppercase">
                    <ArrowLeft className="w-4 h-4" /> GO BACK
                </button>
            </div>
        );
    }

    const displayHandle = profile.handle || profile.name;

    return (
        <div className="min-h-[calc(100vh-76px)] flex flex-col">
            <div className="flex-grow w-full max-w-3xl mx-auto p-4 sm:p-6 md:p-12">

                <div className="mb-8">
                    <button onClick={() => router.back()} className="inline-flex items-center gap-2 px-4 py-2 bg-yellow-400 text-black border-4 border-black font-permanent text-sm shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-white transition-colors uppercase w-fit">
                        <ArrowLeft className="w-4 h-4" /> BACK
                    </button>
                </div>

                {/* Header */}
                <div className="mb-8 pb-6 border-b-8 border-black flex flex-wrap items-start gap-4 sm:gap-6">
                    <div className="w-24 h-24 sm:w-28 sm:h-28 border-4 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] bg-teal-500 flex items-center justify-center overflow-hidden shrink-0">
                        {profile.profilePicture
                            ? <img src={profile.profilePicture} alt={displayHandle} className="w-full h-full object-cover" />
                            : <User className="w-12 h-12 text-white" />}
                    </div>
                    <div className="min-w-0">
                        <p className="font-permanent text-xs text-zinc-400 uppercase mb-1">Player Profile</p>
                        <h1 className="text-2xl sm:text-3xl md:text-4xl font-permanent text-black dark:text-white uppercase leading-tight break-words">@{displayHandle}</h1>
                        <div className="mt-2 flex flex-wrap gap-2 items-center">
                            {profile.userNumber && <span className="px-3 py-1 text-sm font-permanent uppercase border-2 border-black bg-zinc-200 dark:bg-zinc-700 text-black dark:text-white">#{profile.userNumber}</span>}
                            {profile.isFriend && <span className="px-3 py-1 text-sm font-permanent uppercase border-2 border-black bg-teal-500 text-white">FRIEND</span>}
                        </div>
                    </div>
                </div>

                {/* Details (read-only) */}
                <div className="p-6 border-4 border-black bg-white dark:bg-slate-800 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] mb-8 space-y-5">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                        {profile.name && profile.handle && (
                            <div>
                                <p className="font-permanent text-xs text-zinc-400 uppercase mb-1">Name</p>
                                <p className="font-permanent text-black dark:text-white uppercase text-sm">{profile.name}</p>
                            </div>
                        )}
                        {profile.discordHandle && (
                            <div>
                                <p className="font-permanent text-xs text-zinc-400 uppercase mb-1">Discord</p>
                                <p className="font-permanent text-black dark:text-white uppercase text-sm">{profile.discordHandle}</p>
                            </div>
                        )}
                        {profile.createdAt && (
                            <div className="flex items-start gap-2">
                                <Calendar className="w-4 h-4 text-teal-500 mt-0.5 shrink-0" />
                                <div>
                                    <p className="font-permanent text-xs text-zinc-400 uppercase">Member Since</p>
                                    <p className="font-permanent text-black dark:text-white uppercase text-sm">{new Date(profile.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long' }).toUpperCase()}</p>
                                </div>
                            </div>
                        )}
                    </div>

                    {profile.favoriteGames.length > 0 && (
                        <div className="pt-4 border-t-2 border-black/10 dark:border-white/10">
                            <p className="font-permanent text-xs text-zinc-400 uppercase mb-2 flex items-center gap-1"><Gamepad2 className="w-4 h-4 text-yellow-500" /> Favorite Games</p>
                            <div className="flex flex-wrap gap-2">
                                {profile.favoriteGames.map((g, i) => (
                                    <span key={i} className="px-3 py-1 text-xs font-permanent uppercase border-2 border-black bg-yellow-400 text-black">{g}</span>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                {/* Shared campaigns */}
                <div>
                    <h2 className="text-2xl font-permanent text-black dark:text-white uppercase flex items-center gap-2 mb-4">
                        <Map className="w-5 h-5 text-teal-500" /> Campaigns Together <span className="ml-1 text-sm text-zinc-400">({profile.sharedCampaigns.length})</span>
                    </h2>
                    {profile.sharedCampaigns.length === 0 ? (
                        <div className="py-10 border-4 border-dashed border-zinc-300 dark:border-zinc-700 text-center">
                            <Map className="w-10 h-10 text-zinc-300 dark:text-zinc-600 mx-auto mb-2" />
                            <p className="font-permanent text-sm text-zinc-400 uppercase">No campaigns together yet.</p>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {profile.sharedCampaigns.map(c => (
                                <Link key={c._id} href={`/game-night/campaigns/${c._id}`} className="flex items-center gap-4 p-4 border-4 border-black bg-white dark:bg-slate-800 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 transition-transform group">
                                    <div className={`p-2 border-2 border-black shrink-0 ${c.isGameMaster ? 'bg-yellow-400' : 'bg-teal-500'}`}>
                                        {c.isGameMaster ? <Crown className="w-4 h-4 text-black" /> : <Shield className="w-4 h-4 text-white" />}
                                    </div>
                                    <div className="min-w-0 flex-grow">
                                        <p className="font-permanent text-sm text-black dark:text-white uppercase truncate group-hover:text-teal-600 transition-colors">{c.title}</p>
                                        <p className="text-xs font-permanent text-teal-600 dark:text-yellow-400 uppercase">{c.isGameMaster ? 'Game Master' : 'Player'} · {c.status}</p>
                                    </div>
                                </Link>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
