"use client";

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { Map, Users, ArrowLeft, UserPlus, Check, Crown } from 'lucide-react';

const statusColor = (status: string) => {
    if (status === 'In Progress') return 'bg-teal-500 text-white';
    if (status === 'Completed') return 'bg-zinc-600 text-white';
    return 'bg-yellow-400 text-black';
};

export default function JoinCampaignPage() {
    const router = useRouter();
    const params = useParams();
    const id = params?.id as string;

    const [campaign, setCampaign] = useState<any>(null);
    const [memberCount, setMemberCount] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);
    const [joining, setJoining] = useState(false);
    const [joined, setJoined] = useState(false);
    const [alreadyMember, setAlreadyMember] = useState(false);
    const [error, setError] = useState('');

    const token = () => localStorage.getItem('token');

    useEffect(() => {
        const t = token();
        if (!t) {
            router.push(`/login?redirect=/game-night/join/${id}`);
            return;
        }
        const headers = { Authorization: `Bearer ${t}` };
        Promise.all([
            fetch(`/api/campaigns/${id}`, { headers }),
            fetch(`/api/campaigns/${id}/members`, { headers }),
        ]).then(async ([campRes, membRes]) => {
            if (campRes.status === 401) { localStorage.clear(); router.push('/login'); return; }
            if (!campRes.ok) { setError('Campaign not found.'); setLoading(false); return; }
            const c = await campRes.json();
            setCampaign(c);
            if (membRes.ok) {
                const members = await membRes.json();
                setMemberCount(members.length);
                const userEmail = getUserEmail(t);
                if (userEmail && members.some((m: any) => m.email?.toLowerCase() === userEmail.toLowerCase())) {
                    setAlreadyMember(true);
                }
            }
        }).catch(() => setError('Failed to load campaign.'))
          .finally(() => setLoading(false));
    }, [id, router]);

    const getUserEmail = (t: string): string | null => {
        try {
            const payload = JSON.parse(atob(t.split('.')[1]));
            return payload.email || null;
        } catch {
            return null;
        }
    };

    const handleJoin = async () => {
        setJoining(true);
        setError('');
        try {
            const res = await fetch(`/api/campaigns/${id}/join`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token()}` },
            });
            if (res.status === 409) {
                setAlreadyMember(true);
            } else if (res.ok) {
                setJoined(true);
                setTimeout(() => router.push(`/game-night/campaigns/${id}`), 1500);
            } else {
                const data = await res.json();
                setError(data.error || 'Failed to join campaign.');
            }
        } catch {
            setError('Something went wrong. Please try again.');
        } finally {
            setJoining(false);
        }
    };

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <span className="text-3xl font-permanent text-teal-600 animate-pulse">LOADING...</span>
            </div>
        );
    }

    if (error && !campaign) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center gap-6 p-8">
                <p className="font-permanent text-xl text-black dark:text-white uppercase">{error}</p>
                <Link href="/game-night" className="px-6 py-3 border-4 border-black bg-yellow-400 font-permanent uppercase text-sm shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-white transition-colors">
                    <ArrowLeft className="w-4 h-4 inline mr-2" />BACK TO GAME NIGHT
                </Link>
            </div>
        );
    }

    return (
        <div className="min-h-[calc(100vh-76px)] flex flex-col items-center justify-center p-6">
            <div className="w-full max-w-md">

                {/* Campaign card */}
                <div className="p-8 border-4 border-black bg-white dark:bg-slate-900 shadow-[8px_8px_0px_0px_rgba(13,148,136,1)] mb-6">
                    <div className="flex items-start gap-4 mb-6">
                        <div className="p-3 bg-teal-500 border-4 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] shrink-0">
                            <Map className="w-8 h-8 text-white" />
                        </div>
                        <div>
                            <p className="font-permanent text-xs text-zinc-400 uppercase mb-1">You're invited to join</p>
                            <h1 className="text-2xl md:text-3xl font-permanent text-black dark:text-white uppercase leading-tight">{campaign?.title}</h1>
                            {campaign?.status && (
                                <span className={`mt-2 inline-block px-3 py-1 text-xs font-permanent uppercase border-2 border-black ${statusColor(campaign.status)}`}>
                                    {campaign.status}
                                </span>
                            )}
                        </div>
                    </div>

                    {campaign?.description && (
                        <p className="font-permanent text-sm text-zinc-600 dark:text-zinc-300 uppercase leading-relaxed mb-6 border-t-2 border-black/10 dark:border-white/10 pt-4">
                            {campaign.description}
                        </p>
                    )}

                    {memberCount !== null && (
                        <div className="flex items-center gap-2 text-sm font-permanent text-zinc-500 dark:text-zinc-400 uppercase mb-6">
                            <Users className="w-4 h-4" />
                            {memberCount} {memberCount === 1 ? 'PLAYER' : 'PLAYERS'}
                        </div>
                    )}

                    {/* Action area */}
                    {joined ? (
                        <div className="flex items-center justify-center gap-3 p-4 border-4 border-black bg-teal-500 text-white">
                            <Check className="w-5 h-5" />
                            <span className="font-permanent uppercase text-sm">JOINED! REDIRECTING...</span>
                        </div>
                    ) : alreadyMember ? (
                        <div className="space-y-3">
                            <div className="flex items-center justify-center gap-3 p-4 border-4 border-black bg-yellow-400 text-black">
                                <Crown className="w-5 h-5" />
                                <span className="font-permanent uppercase text-sm">YOU'RE ALREADY IN THIS CAMPAIGN</span>
                            </div>
                            <Link
                                href={`/game-night/campaigns/${id}`}
                                className="flex items-center justify-center gap-2 w-full p-4 border-4 border-black bg-teal-600 text-white font-permanent uppercase text-sm hover:bg-teal-500 transition-colors shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]"
                            >
                                VIEW CAMPAIGN
                            </Link>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {error && (
                                <p className="font-permanent text-xs text-red-500 uppercase border-2 border-red-500 p-2">{error}</p>
                            )}
                            <button
                                onClick={handleJoin}
                                disabled={joining}
                                className="flex items-center justify-center gap-2 w-full p-4 border-4 border-black bg-teal-600 text-white font-permanent uppercase text-sm hover:bg-teal-500 transition-colors shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] disabled:opacity-60 disabled:cursor-not-allowed"
                            >
                                <UserPlus className="w-5 h-5" />
                                {joining ? 'JOINING...' : 'JOIN CAMPAIGN'}
                            </button>
                            <Link
                                href="/game-night"
                                className="flex items-center justify-center gap-2 w-full p-3 border-2 border-black bg-transparent text-black dark:text-white font-permanent uppercase text-xs hover:bg-zinc-100 dark:hover:bg-slate-800 transition-colors"
                            >
                                <ArrowLeft className="w-3 h-3" /> BACK TO GAME NIGHT
                            </Link>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
