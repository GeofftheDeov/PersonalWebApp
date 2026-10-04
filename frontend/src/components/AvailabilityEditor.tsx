"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Save, X, Globe, Eye, CalendarX, CalendarCheck, RefreshCw, Link2 } from 'lucide-react';

/**
 * Regular availability (#57): the weekly windows a player can usually play,
 * one-off exceptions, busy time from their own Google Calendar (#84), and a
 * preview of exactly what the party's overlap will say about them. Backed by
 * /api/availability/me.
 */

const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const HALF_HOUR = 30 * 60 * 1000;
/** How far ahead "What your party sees" looks: the coming weeks, not just this one (#83). */
const PREVIEW_DAYS = 14;

interface WindowRow { weekday: number; start: string; end: string }
interface AvailabilityException { id: string; start: string; end: string; kind: 'unavailable' | 'available'; note: string | null }
interface Run { start: string; end: string; presence: 'free' | 'busy' | 'unknown' }
interface BusySource {
    source: 'google' | 'discord';
    enabled: boolean;
    connected: boolean;
    ready: boolean;
    needsReconsent: boolean;
    problem: string | null;
    syncedAt: string | null;
    lastError: string | null;
    freshMinutes: number;
}

const SOURCE_LABEL: Record<BusySource['source'], string> = { google: 'Google Calendar', discord: 'Discord events' };

const ago = (iso: string) => {
    const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
};

const CARD_CLS = "p-5 border-4 border-black dark:border-white bg-zinc-200 dark:bg-slate-800 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]";
const FIELD_CLS = "p-2 border-2 border-black bg-white text-black font-permanent text-sm uppercase outline-none focus:border-teal-500";
const BTN_CLS = "flex items-center justify-center gap-2 px-4 py-2 border-2 border-black font-permanent uppercase text-xs transition-colors shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] disabled:opacity-40";
const HEADING_CLS = "text-3xl sm:text-4xl md:text-5xl font-permanent text-yellow-400 uppercase relative w-fit mb-3";
const REMOVE_CLS = "p-1 border-2 border-black bg-white text-black hover:bg-red-600 hover:text-white transition-colors shrink-0";

const browserTimeZone = () => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
};
const allTimeZones = (): string[] => {
    try { return (Intl as any).supportedValuesOf('timeZone'); } catch { return []; }
};

/** "18:30" -> "6:30 PM" */
const clock = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
};
const dayLabel = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();
const timeLabel = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toUpperCase();
const isMidnight = (d: Date) => d.getHours() === 0 && d.getMinutes() === 0;

function describeException(x: AvailabilityException) {
    const s = new Date(x.start), e = new Date(x.end);
    if (isMidnight(s) && isMidnight(e)) {
        const last = new Date(e.getTime() - 1);
        return last.toDateString() === s.toDateString() ? `${dayLabel(s)} · ALL DAY` : `${dayLabel(s)} – ${dayLabel(last)}`;
    }
    return s.toDateString() === e.toDateString() || e.getTime() - s.getTime() < 24 * 60 * 60 * 1000
        ? `${dayLabel(s)} · ${timeLabel(s)} – ${timeLabel(e)}`
        : `${dayLabel(s)} ${timeLabel(s)} – ${dayLabel(e)} ${timeLabel(e)}`;
}

const PRESENCE_CLS: Record<Run['presence'], string> = {
    free: 'bg-teal-500',
    busy: 'bg-zinc-500 dark:bg-zinc-900',
    unknown: 'bg-[repeating-linear-gradient(45deg,#facc15_0_3px,transparent_3px_7px)]',
};

/** `googleNotice`: what came back from Google's consent screen, when it sent the person here. */
export default function AvailabilityEditor({ googleNotice }: { googleNotice?: string | null } = {}) {
    const [loading, setLoading] = useState(true);
    const [rows, setRows] = useState<WindowRow[]>([]);
    const [timeZone, setTimeZone] = useState(browserTimeZone);
    const [savedSnapshot, setSavedSnapshot] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    const [exceptions, setExceptions] = useState<AvailabilityException[]>([]);
    const [xForm, setXForm] = useState({ kind: 'unavailable' as 'unavailable' | 'available', date: '', allDay: true, start: '18:00', end: '23:00', note: '' });
    const [xError, setXError] = useState<string | null>(null);
    const [addingException, setAddingException] = useState(false);

    const [sources, setSources] = useState<BusySource[]>([]);
    const [sourceBusy, setSourceBusy] = useState<string | null>(null);
    const [sourceError, setSourceError] = useState<string | null>(null);

    const [runs, setRuns] = useState<Run[]>([]);
    const [previewFrom] = useState(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; });

    const zones = useMemo(() => {
        const list = allTimeZones();
        return list.includes(timeZone) ? list : [timeZone, ...list];
    }, [timeZone]);

    const headers = useCallback((): Record<string, string> => ({
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('token')}`,
    }), []);

    const snapshot = (r: WindowRow[], tz: string) => JSON.stringify({ r, tz });
    const dirty = !loading && snapshot(rows, timeZone) !== savedSnapshot;

    const loadPreview = useCallback(async () => {
        const to = new Date(previewFrom);
        to.setDate(to.getDate() + PREVIEW_DAYS);
        const res = await fetch(`/api/availability/me/preview?start=${previewFrom.toISOString()}&end=${to.toISOString()}`, { headers: headers() });
        if (res.ok) setRuns((await res.json()).runs);
    }, [headers, previewFrom]);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('/api/availability/me', { headers: headers() });
                if (!res.ok) { setError('Could not load your availability.'); return; }
                const data = await res.json();
                const loaded: WindowRow[] = data.windows.map((w: any) => ({ weekday: w.weekday, start: w.start, end: w.end }));
                const tz = data.windows[0]?.timeZone ?? browserTimeZone();
                setRows(loaded);
                setTimeZone(tz);
                setSavedSnapshot(snapshot(loaded, tz));
                setExceptions(data.exceptions);
                const src = await fetch('/api/availability/me/busy-sources', { headers: headers() });
                if (src.ok) setSources((await src.json()).sources);
                await loadPreview();
            } catch {
                setError('Could not load your availability.');
            } finally {
                setLoading(false);
            }
        })();
    }, [headers, loadPreview]);

    const updateRow = (i: number, patch: Partial<WindowRow>) =>
        setRows(prev => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

    const addRow = () => {
        const last = rows[rows.length - 1];
        setRows(prev => [...prev, last ? { ...last, weekday: (last.weekday + 1) % 7 } : { weekday: 6, start: '18:00', end: '23:00' }]);
    };

    const saveWindows = async () => {
        setSaving(true);
        setError(null);
        setNotice(null);
        try {
            const res = await fetch('/api/availability/me/windows', {
                method: 'PUT', headers: headers(),
                body: JSON.stringify({ windows: rows.map(r => ({ ...r, timeZone })) }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) { setError(data.error || 'Could not save your week.'); return; }
            const saved: WindowRow[] = data.windows.map((w: any) => ({ weekday: w.weekday, start: w.start, end: w.end }));
            setRows(saved);
            setSavedSnapshot(snapshot(saved, timeZone));
            setNotice('Saved.');
            await loadPreview();
        } catch {
            setError('Could not save your week.');
        } finally {
            setSaving(false);
        }
    };

    const addException = async (e: React.FormEvent) => {
        e.preventDefault();
        setXError(null);
        if (!xForm.date) { setXError('Pick a date.'); return; }
        const [y, m, d] = xForm.date.split('-').map(Number);
        let start: Date, end: Date;
        if (xForm.allDay) {
            start = new Date(y, m - 1, d);
            end = new Date(y, m - 1, d + 1);
        } else {
            const [sh, sm] = xForm.start.split(':').map(Number);
            const [eh, em] = xForm.end.split(':').map(Number);
            if (sh * 60 + sm === eh * 60 + em) { setXError('Start and end can’t be the same time.'); return; }
            start = new Date(y, m - 1, d, sh, sm);
            end = new Date(y, m - 1, d + (eh * 60 + em <= sh * 60 + sm ? 1 : 0), eh, em);
        }
        setAddingException(true);
        try {
            const res = await fetch('/api/availability/me/exceptions', {
                method: 'POST', headers: headers(),
                body: JSON.stringify({ start: start.toISOString(), end: end.toISOString(), kind: xForm.kind, note: xForm.note }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) { setXError(data.error || 'Could not add that exception.'); return; }
            setExceptions(prev => [...prev, data.exception].sort((a, b) => a.start.localeCompare(b.start)));
            setXForm(f => ({ ...f, date: '', note: '' }));
            await loadPreview();
        } catch {
            setXError('Could not add that exception.');
        } finally {
            setAddingException(false);
        }
    };

    const removeException = async (id: string) => {
        const res = await fetch(`/api/availability/me/exceptions/${id}`, { method: 'DELETE', headers: headers() });
        if (res.ok || res.status === 404) {
            setExceptions(prev => prev.filter(x => x.id !== id));
            await loadPreview();
        }
    };

    /** Google's consent screen, coming back to this tab. Used to connect, and to re-consent once for free/busy. */
    const connectGoogle = async () => {
        setSourceError(null);
        const res = await fetch('/api/google-calendar/auth-url?return=availability', { headers: headers() });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.url) window.location.href = data.url;
        else setSourceError(data.error || 'Google Calendar is not set up on this server.');
    };

    /** Turn a source on or off, or sync it now. */
    const changeSource = async (source: BusySource['source'], action: 'on' | 'off' | 'sync') => {
        setSourceBusy(`${source}:${action}`);
        setSourceError(null);
        try {
            const path = `/api/availability/me/busy-sources/${source}${action === 'sync' ? '/sync' : ''}`;
            const res = await fetch(path, { method: action === 'on' ? 'PUT' : action === 'off' ? 'DELETE' : 'POST', headers: headers() });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) { setSourceError(data.error || 'That didn’t work. Try again.'); return; }
            const list = await fetch('/api/availability/me/busy-sources', { headers: headers() });
            if (list.ok) setSources((await list.json()).sources);
            await loadPreview();
        } catch {
            setSourceError('That didn’t work. Try again.');
        } finally {
            setSourceBusy(null);
        }
    };

    const previewDays = useMemo(() => Array.from({ length: PREVIEW_DAYS }, (_, i) => {
        const start = new Date(previewFrom);
        start.setDate(start.getDate() + i);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        const cells: Run['presence'][] = [];
        for (let t = start.getTime(); t < end.getTime(); t += HALF_HOUR) {
            const run = runs.find(r => Date.parse(r.start) <= t && t < Date.parse(r.end));
            cells.push(run?.presence ?? 'unknown');
        }
        return { start, cells };
    }), [previewFrom, runs]);

    if (loading) {
        return <p className="font-permanent text-xl text-teal-600 uppercase animate-pulse">Loading availability...</p>;
    }

    return (
        <div className="space-y-14">
            {/* ── Weekly windows ── */}
            <section aria-labelledby="weekly-h">
                <h2 id="weekly-h" className={HEADING_CLS}>
                    <span className="drop-shadow-[4px_4px_0px_rgba(0,0,0,1)]">When You Can Play</span>
                </h2>
                <p className="font-permanent text-xs text-zinc-500 dark:text-zinc-400 uppercase mb-6 max-w-2xl">
                    Your regular week. When your Game Master plans a session, these become the overlap they pick a night from.
                    The party only ever sees free or busy, never why.
                </p>

                <div className={CARD_CLS}>
                    <div className="flex flex-wrap items-end gap-3 mb-5">
                        <label className="flex flex-col gap-1 min-w-0 flex-1 sm:flex-none">
                            <span className="font-permanent text-xs text-teal-600 dark:text-teal-400 uppercase flex items-center gap-1"><Globe className="w-3 h-3" /> Time zone</span>
                            <select value={timeZone} onChange={e => setTimeZone(e.target.value)} className={`${FIELD_CLS} max-w-full sm:w-72 normal-case`}>
                                {zones.map(z => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
                            </select>
                        </label>
                        {timeZone !== browserTimeZone() && (
                            <p className="font-permanent text-[10px] text-yellow-700 dark:text-yellow-400 uppercase pb-2">
                                This device is set to {browserTimeZone().replace(/_/g, ' ')}.
                            </p>
                        )}
                    </div>

                    {rows.length === 0 ? (
                        <p className="font-permanent text-sm text-zinc-500 dark:text-zinc-400 uppercase py-4">
                            No weekly windows yet. Until you add some, you show as &ldquo;unknown&rdquo; to your party, not &ldquo;busy&rdquo;.
                        </p>
                    ) : (
                        <ul className="space-y-2">
                            {rows.map((r, i) => (
                                <li key={i} className="flex flex-wrap items-center gap-2 p-2 border-2 border-black bg-white dark:bg-slate-700">
                                    <select aria-label="Day" value={r.weekday} onChange={e => updateRow(i, { weekday: Number(e.target.value) })} className={FIELD_CLS}>
                                        {DAYS.map((d, n) => <option key={d} value={n}>{d}</option>)}
                                    </select>
                                    <input aria-label="From" type="time" step={900} required value={r.start} onChange={e => updateRow(i, { start: e.target.value })} className={FIELD_CLS} />
                                    <span className="font-permanent text-xs text-zinc-500 dark:text-zinc-300">TO</span>
                                    <input aria-label="Until" type="time" step={900} required value={r.end} onChange={e => updateRow(i, { end: e.target.value })} className={FIELD_CLS} />
                                    {r.end && r.start && r.end <= r.start && r.end !== r.start && (
                                        <span className="px-2 py-0.5 border-2 border-black bg-yellow-400 text-black font-permanent text-[10px] uppercase">
                                            Ends {DAYS[(r.weekday + 1) % 7]} {clock(r.end)}
                                        </span>
                                    )}
                                    <button type="button" onClick={() => setRows(prev => prev.filter((_, j) => j !== i))}
                                        className={`ml-auto ${REMOVE_CLS}`} aria-label={`Remove ${DAYS[r.weekday]} window`}>
                                        <X className="w-4 h-4" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}

                    <div className="flex flex-wrap items-center gap-3 mt-5">
                        <button type="button" onClick={addRow} className={`${BTN_CLS} bg-white text-black hover:bg-yellow-400`}>
                            <Plus className="w-4 h-4" /> Add a window
                        </button>
                        <button type="button" onClick={saveWindows} disabled={!dirty || saving} className={`${BTN_CLS} bg-teal-600 text-white hover:bg-teal-500`}>
                            <Save className="w-4 h-4" /> {saving ? 'Saving...' : 'Save my week'}
                        </button>
                        {dirty && !saving && <span className="font-permanent text-[10px] text-yellow-700 dark:text-yellow-400 uppercase">Unsaved changes</span>}
                        {notice && !dirty && <span className="font-permanent text-xs text-teal-600 dark:text-teal-400 uppercase">{notice}</span>}
                    </div>
                    {error && <p role="alert" className="mt-3 font-permanent text-xs text-red-600 dark:text-red-400 uppercase">{error}</p>}
                </div>
            </section>

            {/* ── Exceptions ── */}
            <section aria-labelledby="exceptions-h">
                <h2 id="exceptions-h" className={HEADING_CLS}>
                    <span className="drop-shadow-[4px_4px_0px_rgba(0,0,0,1)]">Exceptions</span>
                </h2>
                <p className="font-permanent text-xs text-zinc-500 dark:text-zinc-400 uppercase mb-6 max-w-2xl">
                    One-off changes that leave your regular week alone: out of town on the 17th, free this Tuesday only.
                </p>

                <div className={CARD_CLS}>
                    <form onSubmit={addException} className="flex flex-wrap items-end gap-3">
                        <div className="flex border-2 border-black" role="radiogroup" aria-label="Kind">
                            {([['unavailable', 'Out', CalendarX], ['available', 'Free', CalendarCheck]] as const).map(([kind, label, Icon]) => (
                                <button key={kind} type="button" role="radio" aria-checked={xForm.kind === kind}
                                    onClick={() => setXForm(f => ({ ...f, kind, allDay: kind === 'unavailable' ? f.allDay : false }))}
                                    className={`flex items-center gap-1 px-3 py-2 font-permanent text-xs uppercase transition-colors ${xForm.kind === kind ? (kind === 'unavailable' ? 'bg-zinc-800 text-white' : 'bg-teal-600 text-white') : 'bg-white text-black hover:bg-zinc-100'}`}>
                                    <Icon className="w-4 h-4" /> {label}
                                </button>
                            ))}
                        </div>
                        <input aria-label="Date" type="date" value={xForm.date} onChange={e => setXForm(f => ({ ...f, date: e.target.value }))} className={FIELD_CLS} />
                        <label className="flex items-center gap-2 font-permanent text-xs uppercase text-black dark:text-white py-2">
                            <input type="checkbox" checked={xForm.allDay} onChange={e => setXForm(f => ({ ...f, allDay: e.target.checked }))} className="w-4 h-4 accent-teal-600" />
                            All day
                        </label>
                        {!xForm.allDay && (
                            <>
                                <input aria-label="From" type="time" step={900} value={xForm.start} onChange={e => setXForm(f => ({ ...f, start: e.target.value }))} className={FIELD_CLS} />
                                <span className="font-permanent text-xs text-zinc-500 dark:text-zinc-300 pb-2">TO</span>
                                <input aria-label="Until" type="time" step={900} value={xForm.end} onChange={e => setXForm(f => ({ ...f, end: e.target.value }))} className={FIELD_CLS} />
                            </>
                        )}
                        <input aria-label="Note (optional)" placeholder="NOTE (OPTIONAL)" maxLength={200} value={xForm.note}
                            onChange={e => setXForm(f => ({ ...f, note: e.target.value }))} className={`${FIELD_CLS} flex-1 min-w-[10rem]`} />
                        <button type="submit" disabled={addingException} className={`${BTN_CLS} bg-yellow-400 text-black hover:bg-white`}>
                            <Plus className="w-4 h-4" /> {addingException ? 'Adding...' : 'Add'}
                        </button>
                    </form>
                    {xError && <p role="alert" className="mt-3 font-permanent text-xs text-red-600 dark:text-red-400 uppercase">{xError}</p>}

                    {exceptions.length > 0 && (
                        <ul className="mt-5 space-y-2">
                            {exceptions.map(x => (
                                <li key={x.id} className="flex items-center gap-3 p-2 border-2 border-black bg-white dark:bg-slate-700">
                                    <span className={`px-2 py-0.5 border-2 border-black font-permanent text-[10px] uppercase shrink-0 ${x.kind === 'unavailable' ? 'bg-zinc-800 text-white' : 'bg-teal-600 text-white'}`}>
                                        {x.kind === 'unavailable' ? 'Out' : 'Free'}
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <p className="font-permanent text-sm text-black dark:text-white uppercase">{describeException(x)}</p>
                                        {x.note && <p className="font-permanent text-[10px] text-zinc-500 dark:text-zinc-300 uppercase truncate">{x.note}</p>}
                                    </div>
                                    <button type="button" onClick={() => removeException(x.id)} className={REMOVE_CLS} aria-label="Remove exception">
                                        <X className="w-4 h-4" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </section>

            {/* ── Busy time from outside calendars (#84) ── */}
            {sources.length > 0 && (
                <section aria-labelledby="busy-h">
                    <h2 id="busy-h" className={HEADING_CLS}>
                        <span className="drop-shadow-[4px_4px_0px_rgba(0,0,0,1)]">Busy From Your Calendar</span>
                    </h2>
                    <p className="font-permanent text-xs text-zinc-500 dark:text-zinc-400 uppercase mb-6 max-w-2xl">
                        Let your real commitments count without typing them in. The app reads only when you&rsquo;re busy, never
                        what the event is, and your party sees busy without knowing where it came from.
                    </p>

                    <div className={`${CARD_CLS} space-y-3`}>
                        {googleNotice && (
                            <p role="status" className="font-permanent text-xs text-teal-600 dark:text-yellow-400 uppercase">{googleNotice}</p>
                        )}
                        {sources.map(s => {
                            const working = sourceBusy?.startsWith(`${s.source}:`);
                            return (
                                <div key={s.source} className="flex flex-wrap items-center gap-3 p-3 border-2 border-black bg-white dark:bg-slate-700">
                                    <div className="min-w-[12rem] flex-1">
                                        <p className="font-permanent text-sm text-black dark:text-white uppercase flex items-center gap-2">
                                            {SOURCE_LABEL[s.source]}
                                            <span className={`px-2 py-0.5 border-2 border-black text-[10px] ${s.enabled ? 'bg-teal-600 text-white' : 'bg-zinc-200 text-black'}`}>
                                                {s.enabled ? 'On' : 'Off'}
                                            </span>
                                        </p>
                                        <p className="font-permanent text-[10px] text-zinc-500 dark:text-zinc-300 uppercase mt-1">
                                            {s.enabled
                                                ? (s.syncedAt ? `Synced ${ago(s.syncedAt)} · refreshed when older than ${s.freshMinutes} min` : 'Not synced yet')
                                                : s.needsReconsent
                                                    ? 'Google needs to ask you once more, so the app can see when you’re busy.'
                                                    : s.ready ? 'Off: your Google busy time doesn’t count yet.' : (s.problem ?? 'Not connected.')}
                                        </p>
                                        {s.enabled && s.lastError && (
                                            <p role="alert" className="font-permanent text-[10px] text-red-600 dark:text-red-400 uppercase mt-1">
                                                Last sync failed: {s.lastError} Until it works, your party sees your regular week.
                                            </p>
                                        )}
                                    </div>
                                    {s.source === 'google' && (!s.connected || s.needsReconsent) && (
                                        <button type="button" onClick={connectGoogle} className={`${BTN_CLS} bg-yellow-400 text-black hover:bg-white`}>
                                            <Link2 className="w-4 h-4" /> {s.connected ? 'Reconnect Google' : 'Connect Google'}
                                        </button>
                                    )}
                                    {s.enabled && (
                                        <button type="button" disabled={working} onClick={() => changeSource(s.source, 'sync')}
                                            className={`${BTN_CLS} bg-white text-black hover:bg-yellow-400`}>
                                            <RefreshCw className={`w-4 h-4 ${sourceBusy === `${s.source}:sync` ? 'animate-spin' : ''}`} /> Sync now
                                        </button>
                                    )}
                                    {(s.enabled || s.ready) && (
                                        <button type="button" disabled={working} onClick={() => changeSource(s.source, s.enabled ? 'off' : 'on')}
                                            className={`${BTN_CLS} ${s.enabled ? 'bg-zinc-800 text-white hover:bg-red-600' : 'bg-teal-600 text-white hover:bg-teal-500'}`}>
                                            {s.enabled ? 'Turn off' : 'Turn on'}
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                        {sourceError && <p role="alert" className="font-permanent text-xs text-red-600 dark:text-red-400 uppercase">{sourceError}</p>}
                    </div>
                </section>
            )}

            {/* ── Preview ── */}
            <section aria-labelledby="preview-h">
                <h2 id="preview-h" className={HEADING_CLS}>
                    <span className="drop-shadow-[4px_4px_0px_rgba(0,0,0,1)]">What Your Party Sees</span>
                </h2>
                <p className="font-permanent text-xs text-zinc-500 dark:text-zinc-400 uppercase mb-6 max-w-2xl">
                    The next two weeks, exactly as the Game Master&rsquo;s overlap will count you, calendar busy time included.
                    Saved changes only.
                </p>

                <div className={CARD_CLS}>
                    <div className="flex flex-wrap gap-4 mb-4 font-permanent text-[10px] uppercase text-black dark:text-white">
                        {(['free', 'busy', 'unknown'] as const).map(p => (
                            <span key={p} className="flex items-center gap-1.5">
                                <span className={`inline-block w-5 h-3 border-2 border-black ${PRESENCE_CLS[p]}`} /> {p}
                            </span>
                        ))}
                    </div>
                    <div className="space-y-1.5" aria-describedby="preview-h">
                        <div className="flex items-end gap-2">
                            <span className="w-20 sm:w-28 shrink-0" />
                            <div className="flex-1 grid grid-cols-4 font-permanent text-[9px] text-zinc-500 dark:text-zinc-400">
                                <span>12A</span><span>6A</span><span>12P</span><span>6P</span>
                            </div>
                        </div>
                        {previewDays.map(day => (
                            <div key={day.start.toISOString()} className="flex items-center gap-2">
                                <span className="w-20 sm:w-28 shrink-0 font-permanent text-[10px] sm:text-xs text-black dark:text-white uppercase truncate">{dayLabel(day.start)}</span>
                                <div className="flex-1 flex h-5 border-2 border-black bg-white" role="img"
                                    aria-label={`${dayLabel(day.start)}: ${day.cells.filter(c => c === 'free').length / 2} hours free`}>
                                    {day.cells.map((presence, i) => (
                                        <span key={i} className={`flex-1 ${PRESENCE_CLS[presence]} ${i % 12 === 0 && i ? 'border-l border-black/40' : ''}`} />
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </section>
        </div>
    );
}
