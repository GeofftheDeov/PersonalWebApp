"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ClipboardList, Plus, X, Wifi, FastForward, RotateCcw, Ban, Check, Crown, CalendarClock, MapPin } from 'lucide-react';
import OverlapPicker, { timeRange, type PickedTime } from './OverlapPicker';

/**
 * The Notice Board (#57): the campaign's planning card. The Game Master
 * starts planning here, shortlists nights from the party's overlap, and
 * steers the vote; the party votes on every night they can make. Backed by
 * /api/planning.
 */

interface PollOption { id: string; start: string | null; end: string | null; approvals: string[]; meetsQuorum: boolean }
interface NightPoll {
    id: string; round: number; status: 'open' | 'closed'; result: 'winner' | 'tie' | 'no_quorum' | null;
    closedReason: string | null; quorum: number | null; eligibleIds: string[]; voted: string[];
    winningOptionId: string | null; tiedOptionIds: string[]; options: PollOption[];
}
interface PlanningState {
    session: { id: string; title: string; status: string; stage: string | null; isOnline: boolean; agenda: string | null; date: string | null; endDate: string | null };
    campaign: { id: string; title: string; gmTitle: string; tableLink: string | null };
    party: { id: string; name: string }[];
    quorum: number;
    viewer: { id: string; isGameMaster: boolean };
    night: NightPoll | null;
    /** Every round, oldest first; the last is `night`. */
    nightRounds: NightPoll[];
}
interface Upcoming { id: string; title: string; date: string; endDate: string | null; isOnline: boolean; canChangeNight: boolean }
interface Board { canPlan: boolean; gmTitle: string; planning: PlanningState[]; upcoming: Upcoming[] }

const whenOf = (start: string, end: string | null) => end ? timeRange(start, end) : new Date(start).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

const roundOutcome = (r: NightPoll) =>
    r.closedReason === 'gm_reshortlisted' ? 'replaced by a new shortlist'
    : r.closedReason === 'cancelled' ? 'cancelled'
    : r.result === 'no_quorum' ? 'failed: nothing reached quorum'
    : r.result === 'tie' ? 'tied'
    : r.result === 'winner' ? 'decided'
    : 'open';

/** Rounds before the current one, folded away: who voted for what stays on record. */
function EarlierRounds({ rounds, name }: { rounds: NightPoll[]; name: (id: string) => string }) {
    if (!rounds.length) return null;
    return (
        <details className="mt-4 border-2 border-black/30 dark:border-white/30 bg-white/60 dark:bg-slate-900/40">
            <summary className="cursor-pointer px-2 py-1.5 font-permanent text-[10px] uppercase text-zinc-700 dark:text-zinc-300">
                Earlier rounds ({rounds.length})
            </summary>
            <ol className="px-2 pb-2 space-y-2">
                {rounds.map(r => (
                    <li key={r.id}>
                        <p className="font-permanent text-[10px] uppercase text-black dark:text-white">Round {r.round} · {roundOutcome(r)}</p>
                        <ul className="mt-1 space-y-0.5">
                            {r.options.map(o => (
                                <li key={o.id} className={`font-permanent text-[10px] uppercase ${o.id === r.winningOptionId ? 'text-teal-700 dark:text-teal-300' : 'text-zinc-600 dark:text-zinc-400'}`}>
                                    {o.id === r.winningOptionId && <Check className="inline w-3 h-3 mr-0.5" />}
                                    {timeRange(o.start!, o.end!)} · {o.approvals.length} of {r.eligibleIds.length}
                                    {o.approvals.length ? ` · ${o.approvals.map(name).join(', ')}` : ''}
                                </li>
                            ))}
                        </ul>
                    </li>
                ))}
            </ol>
        </details>
    );
}

const BTN = "flex items-center gap-1.5 px-3 py-1.5 border-2 border-black font-permanent uppercase text-xs transition-colors shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] disabled:opacity-40";
const INPUT_CLS = "w-full p-2 border-2 border-black bg-white text-black font-permanent text-sm uppercase outline-none focus:border-teal-500";

const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` });

async function post(path: string, body?: unknown): Promise<{ ok: boolean; error?: string }> {
    try {
        const res = await fetch(path, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body ?? {}) });
        if (res.ok) return { ok: true };
        return { ok: false, error: (await res.json().catch(() => ({}))).error || 'Something went wrong.' };
    } catch {
        return { ok: false, error: 'Could not reach the server.' };
    }
}

function PlanningCard({ state, reload }: { state: PlanningState; reload: () => Promise<void> }) {
    const { session: s, night, viewer, campaign } = state;
    const gm = viewer.isGameMaster;
    const gmTitle = campaign.gmTitle;
    const name = (id: string) => state.party.find(p => p.id === id)?.name ?? 'someone';
    const base = `/api/planning/sessions/${s.id}`;

    const open = night?.status === 'open';
    const tie = night?.status === 'closed' && night.result === 'tie';
    const failed = night?.status === 'closed' && night.result === 'no_quorum';
    const needsShortlist = !open && !tie;

    const mine = useCallback(() => new Set((night?.options ?? []).filter(o => o.approvals.includes(viewer.id)).map(o => o.id)), [night, viewer.id]);
    const [choice, setChoice] = useState<Set<string>>(mine);
    useEffect(() => setChoice(mine()), [mine]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [reshortlisting, setReshortlisting] = useState(false);

    const act = async (path: string, body?: unknown) => {
        setBusy(true);
        setError(null);
        const r = await post(`${base}/${path}`, body);
        if (!r.ok) setError(r.error!);
        else setReshortlisting(false);
        await reload();
        setBusy(false);
    };
    const shortlist = (times: PickedTime[], replace: boolean) => act(replace ? 'reshortlist' : 'shortlist', { options: times });

    const eligible = Boolean(night?.eligibleIds.includes(viewer.id));
    const hasVoted = Boolean(night?.voted.includes(viewer.id));
    const waitingOn = night ? night.eligibleIds.filter(id => !night.voted.includes(id)) : [];

    const seal = open ? `Awaiting votes · ${night!.voted.length} of ${night!.eligibleIds.length}`
        : tie ? `Tie · the ${gmTitle} decides`
        : gm ? 'Pick some nights' : `Waiting on the ${gmTitle}`;

    return (
        <article className="p-5 border-4 border-black bg-amber-50 dark:bg-slate-800 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]">
            <header className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <p className="font-permanent text-[10px] text-zinc-600 dark:text-zinc-300 uppercase">A summons for the party</p>
                    <h3 className="font-permanent text-xl text-black dark:text-white uppercase leading-tight break-words">{s.title}</h3>
                    <p className="mt-1 font-permanent text-[10px] uppercase text-teal-700 dark:text-teal-300 flex items-center gap-1 flex-wrap">
                        {s.isOnline ? (
                            <>
                                <Wifi className="w-3 h-3" /> Online ·{' '}
                                {campaign.tableLink
                                    ? <a href={campaign.tableLink} target="_blank" rel="noopener noreferrer" className="underline break-all">{campaign.tableLink}</a>
                                    : 'no table link set yet'}
                            </>
                        ) : <><MapPin className="w-3 h-3" /> In person</>}
                    </p>
                </div>
                <span className={`px-3 py-1 border-2 border-black font-permanent text-[10px] uppercase whitespace-nowrap ${open ? 'bg-red-600 text-white' : tie ? 'bg-yellow-400 text-black' : 'bg-zinc-800 text-white'}`}>
                    {seal}
                </span>
            </header>
            {s.agenda && <p className="mt-2 font-permanent text-xs text-zinc-700 dark:text-zinc-300 uppercase">{s.agenda}</p>}

            <div className="mt-4 pt-4 border-t-2 border-black/20 dark:border-white/20">
                <h4 className="font-permanent text-sm text-black dark:text-white uppercase mb-3 flex items-center gap-2">
                    <span className="w-6 h-6 grid place-items-center border-2 border-black bg-red-600 text-white text-xs">1</span>
                    Pick the night
                    {night && <span className="font-permanent text-[10px] text-zinc-600 dark:text-zinc-300">round {night.round}</span>}
                </h4>

                {s.date && (
                    <p className="mb-3 p-2 border-2 border-black bg-teal-50 dark:bg-teal-900/40 font-permanent text-xs text-black dark:text-teal-100 uppercase flex items-start gap-1.5">
                        <CalendarClock className="w-4 h-4 shrink-0" />
                        <span>Changing the night. It’s set for {whenOf(s.date, s.endDate)} until a new night is confirmed.</span>
                    </p>
                )}

                {failed && (
                    <p className="mb-3 p-2 border-2 border-black bg-yellow-100 dark:bg-yellow-900/40 font-permanent text-xs text-black dark:text-yellow-100 uppercase">
                        Round {night!.round}: none of those times had enough of the party (needed {night!.quorum}).{gm ? ' Shortlist some new ones.' : ''}
                    </p>
                )}

                {open && (
                    <form onSubmit={e => { e.preventDefault(); act('vote', { optionIds: [...choice] }); }}>
                        <ul className="space-y-2">
                            {night!.options.map(o => {
                                const share = o.approvals.length / Math.max(1, night!.eligibleIds.length);
                                return (
                                    <li key={o.id} className="p-2 border-2 border-black bg-white dark:bg-slate-700">
                                        <label className={`flex items-start gap-2 ${eligible ? 'cursor-pointer' : ''}`}>
                                            {eligible && (
                                                <input type="checkbox" checked={choice.has(o.id)} className="mt-0.5 w-4 h-4 accent-teal-600 shrink-0"
                                                    aria-label={`I can make ${timeRange(o.start!, o.end!)}`}
                                                    onChange={e => setChoice(prev => { const n = new Set(prev); e.target.checked ? n.add(o.id) : n.delete(o.id); return n; })} />
                                            )}
                                            <span className="flex-1 min-w-0">
                                                <span className="flex flex-wrap items-center gap-2">
                                                    <span className="font-permanent text-xs text-black dark:text-white uppercase">{timeRange(o.start!, o.end!)}</span>
                                                    {o.meetsQuorum && <span className="px-1.5 border-2 border-black bg-teal-600 text-white font-permanent text-[9px] uppercase">Meets quorum</span>}
                                                </span>
                                                <span className="block h-1.5 mt-1.5 bg-black/10 dark:bg-white/10"><span className="block h-full bg-teal-600" style={{ width: `${share * 100}%` }} /></span>
                                                <span className="block mt-1 font-permanent text-[10px] text-zinc-600 dark:text-zinc-300 uppercase">
                                                    {o.approvals.length} of {night!.eligibleIds.length}{o.approvals.length ? ` · ${o.approvals.map(name).join(', ')}` : ''}
                                                </span>
                                            </span>
                                        </label>
                                    </li>
                                );
                            })}
                        </ul>
                        <p className="mt-2 font-permanent text-[10px] text-zinc-600 dark:text-zinc-300 uppercase">
                            Quorum: {night!.quorum} · closes when everyone has voted
                            {waitingOn.length ? ` · waiting on ${waitingOn.map(name).join(', ')}` : ''}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                            {eligible && (
                                <button type="submit" disabled={busy} className={`${BTN} bg-teal-600 text-white hover:bg-teal-500`}>
                                    <Check className="w-4 h-4" />
                                    {choice.size === 0 ? 'I can’t make any of these' : `${hasVoted ? 'Update my vote' : 'Vote'}: I can make ${choice.size}`}
                                </button>
                            )}
                            {gm && (
                                <>
                                    <button type="button" disabled={busy} onClick={() => act('advance')} className={`${BTN} bg-yellow-400 text-black hover:bg-white`}>
                                        <FastForward className="w-4 h-4" /> Move forward now
                                    </button>
                                    <button type="button" disabled={busy} onClick={() => setReshortlisting(r => !r)} className={`${BTN} bg-white text-black hover:bg-yellow-100`}>
                                        <RotateCcw className="w-4 h-4" /> Re-shortlist
                                    </button>
                                </>
                            )}
                        </div>
                        {hasVoted && <p className="mt-2 font-permanent text-[10px] text-teal-700 dark:text-teal-300 uppercase">You’ve voted — you can change it until the vote closes.</p>}
                    </form>
                )}

                {tie && (
                    <div>
                        <p className="mb-2 font-permanent text-xs text-black dark:text-white uppercase">
                            The vote tied. {gm ? 'Pick the night:' : `The ${gmTitle} will pick between:`}
                        </p>
                        <ul className="space-y-2">
                            {night!.options.filter(o => night!.tiedOptionIds.includes(o.id)).map(o => (
                                <li key={o.id} className="flex flex-wrap items-center gap-2 p-2 border-2 border-black bg-white dark:bg-slate-700">
                                    <span className="flex-1 font-permanent text-xs text-black dark:text-white uppercase">
                                        {timeRange(o.start!, o.end!)} · {o.approvals.length} of {night!.eligibleIds.length}
                                    </span>
                                    {gm && (
                                        <button type="button" disabled={busy} onClick={() => act('tiebreak', { optionId: o.id })} className={`${BTN} bg-yellow-400 text-black hover:bg-white`}>
                                            <Crown className="w-4 h-4" /> Pick this night
                                        </button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                {needsShortlist && !gm && !failed && (
                    <p className="font-permanent text-xs text-zinc-700 dark:text-zinc-300 uppercase">The {gmTitle} is choosing some nights to vote on.</p>
                )}
                {gm && (needsShortlist || tie || reshortlisting) && (
                    <div className={open || tie ? 'mt-4 pt-4 border-t-2 border-dashed border-black/30 dark:border-white/30' : ''}>
                        {(open || tie) && <p className="mb-2 font-permanent text-xs text-black dark:text-white uppercase">Or shortlist new times{open ? ' (this round’s votes are discarded)' : ''}:</p>}
                        <OverlapPicker campaignId={campaign.id} submitting={busy}
                            submitLabel={open || tie ? 'Re-shortlist' : 'Send to the party'}
                            onSubmit={times => shortlist(times, open)}
                            onCancel={reshortlisting ? () => setReshortlisting(false) : undefined} />
                    </div>
                )}

                <EarlierRounds rounds={state.nightRounds.slice(0, -1)} name={name} />
            </div>

            {error && <p role="alert" className="mt-3 font-permanent text-xs text-red-600 dark:text-red-400 uppercase">{error}</p>}

            {gm && (
                <div className="mt-4 pt-3 border-t-2 border-black/20 dark:border-white/20 flex justify-end">
                    <button type="button" disabled={busy}
                        onClick={() => { if (window.confirm(`Cancel planning "${s.title}"? The party will be told.`)) act('cancel'); }}
                        className="flex items-center gap-1 font-permanent text-[10px] uppercase text-red-700 dark:text-red-400 hover:underline">
                        <Ban className="w-3 h-3" /> Cancel planning
                    </button>
                </div>
            )}
        </article>
    );
}

/** A scheduled session still to come. The Game Master can change its night, which puts it back to a vote. */
function UpcomingRow({ campaignId, session: u, reload }: { campaignId: string; session: Upcoming; reload: () => Promise<void> }) {
    const [changing, setChanging] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const reopen = async (times: PickedTime[]) => {
        setBusy(true);
        setError(null);
        const r = await post(`/api/planning/sessions/${u.id}/reopen`, { options: times });
        setBusy(false);
        if (!r.ok) { setError(r.error!); return; }
        setChanging(false);
        await reload();
    };

    return (
        <li className="p-3 border-2 border-black bg-white dark:bg-slate-800">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <Link href={`/game-night/sessions/${u.id}`} className="min-w-0 hover:underline">
                    <span className="block font-permanent text-sm text-black dark:text-white uppercase break-words">{u.title}</span>
                    <span className="block font-permanent text-[10px] text-teal-700 dark:text-teal-300 uppercase">
                        {whenOf(u.date, u.endDate)} · {u.isOnline ? 'online' : 'in person'}
                    </span>
                </Link>
                {u.canChangeNight && !changing && (
                    <button type="button" onClick={() => setChanging(true)} className={`${BTN} bg-white text-black hover:bg-yellow-100`}>
                        <CalendarClock className="w-4 h-4" /> Change the night
                    </button>
                )}
            </div>
            {changing && (
                <div className="mt-3 pt-3 border-t-2 border-dashed border-black/30 dark:border-white/30">
                    <p className="mb-2 font-permanent text-xs text-black dark:text-white uppercase">
                        Shortlist new times. The party votes again; the current night stands until a new one is confirmed, then the Discord and calendar events move with it.
                    </p>
                    <OverlapPicker campaignId={campaignId} submitting={busy} submitLabel="Put it to a vote"
                        onSubmit={reopen} onCancel={() => setChanging(false)} />
                </div>
            )}
            {error && <p role="alert" className="mt-2 font-permanent text-xs text-red-600 dark:text-red-400 uppercase">{error}</p>}
        </li>
    );
}

export default function NoticeBoard({ campaignId, onSessionsChanged }: { campaignId: string; onSessionsChanged?: () => void }) {
    const [board, setBoard] = useState<Board | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [kickoff, setKickoff] = useState<{ title: string; agenda: string } | null>(null);
    const [starting, setStarting] = useState(false);
    const [kickoffError, setKickoffError] = useState<string | null>(null);
    const plannedIds = useRef<string | null>(null);

    const reload = useCallback(async () => {
        try {
            const res = await fetch(`/api/planning/campaigns/${campaignId}`, { headers: authHeaders() });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) { setError(body.error || 'Could not load the Notice Board.'); return; }
            // A session joining or leaving the board (kicked off, scheduled,
            // cancelled) changes the campaign's session list too.
            const ids = body.planning.map((p: PlanningState) => p.session.id).join();
            if (plannedIds.current !== null && plannedIds.current !== ids) onSessionsChanged?.();
            plannedIds.current = ids;
            setBoard(body);
            setError(null);
        } catch {
            setError('Could not load the Notice Board.');
        }
    }, [campaignId, onSessionsChanged]);

    useEffect(() => { reload(); }, [reload]);

    const start = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!kickoff) return;
        setStarting(true);
        setKickoffError(null);
        const r = await post(`/api/planning/campaigns/${campaignId}/kickoff`, { title: kickoff.title, agenda: kickoff.agenda, isOnline: true });
        setStarting(false);
        if (!r.ok) { setKickoffError(r.error!); return; }
        setKickoff(null);
        await reload();
    };

    if (error && !board) return <p className="font-permanent text-xs text-red-600 uppercase">{error}</p>;
    if (!board) return <p className="font-permanent text-sm text-teal-600 uppercase animate-pulse">Reading the Notice Board...</p>;

    return (
        <section aria-labelledby="notice-board-h">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <h2 id="notice-board-h" className="text-2xl font-permanent text-black dark:text-white uppercase flex items-center gap-2">
                    <ClipboardList className="w-5 h-5 text-red-600" /> The Notice Board
                </h2>
                {board.canPlan && !kickoff && (
                    <button type="button" onClick={() => setKickoff({ title: '', agenda: '' })}
                        className="flex items-center gap-2 px-3 py-1.5 border-2 border-black bg-yellow-400 text-black font-permanent uppercase text-xs hover:bg-white transition-colors shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">
                        <Plus className="w-3 h-3" /> Plan a session
                    </button>
                )}
            </div>

            {kickoff && (
                <form onSubmit={start} className="mb-5 p-4 border-4 border-black bg-slate-900 shadow-[6px_6px_0px_0px_rgba(13,148,136,1)] space-y-3">
                    <div className="flex items-center justify-between">
                        <p className="font-permanent text-sm text-white uppercase">Start planning</p>
                        <button type="button" onClick={() => setKickoff(null)} className="text-zinc-300 hover:text-white" aria-label="Close"><X className="w-5 h-5" /></button>
                    </div>
                    <label className="block">
                        <span className="block font-permanent text-[10px] text-teal-400 uppercase mb-1">Session title *</span>
                        <input required maxLength={120} value={kickoff.title} onChange={e => setKickoff({ ...kickoff, title: e.target.value })} className={INPUT_CLS} placeholder="SESSION 14: THE DROWNED CHAPEL" />
                    </label>
                    <label className="block">
                        <span className="block font-permanent text-[10px] text-teal-400 uppercase mb-1">Agenda (optional)</span>
                        <textarea rows={2} maxLength={2000} value={kickoff.agenda} onChange={e => setKickoff({ ...kickoff, agenda: e.target.value })} className={INPUT_CLS} />
                    </label>
                    <p className="font-permanent text-[10px] text-zinc-300 uppercase flex items-center gap-1">
                        <Wifi className="w-3 h-3 text-teal-400" /> Online session. In-person planning — venue and food — is coming next.
                    </p>
                    {kickoffError && <p role="alert" className="font-permanent text-xs text-red-400 uppercase">{kickoffError}</p>}
                    <button type="submit" disabled={starting || !kickoff.title.trim()} className={`${BTN} bg-teal-600 text-white hover:bg-teal-500`}>
                        {starting ? 'Starting...' : 'Start planning'}
                    </button>
                </form>
            )}

            {board.planning.length === 0 ? (
                <div className="py-8 px-4 border-4 border-dashed border-zinc-300 dark:border-zinc-700 text-center">
                    <p className="font-permanent text-sm text-zinc-500 dark:text-zinc-400 uppercase">
                        Nothing pinned up. When the {board.gmTitle} starts planning a session, the vote goes here.
                    </p>
                </div>
            ) : (
                <div className="space-y-5">
                    {board.planning.map(state => <PlanningCard key={state.session.id} state={state} reload={reload} />)}
                </div>
            )}

            {board.upcoming?.length > 0 && (
                <div className="mt-6">
                    <h3 className="mb-2 font-permanent text-sm text-black dark:text-white uppercase flex items-center gap-2">
                        <CalendarClock className="w-4 h-4 text-teal-600" /> Coming up
                    </h3>
                    <ul className="space-y-2">
                        {board.upcoming.map(u => <UpcomingRow key={u.id} campaignId={campaignId} session={u} reload={reload} />)}
                    </ul>
                </div>
            )}
        </section>
    );
}
