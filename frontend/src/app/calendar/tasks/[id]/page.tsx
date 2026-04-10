"use client";

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { CheckSquare, ArrowLeft, Save, Trash2, Clock, User } from 'lucide-react';

const INPUT_CLS = "w-full p-3 border-4 border-black bg-white text-black font-permanent text-lg uppercase focus:border-yellow-400 outline-none";
const LABEL_CLS = "block text-teal-600 font-permanent uppercase text-sm mb-1";

const statusBadge = (status: string) => {
    const cls =
        status === 'Completed' ? 'bg-green-500 text-white' :
        status === 'In Progress' ? 'bg-teal-500 text-white' :
        'bg-yellow-400 text-black';
    return <span className={`px-3 py-1 text-sm font-permanent uppercase border-2 border-black ${cls}`}>{status}</span>;
};

export default function TaskDetailPage() {
    const router = useRouter();
    const params = useParams();
    const id = params?.id as string;

    const [task, setTask] = useState<any>(null);
    const [editing, setEditing] = useState(false);
    const [form, setForm] = useState<any>({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);

    const token = () => localStorage.getItem('token');

    useEffect(() => {
        if (!id) return;
        const fetchTask = async () => {
            const res = await fetch(`/api/tasks/${id}`, { headers: { Authorization: `Bearer ${token()}` } });
            if (res.status === 401) { localStorage.clear(); router.push('/login'); return; }
            if (res.ok) {
                const data = await res.json();
                setTask(data);
                setForm({
                    title: data.title,
                    description: data.description || '',
                    status: data.status,
                    dueDate: data.dueDate ? new Date(data.dueDate).toISOString().split('T')[0] : '',
                });
            } else {
                router.push('/calendar');
            }
            setLoading(false);
        };
        fetchTask();
    }, [id, router]);

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        const res = await fetch(`/api/tasks/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
            body: JSON.stringify(form),
        });
        if (res.ok) {
            const updated = await res.json();
            setTask(updated);
            setEditing(false);
        }
        setSaving(false);
    };

    const handleDelete = async () => {
        if (!confirm('Delete this task? This cannot be undone.')) return;
        setDeleting(true);
        const res = await fetch(`/api/tasks/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token()}` } });
        if (res.ok) router.push('/calendar');
        setDeleting(false);
    };

    if (loading) return <div className="min-h-screen flex items-center justify-center"><span className="text-3xl font-permanent text-teal-600 animate-pulse">LOADING TASK...</span></div>;
    if (!task) return null;

    return (
        <div className="min-h-[calc(100vh-76px)] flex flex-col">
            <div className="flex-grow w-full max-w-3xl mx-auto p-6 md:p-12">

                {/* Breadcrumb */}
                <div className="mb-8">
                    <Link href="/calendar" className="flex items-center gap-1 font-permanent text-sm text-teal-600 uppercase hover:text-yellow-500 transition-colors w-fit">
                        <ArrowLeft className="w-4 h-4" /> BACK TO CALENDAR
                    </Link>
                </div>

                {/* Header */}
                <div className="mb-8 pb-6 border-b-8 border-black flex flex-col md:flex-row md:items-end justify-between gap-4">
                    <div className="flex items-start gap-4">
                        <div className="p-3 bg-teal-500 border-4 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] shrink-0">
                            <CheckSquare className="w-8 h-8 text-white" />
                        </div>
                        <div>
                            <p className="font-permanent text-xs text-zinc-400 uppercase mb-1">Task</p>
                            <h1 className="text-3xl md:text-4xl font-permanent text-black dark:text-white uppercase leading-tight">{task.title}</h1>
                            <div className="mt-2">{statusBadge(task.status)}</div>
                        </div>
                    </div>
                    <div className="flex gap-2 shrink-0">
                        {!editing && (
                            <button onClick={() => setEditing(true)} className="px-4 py-2 border-4 border-black bg-yellow-400 text-black font-permanent uppercase text-sm hover:bg-white transition-colors shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]">
                                EDIT
                            </button>
                        )}
                        <button onClick={handleDelete} disabled={deleting} className="px-4 py-2 border-4 border-black bg-red-500 text-white font-permanent uppercase text-sm hover:bg-red-600 transition-colors shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]">
                            <Trash2 className="w-4 h-4" />
                        </button>
                    </div>
                </div>

                {editing ? (
                    /* Edit Mode */
                    <form onSubmit={handleSave} className="space-y-5 p-6 border-4 border-black bg-slate-900 shadow-[8px_8px_0px_0px_rgba(13,148,136,1)]">
                        <div>
                            <label className={LABEL_CLS}>Title *</label>
                            <input required className={INPUT_CLS} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} />
                        </div>
                        <div>
                            <label className={LABEL_CLS}>Description</label>
                            <textarea className={INPUT_CLS} rows={4} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className={LABEL_CLS}>Due Date</label>
                                <input type="date" className={INPUT_CLS} value={form.dueDate} onChange={e => setForm({ ...form, dueDate: e.target.value })} />
                            </div>
                            <div>
                                <label className={LABEL_CLS}>Status</label>
                                <select className={INPUT_CLS + " appearance-none"} value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>
                                    <option>Not Started</option>
                                    <option>In Progress</option>
                                    <option>Completed</option>
                                </select>
                            </div>
                        </div>
                        <div className="flex gap-3 pt-2">
                            <button type="submit" disabled={saving} className="flex-1 flex items-center justify-center gap-2 p-3 border-4 border-black bg-teal-600 text-white font-permanent uppercase hover:bg-teal-500 transition-colors">
                                <Save className="w-4 h-4" /> {saving ? 'SAVING...' : 'SAVE CHANGES'}
                            </button>
                            <button type="button" onClick={() => setEditing(false)} className="px-6 p-3 border-4 border-black bg-zinc-700 text-white font-permanent uppercase hover:bg-zinc-600 transition-colors">
                                CANCEL
                            </button>
                        </div>
                    </form>
                ) : (
                    /* View Mode */
                    <div className="space-y-6">
                        <div className="p-6 border-4 border-black bg-white dark:bg-slate-800 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                <div>
                                    <p className="font-permanent text-xs text-zinc-400 uppercase mb-1">Description</p>
                                    <p className="font-permanent text-black dark:text-white uppercase text-sm leading-relaxed">
                                        {task.description || '—'}
                                    </p>
                                </div>
                                <div className="space-y-4">
                                    <div className="flex items-center gap-2">
                                        <Clock className="w-4 h-4 text-teal-500" />
                                        <div>
                                            <p className="font-permanent text-xs text-zinc-400 uppercase">Due Date</p>
                                            <p className="font-permanent text-black dark:text-white uppercase text-sm">
                                                {task.dueDate ? new Date(task.dueDate).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).toUpperCase() : '—'}
                                            </p>
                                        </div>
                                    </div>
                                    {task.ownerName && (
                                        <div className="flex items-center gap-2">
                                            <User className="w-4 h-4 text-teal-500" />
                                            <div>
                                                <p className="font-permanent text-xs text-zinc-400 uppercase">Owner</p>
                                                <p className="font-permanent text-black dark:text-white uppercase text-sm">{task.ownerName}</p>
                                            </div>
                                        </div>
                                    )}
                                    <div>
                                        <p className="font-permanent text-xs text-zinc-400 uppercase mb-1">Created</p>
                                        <p className="font-permanent text-black dark:text-white uppercase text-sm">
                                            {new Date(task.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }).toUpperCase()}
                                        </p>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Quick Status Update */}
                        <div className="p-4 border-4 border-black bg-zinc-100 dark:bg-zinc-800">
                            <p className="font-permanent text-xs text-zinc-500 uppercase mb-2">Quick Update Status</p>
                            <div className="flex gap-2 flex-wrap">
                                {['Not Started', 'In Progress', 'Completed'].map(s => (
                                    <button
                                        key={s}
                                        onClick={async () => {
                                            const res = await fetch(`/api/tasks/${id}`, {
                                                method: 'PUT',
                                                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
                                                body: JSON.stringify({ ...task, status: s }),
                                            });
                                            if (res.ok) setTask({ ...task, status: s });
                                        }}
                                        className={`px-3 py-2 border-2 border-black font-permanent uppercase text-xs transition-colors ${task.status === s ? 'bg-black text-yellow-400' : 'bg-white text-black hover:bg-zinc-200'}`}
                                    >
                                        {s}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
