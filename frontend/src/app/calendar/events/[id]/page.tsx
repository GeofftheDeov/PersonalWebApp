"use client";

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { Calendar, ArrowLeft, Clock } from 'lucide-react';

const statusBadge = (status: string) => {
    const cls =
        status === 'Completed' ? 'bg-green-500 text-white' :
        status === 'In Progress' ? 'bg-teal-500 text-white' :
        'bg-yellow-400 text-black';
    return <span className={`px-3 py-1 text-sm font-permanent uppercase border-2 border-black ${cls}`}>{status}</span>;
};

export default function EventDetailPage() {
    const router = useRouter();
    const params = useParams();
    const id = params?.id as string;

    const [event, setEvent] = useState<any>(null);
    const [loading, setLoading] = useState(true);

    const token = () => localStorage.getItem('token');

    useEffect(() => {
        if (!id) return;
        const fetchEvent = async () => {
            const res = await fetch(`/api/events/${id}`, { headers: { Authorization: `Bearer ${token()}` } });
            if (res.status === 401) { localStorage.clear(); router.push('/login'); return; }
            if (res.ok) {
                setEvent(await res.json());
            } else {
                router.push('/calendar');
            }
            setLoading(false);
        };
        fetchEvent();
    }, [id, router]);

    if (loading) return <div className="min-h-screen flex items-center justify-center"><span className="text-3xl font-permanent text-yellow-500 animate-pulse">LOADING EVENT...</span></div>;
    if (!event) return null;

    const startDate = event.startDate ? new Date(event.startDate) : null;
    const endDate = event.endDate ? new Date(event.endDate) : null;

    const formatDuration = () => {
        if (!startDate || !endDate) return null;
        const diffMs = endDate.getTime() - startDate.getTime();
        const diffHrs = Math.round(diffMs / (1000 * 60 * 60) * 10) / 10;
        return `${diffHrs} hr${diffHrs !== 1 ? 's' : ''}`;
    };

    return (
        <div className="min-h-[calc(100vh-76px)] flex flex-col">
            <div className="flex-grow w-full max-w-3xl mx-auto p-6 md:p-12">

                {/* Breadcrumb */}
                <div className="mb-8">
                    <Link href="/calendar" className="inline-flex items-center gap-2 px-4 py-2 bg-yellow-400 text-black border-4 border-black font-permanent text-sm shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-white transition-colors uppercase w-fit">
                        <ArrowLeft className="w-4 h-4" /> BACK TO CALENDAR
                    </Link>
                </div>

                {/* Header */}
                <div className="mb-8 pb-6 border-b-8 border-black flex items-start gap-4">
                    <div className="p-3 bg-yellow-400 border-4 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] shrink-0">
                        <Calendar className="w-8 h-8 text-black" />
                    </div>
                    <div>
                        <p className="font-permanent text-xs text-zinc-400 uppercase mb-1">Event</p>
                        <h1 className="text-3xl md:text-4xl font-permanent text-black dark:text-white uppercase leading-tight">{event.title}</h1>
                        <div className="mt-2">{statusBadge(event.status)}</div>
                    </div>
                </div>

                {/* Detail Card */}
                <div className="p-6 border-4 border-black bg-white dark:bg-slate-800 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div>
                            <p className="font-permanent text-xs text-zinc-400 uppercase mb-1">Description</p>
                            <p className="font-permanent text-black dark:text-white uppercase text-sm leading-relaxed">
                                {event.description || '—'}
                            </p>
                        </div>
                        <div className="space-y-4">
                            {startDate && (
                                <div className="flex items-start gap-2">
                                    <Clock className="w-4 h-4 text-yellow-500 mt-0.5 shrink-0" />
                                    <div>
                                        <p className="font-permanent text-xs text-zinc-400 uppercase">Start</p>
                                        <p className="font-permanent text-black dark:text-white uppercase text-sm">
                                            {startDate.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }).toUpperCase()}
                                        </p>
                                        <p className="font-permanent text-teal-600 dark:text-yellow-400 uppercase text-xs mt-0.5">
                                            {startDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                                        </p>
                                    </div>
                                </div>
                            )}
                            {endDate && (
                                <div className="flex items-start gap-2">
                                    <Clock className="w-4 h-4 text-yellow-500 mt-0.5 shrink-0" />
                                    <div>
                                        <p className="font-permanent text-xs text-zinc-400 uppercase">End</p>
                                        <p className="font-permanent text-black dark:text-white uppercase text-sm">
                                            {endDate.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }).toUpperCase()}
                                        </p>
                                        <p className="font-permanent text-teal-600 dark:text-yellow-400 uppercase text-xs mt-0.5">
                                            {endDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                                        </p>
                                    </div>
                                </div>
                            )}
                            {formatDuration() && (
                                <div>
                                    <p className="font-permanent text-xs text-zinc-400 uppercase">Duration</p>
                                    <p className="font-permanent text-black dark:text-white uppercase text-sm">{formatDuration()}</p>
                                </div>
                            )}
                            <div>
                                <p className="font-permanent text-xs text-zinc-400 uppercase mb-1">Created</p>
                                <p className="font-permanent text-black dark:text-white uppercase text-sm">
                                    {new Date(event.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }).toUpperCase()}
                                </p>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Timeline visual */}
                {startDate && endDate && (
                    <div className="mt-6 p-4 border-4 border-black bg-yellow-50 dark:bg-yellow-950">
                        <p className="font-permanent text-xs text-zinc-500 uppercase mb-3">Timeline</p>
                        <div className="flex items-center gap-3">
                            <div className="text-center">
                                <div className="w-3 h-3 bg-yellow-400 border-2 border-black mx-auto mb-1" />
                                <p className="font-permanent text-xs text-black dark:text-white uppercase">{startDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</p>
                            </div>
                            <div className="flex-grow h-1 bg-yellow-400 border-y-2 border-black relative">
                                <div className="absolute inset-0 flex items-center justify-center">
                                    <span className="bg-yellow-50 dark:bg-yellow-950 px-2 font-permanent text-xs text-zinc-500 uppercase">{formatDuration()}</span>
                                </div>
                            </div>
                            <div className="text-center">
                                <div className="w-3 h-3 bg-teal-500 border-2 border-black mx-auto mb-1" />
                                <p className="font-permanent text-xs text-black dark:text-white uppercase">{endDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</p>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
