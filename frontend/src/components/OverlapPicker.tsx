"use client";

import { useEffect, useMemo, useState } from 'react';
import { Send, X, Star } from 'lucide-react';

/**
 * The Game Master's overlap grid (#57, stories 17-19): when the party is free
 * over a date range, as a heat grid of start times with a headcount in each
 * cell, plus the best workable times. The GM picks 2-4 and sends them to the
 * party. Backed by GET /api/availability/campaigns/:id (GM only).
 */

interface Slot { start: string; end: string; headcount: number; meetsQuorum: boolean; free: string[]; busy: string[]; unknown: string[] }
interface Overlap { quorum: number; party: { id: string; name: string }[]; slots: Slot[]; notes?: string[] }
export interface PickedTime { start: string; end: string }

const FIELD_CLS = "p-2 border-2 border-black bg-white text-black font-permanent text-xs uppercase outline-none focus:border-teal-500";
const MAX_PICKS = 4;

const pad = (n: number) => String(n).padStart(2, '0');
const todayInput = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const hourLabel = (h: number) => `${h % 12 || 12}${h < 12 ? 'A' : 'P'}`;
export const timeRange = (start: string, end: string) => {
    const s = new Date(start), e = new Date(end);
    const day = s.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const t = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `${day} · ${t(s)} – ${t(e)}`.toUpperCase();
};

function heat(slot: Slot | undefined, partySize: number) {
    if (!slot || !slot.headcount) return 'bg-white dark:bg-slate-700 text-zinc-400';
    const share = slot.headcount / Math.max(1, partySize);
    if (share >= 1) return 'bg-teal-700 text-white';
    if (share >= 0.75) return 'bg-teal-500 text-white';
    if (share >= 0.5) return 'bg-teal-300 text-black';
    return 'bg-teal-100 text-black';
}

export default function OverlapPicker({ campaignId, submitLabel, submitting, onSubmit, onCancel }: {
    campaignId: string;
    submitLabel: string;
    submitting: boolean;
    onSubmit: (times: PickedTime[]) => void;
    onCancel?: () => void;
}) {
    const [from, setFrom] = useState(todayInput);
    const [days, setDays] = useState(14);
    const [hours, setHours] = useState(4);
    const [data, setData] = useState<Overlap | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [picked, setPicked] = useState<PickedTime[]>([]);

    const rangeStart = useMemo(() => { const [y, m, d] = from.split('-').map(Number); return new Date(y, m - 1, d); }, [from]);

    useEffect(() => {
        if (!from) return;
        const end = new Date(rangeStart);
        end.setDate(end.getDate() + days);
        setLoading(true);
        setError(null);
        const qs = new URLSearchParams({ start: rangeStart.toISOString(), end: end.toISOString(), slotMinutes: String(hours * 60), stepMinutes: '30' });
        fetch(`/api/availability/campaigns/${campaignId}?${qs}`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } })
            .then(async res => {
                const body = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(body.error || 'Could not load the party’s availability.');
                setData(body);
            })
            .catch(err => { setData(null); setError(err.message); })
            .finally(() => setLoading(false));
    }, [campaignId, from, rangeStart, days, hours]);

    // A new session length changes every candidate's end time.
    useEffect(() => setPicked([]), [hours]);

    const names = useMemo(() => new Map((data?.party ?? []).map(p => [p.id, p.name])), [data]);
    const list = (ids: string[]) => ids.map(id => names.get(id) ?? '?').join(', ') || 'nobody';
    const isPicked = (s: Slot) => picked.some(p => p.start === s.start);
    const toggle = (s: Slot) => setPicked(prev =>
        prev.some(p => p.start === s.start) ? prev.filter(p => p.start !== s.start)
            : prev.length >= MAX_PICKS ? prev : [...prev, { start: s.start, end: s.end }].sort((a, b) => a.start.localeCompare(b.start)));

    // Grid: one row per local day, one column per local hour anyone is free at.
    const grid = useMemo(() => {
        if (!data) return null;
        // Times already past can't go on a shortlist, so they aren't offered.
        const now = Date.now();
        const byStart = new Map(data.slots.filter(s => Date.parse(s.start) > now).map(s => [Date.parse(s.start), s]));
        let lo = 24, hi = -1;
        for (const s of data.slots) {
            const d = new Date(s.start);
            if (s.headcount && d.getMinutes() === 0) { lo = Math.min(lo, d.getHours()); hi = Math.max(hi, d.getHours()); }
        }
        if (hi < 0) { lo = 17; hi = 22; }
        const cols = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
        const rows = Array.from({ length: days }, (_, i) => {
            const day = new Date(rangeStart);
            day.setDate(day.getDate() + i);
            return { day, cells: cols.map(h => byStart.get(new Date(day.getFullYear(), day.getMonth(), day.getDate(), h).getTime())) };
        });
        return { cols, rows };
    }, [data, days, rangeStart]);

    // Best times: the ranked slots, skipping any that overlap one already listed.
    const best = useMemo(() => {
        if (!data) return [];
        const out: Slot[] = [];
        const now = Date.now();
        for (const s of data.slots) {
            if (!s.headcount || Date.parse(s.start) <= now) continue;
            if (out.some(o => s.start < o.end && o.start < s.end)) continue;
            out.push(s);
            if (out.length === 6) break;
        }
        return out;
    }, [data]);

    const partySize = data?.party.length ?? 0;

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1">
                    <span className="font-permanent text-[10px] text-teal-700 dark:text-teal-300 uppercase">From</span>
                    <input type="date" value={from} min={todayInput()} onChange={e => setFrom(e.target.value || todayInput())} className={FIELD_CLS} />
                </label>
                <label className="flex flex-col gap-1">
                    <span className="font-permanent text-[10px] text-teal-700 dark:text-teal-300 uppercase">For</span>
                    <select value={days} onChange={e => setDays(Number(e.target.value))} className={FIELD_CLS}>
                        {[7, 14, 21, 28].map(n => <option key={n} value={n}>{n} days</option>)}
                    </select>
                </label>
                <label className="flex flex-col gap-1">
                    <span className="font-permanent text-[10px] text-teal-700 dark:text-teal-300 uppercase">Session length</span>
                    <select value={hours} onChange={e => setHours(Number(e.target.value))} className={FIELD_CLS}>
                        {[2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n} hours</option>)}
                    </select>
                </label>
                {data && <p className="font-permanent text-[10px] text-zinc-600 dark:text-zinc-300 uppercase pb-2">Quorum: {data.quorum} of {partySize}</p>}
            </div>

            {error && <p role="alert" className="font-permanent text-xs text-red-600 dark:text-red-400 uppercase">{error}</p>}
            {loading && !data && <p className="font-permanent text-xs text-teal-600 uppercase animate-pulse">Reading the party’s calendars...</p>}

            {data && (
                <>
                    {/* Why some busy time is missing, e.g. Discord can't be read (#85). Names no player. */}
                    {(data.notes ?? []).map(note => (
                        <p key={note} role="status" className="font-permanent text-[10px] text-zinc-700 dark:text-zinc-200 uppercase p-2 border-2 border-black bg-yellow-100 dark:bg-slate-700">
                            {note}
                        </p>
                    ))}
                    <div>
                        <p className="font-permanent text-xs text-black dark:text-white uppercase mb-2 flex items-center gap-1"><Star className="w-3 h-3 text-yellow-500" /> Best times</p>
                        {best.length === 0 ? (
                            <p className="font-permanent text-xs text-zinc-600 dark:text-zinc-300 uppercase">Nobody in the party has availability in this range yet.</p>
                        ) : (
                            <ul className="space-y-1.5">
                                {best.map(s => (
                                    <li key={s.start}>
                                        <button type="button" onClick={() => toggle(s)} aria-pressed={isPicked(s)}
                                            className={`w-full flex flex-wrap items-center gap-x-3 gap-y-1 p-2 border-2 border-black text-left transition-colors ${isPicked(s) ? 'bg-yellow-400 text-black' : 'bg-white dark:bg-slate-700 text-black dark:text-white hover:bg-yellow-100 dark:hover:bg-slate-600'}`}>
                                            <span className="font-permanent text-xs uppercase">{timeRange(s.start, s.end)}</span>
                                            <span className={`px-1.5 border-2 border-black font-permanent text-[10px] uppercase ${s.meetsQuorum ? 'bg-teal-600 text-white' : 'bg-zinc-200 text-black'}`}>
                                                {s.headcount}/{partySize} free{s.meetsQuorum ? '' : ' · below quorum'}
                                            </span>
                                            <span className="font-permanent text-[10px] uppercase opacity-80 w-full sm:w-auto">
                                                {s.busy.length ? `Busy: ${list(s.busy)}` : ''}{s.busy.length && s.unknown.length ? ' · ' : ''}{s.unknown.length ? `Unknown: ${list(s.unknown)}` : ''}
                                            </span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>

                    {grid && (
                        <div>
                            <p className="font-permanent text-xs text-black dark:text-white uppercase mb-2">Every start time · free count</p>
                            <div className="overflow-x-auto border-2 border-black bg-white dark:bg-slate-800">
                                <table className="border-separate border-spacing-0.5 font-permanent text-[10px]">
                                    <thead>
                                        <tr>
                                            <th className="sticky left-0 z-10 bg-white dark:bg-slate-800" />
                                            {grid.cols.map(h => <th key={h} scope="col" className="px-1 text-zinc-600 dark:text-zinc-300 font-normal">{hourLabel(h)}</th>)}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {grid.rows.map(({ day, cells }) => (
                                            <tr key={day.toISOString()}>
                                                <th scope="row" className="sticky left-0 z-10 bg-white dark:bg-slate-800 pr-2 text-left whitespace-nowrap text-black dark:text-white font-normal uppercase">
                                                    {day.toLocaleDateString(undefined, { weekday: 'short', month: 'numeric', day: 'numeric' })}
                                                </th>
                                                {cells.map((slot, i) => (
                                                    <td key={i} className="p-0">
                                                        {slot ? (
                                                            <button type="button" onClick={() => slot.headcount && toggle(slot)} disabled={!slot.headcount}
                                                                aria-pressed={isPicked(slot)}
                                                                aria-label={`${timeRange(slot.start, slot.end)}: ${slot.headcount} of ${partySize} free`}
                                                                title={`${timeRange(slot.start, slot.end)}\nFree: ${list(slot.free)}\nBusy: ${list(slot.busy)}\nUnknown: ${list(slot.unknown)}`}
                                                                className={`w-8 h-7 border ${isPicked(slot) ? 'bg-yellow-400 text-black border-2 border-black' : `${heat(slot, partySize)} ${slot.meetsQuorum ? 'border-2 border-black' : 'border-black/10'}`}`}>
                                                                {slot.headcount || ''}
                                                            </button>
                                                        ) : <span className="block w-8 h-7" />}
                                                    </td>
                                                ))}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            <p className="mt-1 font-permanent text-[10px] text-zinc-600 dark:text-zinc-300 uppercase">
                                Darker = more of the party free. A black outline meets quorum. Times are yours ({Intl.DateTimeFormat().resolvedOptions().timeZone.replace(/_/g, ' ')}).
                            </p>
                        </div>
                    )}
                </>
            )}

            <div className="pt-3 border-t-2 border-black/20 dark:border-white/20">
                <p className="font-permanent text-xs text-black dark:text-white uppercase mb-2">Shortlist ({picked.length}/{MAX_PICKS}) — pick 2 to 4</p>
                {picked.length > 0 && (
                    <ul className="flex flex-wrap gap-2 mb-3">
                        {picked.map(p => (
                            <li key={p.start} className="flex items-center gap-1 pl-2 border-2 border-black bg-yellow-400 text-black font-permanent text-[10px] uppercase">
                                {timeRange(p.start, p.end)}
                                <button type="button" onClick={() => setPicked(prev => prev.filter(x => x.start !== p.start))} className="p-1 hover:bg-black hover:text-yellow-400" aria-label="Remove from shortlist">
                                    <X className="w-3 h-3" />
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
                <div className="flex flex-wrap gap-2">
                    <button type="button" disabled={picked.length < 2 || submitting} onClick={() => onSubmit(picked)}
                        className="flex items-center gap-2 px-4 py-2 border-2 border-black bg-teal-600 text-white font-permanent uppercase text-xs hover:bg-teal-500 transition-colors shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] disabled:opacity-40">
                        <Send className="w-4 h-4" /> {submitting ? 'Sending...' : submitLabel}
                    </button>
                    {onCancel && (
                        <button type="button" onClick={onCancel} className="px-4 py-2 border-2 border-black bg-white text-black font-permanent uppercase text-xs hover:bg-zinc-100">Never mind</button>
                    )}
                </div>
            </div>
        </div>
    );
}
