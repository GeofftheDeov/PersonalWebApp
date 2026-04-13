"use client";

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Footer from "@/components/Footer";
import { CheckSquare, Calendar, ChevronLeft, ChevronRight, Clock, AlertCircle } from 'lucide-react';

interface Task {
    _id: string;
    title: string;
    description?: string;
    status: string;
    dueDate: string;
}

interface CalendarEvent {
    _id: string;
    title: string;
    description?: string;
    status: string;
    startDate: string;
    endDate?: string;
}

type DayItem = { type: 'task'; data: Task } | { type: 'event'; data: CalendarEvent };

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const statusColor = (status: string) => {
    if (status === 'Completed') return 'bg-green-500';
    if (status === 'In Progress') return 'bg-teal-500';
    return 'bg-yellow-400';
};

const taskStatusDot = (status: string) => {
    if (status === 'Completed') return 'bg-green-500';
    if (status === 'In Progress') return 'bg-orange-400';
    return 'bg-zinc-400';
};

export default function CalendarPage() {
    const router = useRouter();
    const [tasks, setTasks] = useState<Task[]>([]);
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const [loading, setLoading] = useState(true);
    const [today] = useState(new Date());
    const [current, setCurrent] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
    const [selectedDay, setSelectedDay] = useState<Date | null>(null);
    const [view, setView] = useState<'month' | 'list'>('month');

    useEffect(() => {
        const token = localStorage.getItem('token');
        if (!token) { router.push('/login'); return; }

        const fetchData = async () => {
            try {
                const [taskRes, eventRes] = await Promise.all([
                    fetch('/api/tasks', { headers: { Authorization: `Bearer ${token}` } }),
                    fetch('/api/events', { headers: { Authorization: `Bearer ${token}` } }),
                ]);
                if (taskRes.status === 401) { localStorage.clear(); router.push('/login'); return; }
                if (taskRes.ok) setTasks(await taskRes.json());
                if (eventRes.ok) setEvents(await eventRes.json());
            } catch (err) {
                console.error('Calendar fetch failed:', err);
            } finally {
                setLoading(false);
            }
        };
        fetchData();
    }, [router]);

    // Build calendar grid
    const year = current.getFullYear();
    const month = current.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const prevMonthDays = new Date(year, month, 0).getDate();

    const getItemsForDay = (day: number): DayItem[] => {
        const date = new Date(year, month, day);
        const dateStr = date.toDateString();
        const items: DayItem[] = [];

        tasks.forEach(t => {
            if (t.dueDate && new Date(t.dueDate).toDateString() === dateStr) {
                items.push({ type: 'task', data: t });
            }
        });
        events.forEach(e => {
            if (e.startDate && new Date(e.startDate).toDateString() === dateStr) {
                items.push({ type: 'event', data: e });
            }
        });
        return items;
    };

    const selectedItems: DayItem[] = selectedDay
        ? (() => {
            const items: DayItem[] = [];
            tasks.forEach(t => {
                if (t.dueDate && new Date(t.dueDate).toDateString() === selectedDay.toDateString()) items.push({ type: 'task', data: t });
            });
            events.forEach(e => {
                if (e.startDate && new Date(e.startDate).toDateString() === selectedDay.toDateString()) items.push({ type: 'event', data: e });
            });
            return items;
        })()
        : [];

    // Upcoming list: tasks + events sorted by date
    const upcoming: DayItem[] = [
        ...tasks.filter(t => t.dueDate && new Date(t.dueDate) >= today).map(t => ({ type: 'task' as const, data: t })),
        ...events.filter(e => e.startDate && new Date(e.startDate) >= today).map(e => ({ type: 'event' as const, data: e })),
    ].sort((a, b) => {
        const da = a.type === 'task' ? new Date(a.data.dueDate) : new Date((a.data as CalendarEvent).startDate);
        const db = b.type === 'task' ? new Date(b.data.dueDate) : new Date((b.data as CalendarEvent).startDate);
        return da.getTime() - db.getTime();
    });

    const overdue = tasks.filter(t => t.dueDate && new Date(t.dueDate) < today && t.status !== 'Completed');

    if (loading) {
        return <div className="min-h-screen flex items-center justify-center"><span className="text-4xl font-permanent text-teal-600 animate-pulse">LOADING CALENDAR...</span></div>;
    }

    const ItemChip = ({ item, compact = false }: { item: DayItem; compact?: boolean }) => {
        const isTask = item.type === 'task';
        const id = item.data._id;
        const href = isTask ? `/calendar/tasks/${id}` : `/calendar/events/${id}`;
        const label = item.data.title;
        const dateStr = isTask
            ? new Date((item.data as Task).dueDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
            : new Date((item.data as CalendarEvent).startDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

        if (compact) {
            return (
                <Link href={href} className={`block truncate text-[10px] font-permanent uppercase px-1 py-0.5 border border-black text-white mt-0.5 ${isTask ? 'bg-teal-600 hover:bg-teal-500' : 'bg-yellow-500 hover:bg-yellow-400 text-black'} transition-colors`}>
                    {label}
                </Link>
            );
        }

        return (
            <Link
                href={href}
                className="flex items-center gap-3 p-3 border-2 border-black bg-white dark:bg-slate-800 hover:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 transition-all group"
            >
                <div className={`w-8 h-8 shrink-0 flex items-center justify-center border-2 border-black ${isTask ? 'bg-teal-500' : 'bg-yellow-400'}`}>
                    {isTask ? <CheckSquare className="w-4 h-4 text-white" /> : <Calendar className="w-4 h-4 text-black" />}
                </div>
                <div className="flex-grow min-w-0">
                    <p className="font-permanent text-sm text-black dark:text-white uppercase truncate group-hover:text-teal-600 transition-colors">{label}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                        <span className={`inline-block w-2 h-2 rounded-full ${isTask ? taskStatusDot(item.data.status) : statusColor(item.data.status)}`} />
                        <span className="text-xs font-permanent text-zinc-400 uppercase">{item.data.status}</span>
                        <span className="text-xs font-permanent text-zinc-400 uppercase">&middot; {dateStr}</span>
                    </div>
                </div>
                <ChevronRight className="w-4 h-4 text-zinc-300 dark:text-zinc-600 shrink-0" />
            </Link>
        );
    };

    return (
        <div className="min-h-[calc(100vh-76px)] flex flex-col">
            <div className="flex-grow w-full max-w-6xl mx-auto p-6 md:p-12">

                {/* Header */}
                <header className="mb-10 border-b-8 border-black pb-6">
                    <h1 className="text-5xl md:text-7xl font-permanent text-black dark:text-black leading-none tracking-tight uppercase">
                        <span className="drop-shadow-[6px_6px_0px_rgba(250,204,21,1)]">YOUR</span>
                        <span className="text-yellow-400 ml-4 drop-shadow-[6px_6px_0px_rgba(0,0,0,1)]">CALENDAR</span>
                    </h1>
                    <p className="font-permanent text-zinc-500 uppercase text-sm mt-3">
                        {tasks.length} Task{tasks.length !== 1 ? 's' : ''} &middot; {events.length} Event{events.length !== 1 ? 's' : ''}
                        {overdue.length > 0 && <span className="ml-3 text-red-500">· {overdue.length} OVERDUE</span>}
                    </p>
                </header>

                {/* Overdue Alert */}
                {overdue.length > 0 && (
                    <div className="mb-6 p-4 border-4 border-red-500 bg-red-50 dark:bg-red-950 flex items-start gap-3">
                        <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                        <div>
                            <p className="font-permanent text-sm text-red-600 dark:text-red-400 uppercase font-bold">
                                {overdue.length} Overdue Task{overdue.length !== 1 ? 's' : ''}
                            </p>
                            <div className="flex flex-wrap gap-2 mt-2">
                                {overdue.map(t => (
                                    <Link key={t._id} href={`/calendar/tasks/${t._id}`} className="text-xs font-permanent text-red-600 dark:text-red-400 uppercase underline hover:no-underline">
                                        {t.title}
                                    </Link>
                                ))}
                            </div>
                        </div>
                    </div>
                )}

                {/* View Toggle */}
                <div className="flex gap-2 mb-6">
                    {(['month', 'list'] as const).map(v => (
                        <button
                            key={v}
                            onClick={() => setView(v)}
                            className={`px-4 py-2 border-4 border-black font-permanent uppercase text-sm transition-colors ${view === v ? 'bg-black text-white' : 'bg-white dark:bg-zinc-800 text-black dark:text-white hover:bg-zinc-100'}`}
                        >
                            {v === 'month' ? 'MONTH VIEW' : 'LIST VIEW'}
                        </button>
                    ))}
                </div>

                {/* ========= MONTH VIEW ========= */}
                {view === 'month' && (
                    <div className="flex flex-col lg:flex-row gap-6">
                        {/* Calendar Grid */}
                        <div className="flex-grow">
                            {/* Month Nav */}
                            <div className="flex items-center justify-between mb-4">
                                <button onClick={() => setCurrent(new Date(year, month - 1, 1))} className="p-2 border-4 border-black hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">
                                    <ChevronLeft className="w-5 h-5" />
                                </button>
                                <h2 className="text-2xl font-permanent text-black dark:text-white uppercase">{MONTHS[month]} {year}</h2>
                                <button onClick={() => setCurrent(new Date(year, month + 1, 1))} className="p-2 border-4 border-black hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">
                                    <ChevronRight className="w-5 h-5" />
                                </button>
                            </div>
                            {/* Day Header */}
                            <div className="grid grid-cols-7 border-4 border-b-0 border-black">
                                {DAYS.map(d => (
                                    <div key={d} className="text-center py-2 font-permanent text-xs uppercase text-zinc-500 dark:text-zinc-400 border-b-4 border-black bg-zinc-100 dark:bg-zinc-800">
                                        {d}
                                    </div>
                                ))}
                            </div>
                            {/* Grid Cells */}
                            <div className="grid grid-cols-7 border-l-4 border-black">
                                {/* Leading ghost days from prev month */}
                                {Array.from({ length: firstDay }).map((_, i) => (
                                    <div key={`prev-${i}`} className="min-h-[80px] border-r-4 border-b-4 border-black p-1 bg-zinc-50 dark:bg-zinc-900">
                                        <span className="text-xs font-permanent text-zinc-300 dark:text-zinc-700">{prevMonthDays - firstDay + i + 1}</span>
                                    </div>
                                ))}
                                {/* Current month days */}
                                {Array.from({ length: daysInMonth }).map((_, i) => {
                                    const day = i + 1;
                                    const dayDate = new Date(year, month, day);
                                    const isToday = dayDate.toDateString() === today.toDateString();
                                    const isSelected = selectedDay?.toDateString() === dayDate.toDateString();
                                    const items = getItemsForDay(day);
                                    return (
                                        <div
                                            key={day}
                                            onClick={() => setSelectedDay(isSelected ? null : dayDate)}
                                            className={`min-h-[80px] border-r-4 border-b-4 border-black p-1 cursor-pointer transition-colors ${
                                                isSelected ? 'bg-yellow-50 dark:bg-yellow-950' :
                                                isToday ? 'bg-teal-50 dark:bg-teal-950' :
                                                'bg-white dark:bg-slate-800 hover:bg-zinc-50 dark:hover:bg-zinc-700'
                                            }`}
                                        >
                                            <div className={`inline-flex items-center justify-center w-6 h-6 text-xs font-permanent mb-1 ${isToday ? 'bg-black text-yellow-400' : 'text-zinc-600 dark:text-zinc-300'}`}>
                                                {day}
                                            </div>
                                            <div className="space-y-0.5 overflow-hidden">
                                                {items.slice(0, 3).map((item, idx) => (
                                                    <div key={idx} onClick={e => e.stopPropagation()}>
                                                        <ItemChip item={item} compact />
                                                    </div>
                                                ))}
                                                {items.length > 3 && (
                                                    <p className="text-[10px] font-permanent text-zinc-400 uppercase">+{items.length - 3} more</p>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                                {/* Trailing ghost days */}
                                {Array.from({ length: (7 - (firstDay + daysInMonth) % 7) % 7 }).map((_, i) => (
                                    <div key={`next-${i}`} className="min-h-[80px] border-r-4 border-b-4 border-black p-1 bg-zinc-50 dark:bg-zinc-900">
                                        <span className="text-xs font-permanent text-zinc-300 dark:text-zinc-700">{i + 1}</span>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Side Panel */}
                        <div className="lg:w-72 shrink-0">
                            <div className="border-4 border-black p-4 bg-zinc-100 dark:bg-slate-800 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] sticky top-4">
                                <h3 className="font-permanent text-sm uppercase text-black dark:text-white mb-4 border-b-2 border-black pb-2">
                                    {selectedDay
                                        ? selectedDay.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase()
                                        : 'UPCOMING'}
                                </h3>
                                <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
                                    {(selectedDay ? selectedItems : upcoming.slice(0, 10)).length === 0 ? (
                                        <p className="font-permanent text-xs text-zinc-400 uppercase">Nothing {selectedDay ? 'on this day' : 'upcoming'}.</p>
                                    ) : (
                                        (selectedDay ? selectedItems : upcoming.slice(0, 10)).map((item, idx) => (
                                            <ItemChip key={idx} item={item} />
                                        ))
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* ========= LIST VIEW ========= */}
                {view === 'list' && (
                    <div className="space-y-8">
                        <div>
                            <h2 className="text-xl font-permanent text-teal-600 uppercase mb-3 flex items-center gap-2">
                                <CheckSquare className="w-5 h-5" /> Tasks ({tasks.length})
                            </h2>
                            <div className="space-y-2">
                                {tasks.length === 0 ? (
                                    <p className="font-permanent text-zinc-400 uppercase text-sm">No tasks.</p>
                                ) : (
                                    tasks.map(t => <ItemChip key={t._id} item={{ type: 'task', data: t }} />)
                                )}
                            </div>
                        </div>
                        <div>
                            <h2 className="text-xl font-permanent text-yellow-500 uppercase mb-3 flex items-center gap-2">
                                <Calendar className="w-5 h-5" /> Events ({events.length})
                            </h2>
                            <div className="space-y-2">
                                {events.length === 0 ? (
                                    <p className="font-permanent text-zinc-400 uppercase text-sm">No events.</p>
                                ) : (
                                    events.map(e => <ItemChip key={e._id} item={{ type: 'event', data: e }} />)
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>

            <Footer>
                <div className="inline-block border-8 border-black dark:border-black px-12 py-8 mb-12 bg-teal-600 shadow-[12px_12px_0px_0px_rgba(249,115,22,1)]">
                    <p className="text-3xl md:text-4xl font-permanent text-white uppercase leading-tight">
                        HAVE A<br />GOOD DAY
                    </p>
                </div>
            </Footer>
        </div>
    );
}