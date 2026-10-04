"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ClipboardList, Plus, X, Wifi, FastForward, RotateCcw, Ban, Check, Crown, CalendarClock, MapPin, Home, Store, Utensils } from 'lucide-react';
import OverlapPicker, { timeRange, type PickedTime } from './OverlapPicker';

/**
 * The Notice Board (#57): the campaign's planning card. The Game Master
 * starts planning here -- online, or in person with a food mode --
 * shortlists nights from the party's overlap, and steers the vote; the party
 * votes on every night they can make. In person, the venue vote follows
 * (#92): it starts with the campaign's recent venues, anyone can suggest
 * one, and each player picks one. Then the food (#93): a potluck, where the
 * Game Master seeds slots and the party claims them (unclaimed ones stand
 * out), or food provided by one person. Backed by /api/planning.
 */

/** A venue as the party sees it. The address is only sent while it's shortlisted or confirmed. */
interface Venue { id: string; name: string; kind: 'home' | 'store' | 'other'; hostId: string | null; address: string | null; lastUsedAt: string | null }
interface PollOption {
    id: string; start: string | null; end: string | null; venueId: string | null; suggestedBy: string | null;
    approvals: string[]; meetsQuorum: boolean; venue?: Venue | null;
}
interface Poll {
    id: string; round: number; status: 'open' | 'closed'; result: 'winner' | 'tie' | 'no_quorum' | null;
    closedReason: string | null; quorum: number | null; eligibleIds: string[]; voted: string[];
    winningOptionId: string | null; tiedOptionIds: string[]; options: PollOption[];
}
type NightPoll = Poll;
type FoodMode = 'potluck' | 'provided';
interface Member { id: string; name: string }
/** A food quest (#93): a potluck slot (no assignee: unclaimed), or the food owner's provisioning. */
interface FoodQuest { id: string; title: string; notes: string | null; assignee: Member | null; status: 'open' | 'done' | 'cancelled'; dueAt: string | null; createdBy: string | null }
interface PlanningState {
    session: {
        id: string; title: string; status: string; stage: 'night' | 'venue' | 'food' | null; isOnline: boolean; agenda: string | null;
        date: string | null; endDate: string | null; foodMode: FoodMode | null; foodOwnerId: string | null;
        venue: Venue | null; hostId: string | null;
    };
    campaign: { id: string; title: string; gmTitle: string; tableLink: string | null };
    party: Member[];
    quorum: number;
    viewer: { id: string; isGameMaster: boolean };
    night: NightPoll | null;
    /** Every round, oldest first; the last is `night`. */
    nightRounds: NightPoll[];
    /** In person: the latest venue round, each option carrying its venue. */
    venue: Poll | null;
    venueRounds: Poll[];
    /** In person: the campaign's saved venues, most recently used first. */
    venues: Venue[];
    /** In person (#93): how food works, and its quests in the order they were made. */
    food: { mode: FoodMode; ownerId: string | null; quests: FoodQuest[] } | null;
}
interface Upcoming { id: string; title: string; date: string; endDate: string | null; isOnline: boolean; canChangeNight: boolean; venue: Venue | null }
interface Board { canPlan: boolean; gmTitle: string; party: Member[]; planning: PlanningState[]; upcoming: Upcoming[] }

const kindLabel = (v: Venue, name: (id: string) => string) =>
    v.kind === 'home' ? (v.hostId ? `${name(v.hostId)}’s home` : 'a home') : v.kind === 'store' ? 'store' : 'venue';

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

/** A step's number badge; done steps go teal, steps still to come go grey. */
function StepHeading({ n, title, state, extra }: { n: number; title: string; state: 'now' | 'done' | 'later'; extra?: React.ReactNode }) {
    const badge = state === 'now' ? 'bg-red-600 text-white' : state === 'done' ? 'bg-teal-600 text-white' : 'bg-zinc-300 text-zinc-700';
    return (
        <h4 className={`font-permanent text-sm uppercase mb-3 flex items-center gap-2 ${state === 'later' ? 'text-zinc-500 dark:text-zinc-400' : 'text-black dark:text-white'}`}>
            <span className={`w-6 h-6 grid place-items-center border-2 border-black text-xs ${badge}`}>{state === 'done' ? <Check className="w-3 h-3" /> : n}</span>
            {title}
            {extra}
        </h4>
    );
}

/** One venue: its name, what it is, and its address when the party may see it. */
function VenueLine({ venue, name, note }: { venue: Venue; name: (id: string) => string; note?: string }) {
    return (
        <span className="block min-w-0">
            <span className="flex flex-wrap items-center gap-2">
                <span className="font-permanent text-xs text-black dark:text-white uppercase break-words">{venue.name}</span>
                <span className="px-1.5 border-2 border-black bg-white dark:bg-slate-900 text-black dark:text-white font-permanent text-[9px] uppercase flex items-center gap-1">
                    {venue.kind === 'home' ? <Home className="w-3 h-3" /> : venue.kind === 'store' ? <Store className="w-3 h-3" /> : <MapPin className="w-3 h-3" />}
                    {kindLabel(venue, name)}
                </span>
                {note && <span className="font-permanent text-[9px] text-zinc-500 dark:text-zinc-400 uppercase">{note}</span>}
            </span>
            {venue.address && (
                <span className="block mt-0.5 font-permanent text-[10px] text-zinc-600 dark:text-zinc-300 uppercase break-words">{venue.address}</span>
            )}
        </span>
    );
}

/** Suggest a venue for the open vote: a saved one, or a new one (the Game Master can name a host). */
function SuggestVenue({ state, busy, submit, onCancel }: {
    state: PlanningState; busy: boolean; submit: (body: unknown) => Promise<boolean>; onCancel: () => void;
}) {
    const gm = state.viewer.isGameMaster;
    const onVote = new Set(state.venue?.options.map(o => o.venueId) ?? []);
    const saved = state.venues.filter(v => !onVote.has(v.id));
    const [mode, setMode] = useState<'saved' | 'new'>(saved.length ? 'saved' : 'new');
    const [venueId, setVenueId] = useState(saved[0]?.id ?? '');
    // A home's host must be in the party; a stand-in GM or an admin may not be.
    const defaultHost = state.party.some(p => p.id === state.viewer.id) ? state.viewer.id : state.party[0]?.id ?? '';
    const [draft, setDraft] = useState({ name: '', address: '', kind: 'other' as Venue['kind'], hostId: defaultHost });
    const name = (id: string) => state.party.find(p => p.id === id)?.name ?? 'someone';

    const send = async (e: React.FormEvent) => {
        e.preventDefault();
        const body = mode === 'saved' ? { venueId }
            : { name: draft.name, address: draft.address, kind: draft.kind, ...(draft.kind === 'home' && gm ? { hostId: draft.hostId } : {}) };
        if (await submit(body)) onCancel();
    };

    return (
        <form onSubmit={send} className="mt-3 p-3 border-2 border-dashed border-black/40 dark:border-white/40 space-y-2">
            <div className="flex flex-wrap gap-3">
                {saved.length > 0 && (
                    <label className="flex items-center gap-1 font-permanent text-[10px] uppercase text-black dark:text-white">
                        <input type="radio" checked={mode === 'saved'} onChange={() => setMode('saved')} className="accent-teal-600" /> One of ours
                    </label>
                )}
                <label className="flex items-center gap-1 font-permanent text-[10px] uppercase text-black dark:text-white">
                    <input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} className="accent-teal-600" /> Somewhere new
                </label>
            </div>
            {mode === 'saved' ? (
                <select value={venueId} onChange={e => setVenueId(e.target.value)} className={INPUT_CLS} aria-label="Saved venue">
                    {saved.map(v => <option key={v.id} value={v.id}>{v.name} ({kindLabel(v, name)})</option>)}
                </select>
            ) : (
                <>
                    <input required maxLength={120} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} className={INPUT_CLS} placeholder="Name" aria-label="Venue name" />
                    <input maxLength={300} value={draft.address} onChange={e => setDraft({ ...draft, address: e.target.value })} className={INPUT_CLS} placeholder="Address (only the party sees it)" aria-label="Address" />
                    <div className="flex flex-wrap gap-2">
                        <select value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value as Venue['kind'] })} className={`${INPUT_CLS} sm:w-auto`} aria-label="Kind of venue">
                            <option value="home">{gm ? 'Someone’s home' : 'My home (I’ll host)'}</option>
                            <option value="store">A store</option>
                            <option value="other">Somewhere else</option>
                        </select>
                        {gm && draft.kind === 'home' && (
                            <select value={draft.hostId} onChange={e => setDraft({ ...draft, hostId: e.target.value })} className={`${INPUT_CLS} sm:w-auto`} aria-label="Host">
                                {state.party.map(p => <option key={p.id} value={p.id}>{p.id === state.viewer.id ? 'Me' : p.name}</option>)}
                            </select>
                        )}
                    </div>
                </>
            )}
            <div className="flex flex-wrap gap-2">
                <button type="submit" disabled={busy || (mode === 'saved' ? !venueId : !draft.name.trim())} className={`${BTN} bg-teal-600 text-white hover:bg-teal-500`}>
                    <Plus className="w-4 h-4" /> {gm ? 'Add to the vote' : 'Suggest it'}
                </button>
                <button type="button" onClick={onCancel} className={`${BTN} bg-white text-black hover:bg-yellow-100`}>Never mind</button>
            </div>
        </form>
    );
}

/** The venue step (#92): pick one; the Game Master steers the vote. */
function VenueStep({ state, busy, act }: { state: PlanningState; busy: boolean; act: (path: string, body?: unknown) => Promise<boolean> }) {
    const { venue: poll, viewer, campaign } = state;
    const gm = viewer.isGameMaster;
    const name = (id: string) => state.party.find(p => p.id === id)?.name ?? 'someone';
    const open = poll?.status === 'open';
    const tie = poll?.status === 'closed' && poll.result === 'tie';
    const eligible = Boolean(poll?.eligibleIds.includes(viewer.id));
    const mine = poll?.options.find(o => o.approvals.includes(viewer.id))?.id ?? null;
    const [pick, setPick] = useState<string | null>(mine);
    useEffect(() => setPick(mine), [mine]);
    const [suggesting, setSuggesting] = useState(false);
    const [reshortlist, setReshortlist] = useState<Set<string> | null>(null);
    const waitingOn = poll ? poll.eligibleIds.filter(id => !poll.voted.includes(id)) : [];
    const note = (o: PollOption) => o.suggestedBy ? `suggested by ${o.suggestedBy === viewer.id ? 'you' : name(o.suggestedBy)}` : 'recent';

    return (
        <div>
            {open && (
                <form onSubmit={e => { e.preventDefault(); if (pick) act('vote', { optionIds: [pick] }); }}>
                    {poll!.options.length === 0 ? (
                        <p className="mb-2 font-permanent text-xs text-zinc-700 dark:text-zinc-300 uppercase">
                            No venues yet. {gm ? 'Add one, or wait for a suggestion.' : 'Suggest one — say, if you can host.'}
                        </p>
                    ) : (
                        <ul className="space-y-2">
                            {poll!.options.map(o => (
                                <li key={o.id} className="p-2 border-2 border-black bg-white dark:bg-slate-700">
                                    <label className={`flex items-start gap-2 ${eligible ? 'cursor-pointer' : ''}`}>
                                        {eligible && (
                                            <input type="radio" name={`venue-${poll!.id}`} checked={pick === o.id} onChange={() => setPick(o.id)}
                                                className="mt-0.5 w-4 h-4 accent-teal-600 shrink-0" aria-label={`Pick ${o.venue?.name ?? 'this venue'}`} />
                                        )}
                                        <span className="flex-1 min-w-0">
                                            {o.venue && <VenueLine venue={o.venue} name={name} note={note(o)} />}
                                            <span className="block mt-1 font-permanent text-[10px] text-zinc-600 dark:text-zinc-300 uppercase">
                                                {o.approvals.length} {o.approvals.length === 1 ? 'vote' : 'votes'}{o.approvals.length ? ` · ${o.approvals.map(name).join(', ')}` : ''}
                                            </span>
                                        </span>
                                    </label>
                                </li>
                            ))}
                        </ul>
                    )}
                    <p className="mt-2 font-permanent text-[10px] text-zinc-600 dark:text-zinc-300 uppercase">
                        Pick one · most votes wins · closes when everyone has voted
                        {waitingOn.length ? ` · waiting on ${waitingOn.map(name).join(', ')}` : ''}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                        {eligible && poll!.options.length > 0 && (
                            <button type="submit" disabled={busy || !pick || pick === mine} className={`${BTN} bg-teal-600 text-white hover:bg-teal-500`}>
                                <Check className="w-4 h-4" /> {mine ? 'Change my vote' : 'Vote'}
                            </button>
                        )}
                        {!suggesting && (
                            <button type="button" onClick={() => { setSuggesting(true); setReshortlist(null); }} className={`${BTN} bg-white text-black hover:bg-yellow-100`}>
                                <Plus className="w-4 h-4" /> {gm ? 'Add a venue' : 'Suggest a venue'}
                            </button>
                        )}
                        {gm && (
                            <>
                                <button type="button" disabled={busy || poll!.options.length === 0} onClick={() => act('advance')} className={`${BTN} bg-yellow-400 text-black hover:bg-white`}>
                                    <FastForward className="w-4 h-4" /> Move forward now
                                </button>
                                {state.venues.length > 0 && (
                                    <button type="button" disabled={busy}
                                        onClick={() => { setSuggesting(false); setReshortlist(r => r ? null : new Set(poll!.options.map(o => o.venueId!))); }}
                                        className={`${BTN} bg-white text-black hover:bg-yellow-100`}>
                                        <RotateCcw className="w-4 h-4" /> Re-shortlist
                                    </button>
                                )}
                            </>
                        )}
                    </div>
                    {mine && <p className="mt-2 font-permanent text-[10px] text-teal-700 dark:text-teal-300 uppercase">You’ve voted — you can change it until the vote closes.</p>}
                </form>
            )}

            {tie && (
                <div>
                    <p className="mb-2 font-permanent text-xs text-black dark:text-white uppercase">
                        The vote tied. {gm ? 'Pick the venue:' : `The ${campaign.gmTitle} will pick between:`}
                    </p>
                    <ul className="space-y-2">
                        {poll!.options.filter(o => poll!.tiedOptionIds.includes(o.id)).map(o => (
                            <li key={o.id} className="flex flex-wrap items-center gap-2 p-2 border-2 border-black bg-white dark:bg-slate-700">
                                <span className="flex-1 min-w-0">
                                    {o.venue && <VenueLine venue={o.venue} name={name} />}
                                    <span className="block font-permanent text-[10px] text-zinc-600 dark:text-zinc-300 uppercase">{o.approvals.length} votes</span>
                                </span>
                                {gm && (
                                    <button type="button" disabled={busy} onClick={() => act('tiebreak', { optionId: o.id })} className={`${BTN} bg-yellow-400 text-black hover:bg-white`}>
                                        <Crown className="w-4 h-4" /> Pick this venue
                                    </button>
                                )}
                            </li>
                        ))}
                    </ul>
                    {gm && !reshortlist && (
                        <button type="button" onClick={() => setReshortlist(new Set())} className={`${BTN} mt-3 bg-white text-black hover:bg-yellow-100`}>
                            <RotateCcw className="w-4 h-4" /> Or shortlist again
                        </button>
                    )}
                </div>
            )}

            {suggesting && open && (
                <SuggestVenue state={state} busy={busy} submit={body => act('suggest-venue', body)} onCancel={() => setSuggesting(false)} />
            )}

            {gm && reshortlist && (
                <form className="mt-3 p-3 border-2 border-dashed border-black/40 dark:border-white/40"
                    onSubmit={async e => { e.preventDefault(); if (await act(open ? 'reshortlist' : 'shortlist', { venueIds: [...reshortlist] })) setReshortlist(null); }}>
                    <p className="mb-2 font-permanent text-xs text-black dark:text-white uppercase">
                        Put these to the party{open ? ' (this round’s votes are discarded)' : ''}:
                    </p>
                    <ul className="space-y-1">
                        {state.venues.map(v => (
                            <li key={v.id}>
                                <label className="flex items-start gap-2 cursor-pointer">
                                    <input type="checkbox" checked={reshortlist.has(v.id)} className="mt-0.5 w-4 h-4 accent-teal-600 shrink-0"
                                        onChange={e => setReshortlist(prev => { const n = new Set(prev); e.target.checked ? n.add(v.id) : n.delete(v.id); return n; })} />
                                    <VenueLine venue={v} name={name} note={v.lastUsedAt ? `last used ${new Date(v.lastUsedAt).toLocaleDateString()}` : undefined} />
                                </label>
                            </li>
                        ))}
                    </ul>
                    <div className="mt-2 flex flex-wrap gap-2">
                        <button type="submit" disabled={busy || reshortlist.size === 0 || reshortlist.size > 6} className={`${BTN} bg-teal-600 text-white hover:bg-teal-500`}>
                            Send {reshortlist.size || ''} to the party
                        </button>
                        <button type="button" onClick={() => setReshortlist(null)} className={`${BTN} bg-white text-black hover:bg-yellow-100`}>Never mind</button>
                    </div>
                </form>
            )}
        </div>
    );
}

const DEFAULT_SLOTS = 'Main, Snacks, Drinks';

/**
 * The food step (#93). Potluck: the slots, with unclaimed ones highlighted;
 * the party claims, backs out of, or adds a slot; the Game Master seeds them.
 * Food provided: who's on it. Either way the Game Master can schedule it at
 * any time, and it closes by itself when the session starts.
 */
function FoodStep({ state, busy, act }: { state: PlanningState; busy: boolean; act: (path: string, body?: unknown) => Promise<boolean> }) {
    const { food, viewer, campaign } = state;
    const gm = viewer.isGameMaster;
    const inParty = state.party.some(p => p.id === viewer.id);
    const quests = food?.quests ?? [];
    const [seed, setSeed] = useState(quests.length ? '' : DEFAULT_SLOTS);
    const [own, setOwn] = useState('');
    const who = (m: Member) => m.id === viewer.id ? 'You' : m.name;

    if (!food) return null;
    if (food.mode === 'provided') {
        const q = quests[0];
        return (
            <div>
                {q ? (
                    <p className="p-2 border-2 border-black bg-white dark:bg-slate-700 font-permanent text-xs text-black dark:text-white uppercase flex flex-wrap items-center gap-2">
                        <Utensils className="w-4 h-4 shrink-0" />
                        <span className="flex-1 min-w-0">{q.title} · {q.assignee ? who(q.assignee) : 'nobody yet'}</span>
                        <span className={`px-1.5 border-2 border-black text-[9px] ${q.status === 'done' ? 'bg-teal-600 text-white' : 'bg-zinc-100 text-black'}`}>{q.status === 'done' ? 'Done' : 'On it'}</span>
                    </p>
                ) : (
                    <p className="font-permanent text-xs text-zinc-700 dark:text-zinc-300 uppercase">Food provided.</p>
                )}
                {q?.assignee?.id === viewer.id && (
                    <p className="mt-2 font-permanent text-[10px] text-teal-700 dark:text-teal-300 uppercase">It’s in your Quest Log — mark it done there when the food’s sorted.</p>
                )}
            </div>
        );
    }

    const open = quests.filter(q => q.status === 'open' && !q.assignee);
    const titles = seed.split(',').map(t => t.trim()).filter(Boolean);
    return (
        <div>
            {quests.length === 0 ? (
                <p className="font-permanent text-xs text-zinc-700 dark:text-zinc-300 uppercase">
                    {gm ? 'List what’s needed and the party can claim it.' : `The ${campaign.gmTitle} hasn’t listed what’s needed yet — you can add what you’ll bring.`}
                </p>
            ) : (
                <>
                    <ul className="space-y-2">
                        {quests.map(q => {
                            const unclaimed = q.status === 'open' && !q.assignee;
                            const mine = q.assignee?.id === viewer.id;
                            return (
                                <li key={q.id} className={`flex flex-wrap items-center gap-2 p-2 border-2 ${unclaimed ? 'border-dashed border-red-600 bg-yellow-100 dark:bg-yellow-900/40' : 'border-black bg-white dark:bg-slate-700'}`}>
                                    <span className="flex-1 min-w-0 font-permanent text-xs uppercase break-words text-black dark:text-white">
                                        {q.title}
                                        <span className={`ml-2 text-[10px] ${unclaimed ? 'text-red-700 dark:text-red-300' : 'text-teal-700 dark:text-teal-300'}`}>
                                            {unclaimed ? 'Unclaimed' : q.assignee ? `${who(q.assignee)}${q.status === 'done' ? ' · done' : ''}` : q.status}
                                        </span>
                                    </span>
                                    {unclaimed && inParty && (
                                        <button type="button" disabled={busy} onClick={() => act(`food/${q.id}/claim`)} className={`${BTN} bg-teal-600 text-white hover:bg-teal-500`}>
                                            <Check className="w-4 h-4" /> I’ll bring it
                                        </button>
                                    )}
                                    {mine && q.status === 'open' && (
                                        <button type="button" disabled={busy} onClick={() => act(`food/${q.id}/unclaim`)} className={`${BTN} bg-white text-black hover:bg-yellow-100`}>
                                            <X className="w-4 h-4" /> Back out
                                        </button>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                    <p className="mt-2 font-permanent text-[10px] text-zinc-600 dark:text-zinc-300 uppercase">
                        {quests.length - open.length} of {quests.length} claimed{open.length ? ` · ${open.length} still open` : ' · all covered'}
                    </p>
                </>
            )}

            {inParty && (
                <form className="mt-3 flex flex-wrap gap-2" onSubmit={async e => { e.preventDefault(); if (await act('food/add', { title: own })) setOwn(''); }}>
                    <input maxLength={120} value={own} onChange={e => setOwn(e.target.value)} className={`${INPUT_CLS} flex-1 min-w-[10rem]`}
                        placeholder="Something else you’ll bring" aria-label="Something else you’ll bring" />
                    <button type="submit" disabled={busy || !own.trim()} className={`${BTN} bg-white text-black hover:bg-yellow-100`}>
                        <Plus className="w-4 h-4" /> I’ll bring this
                    </button>
                </form>
            )}

            {gm && (
                <form className="mt-3 p-3 border-2 border-dashed border-black/40 dark:border-white/40"
                    onSubmit={async e => { e.preventDefault(); if (await act('food/seed', { titles })) setSeed(''); }}>
                    <label className="block">
                        <span className="block font-permanent text-[10px] text-zinc-700 dark:text-zinc-300 uppercase mb-1">What’s needed (comma-separated)</span>
                        <input value={seed} onChange={e => setSeed(e.target.value)} className={INPUT_CLS} placeholder={DEFAULT_SLOTS} aria-label="Slots to add" />
                    </label>
                    <button type="submit" disabled={busy || titles.length === 0 || titles.length > 10} className={`${BTN} mt-2 bg-yellow-400 text-black hover:bg-white`}>
                        <Plus className="w-4 h-4" /> Add {titles.length > 1 ? `${titles.length} slots` : 'slot'}
                    </button>
                </form>
            )}
        </div>
    );
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

    const act = async (path: string, body?: unknown): Promise<boolean> => {
        setBusy(true);
        setError(null);
        const r = await post(`${base}/${path}`, body);
        if (!r.ok) setError(r.error!);
        else setReshortlisting(false);
        await reload();
        setBusy(false);
        return r.ok;
    };
    const shortlist = (times: PickedTime[], replace: boolean) => act(replace ? 'reshortlist' : 'shortlist', { options: times });

    const eligible = Boolean(night?.eligibleIds.includes(viewer.id));
    const hasVoted = Boolean(night?.voted.includes(viewer.id));
    const waitingOn = night ? night.eligibleIds.filter(id => !night.voted.includes(id)) : [];

    const stage = s.stage ?? 'night';
    const vPoll = state.venue;
    const venueOpen = vPoll?.status === 'open';
    const venueTie = vPoll?.status === 'closed' && vPoll.result === 'tie';
    const unclaimedFood = state.food?.mode === 'potluck' ? state.food.quests.filter(q => q.status === 'open' && !q.assignee).length : 0;
    const seal = stage === 'venue'
        ? (venueOpen ? `Pick the venue · ${vPoll!.voted.length} of ${vPoll!.eligibleIds.length}` : venueTie ? `Tie · the ${gmTitle} decides` : 'Venue')
        : stage === 'food' ? (unclaimedFood ? `Food · ${unclaimedFood} unclaimed` : gm ? 'Confirm the food' : `Food · waiting on the ${gmTitle}`)
        : open ? `Awaiting votes · ${night!.voted.length} of ${night!.eligibleIds.length}`
        : tie ? `Tie · the ${gmTitle} decides`
        : gm ? 'Pick some nights' : `Waiting on the ${gmTitle}`;
    const sealHot = stage === 'night' ? open : stage === 'venue' ? venueOpen : false;
    const sealTie = stage === 'night' ? tie : stage === 'venue' ? venueTie : unclaimedFood > 0;
    const foodLabel = s.foodMode === 'potluck' ? 'potluck'
        : s.foodMode === 'provided' ? `food by ${s.foodOwnerId === viewer.id ? 'you' : name(s.foodOwnerId ?? '')}` : null;

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
                        ) : (
                            <>
                                <MapPin className="w-3 h-3" /> In person{s.venue ? ` · ${s.venue.name}` : ''}{foodLabel ? ` · ${foodLabel}` : ''}
                            </>
                        )}
                    </p>
                </div>
                <span className={`px-3 py-1 border-2 border-black font-permanent text-[10px] uppercase whitespace-nowrap ${sealHot ? 'bg-red-600 text-white' : sealTie ? 'bg-yellow-400 text-black' : 'bg-zinc-800 text-white'}`}>
                    {seal}
                </span>
            </header>
            {s.agenda && <p className="mt-2 font-permanent text-xs text-zinc-700 dark:text-zinc-300 uppercase">{s.agenda}</p>}

            <div className="mt-4 pt-4 border-t-2 border-black/20 dark:border-white/20">
                <StepHeading n={1} title={stage === 'night' ? 'Pick the night' : 'The night'} state={stage === 'night' ? 'now' : 'done'}
                    extra={night && stage === 'night' && <span className="font-permanent text-[10px] text-zinc-600 dark:text-zinc-300">round {night.round}</span>} />

                {stage !== 'night' && s.date && (
                    <p className="font-permanent text-xs text-teal-700 dark:text-teal-300 uppercase flex items-center gap-1.5">
                        <CalendarClock className="w-4 h-4 shrink-0" /> {whenOf(s.date, s.endDate)}
                    </p>
                )}
                {stage === 'night' && <>
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
                </>}
            </div>

            {!s.isOnline && (
                <div className="mt-4 pt-4 border-t-2 border-black/20 dark:border-white/20">
                    {/* A changed night (#87) keeps the venue it already had: no new venue vote or food step follows. */}
                    <StepHeading n={2} title={stage === 'venue' ? 'Pick the venue' : 'The venue'}
                        state={stage === 'venue' ? 'now' : s.venue ? 'done' : 'later'}
                        extra={vPoll && stage === 'venue' && <span className="font-permanent text-[10px] text-zinc-600 dark:text-zinc-300">round {vPoll.round}</span>} />
                    {stage === 'night' && !s.venue && (
                        <p className="font-permanent text-[10px] text-zinc-500 dark:text-zinc-400 uppercase">Once the night is set, the party picks where.</p>
                    )}
                    {stage === 'venue' && <VenueStep state={state} busy={busy} act={act} />}
                    {stage !== 'venue' && s.venue && (
                        <VenueLine venue={s.venue} name={name} note={s.hostId ? `host: ${s.hostId === viewer.id ? 'you' : name(s.hostId)}` : undefined} />
                    )}
                </div>
            )}

            {!s.isOnline && s.foodMode && !(stage === 'night' && s.venue) && (
                <div className="mt-4 pt-4 border-t-2 border-black/20 dark:border-white/20">
                    <StepHeading n={3} title={stage === 'food' ? 'Sort the food' : 'Food'} state={stage === 'food' ? 'now' : 'later'} />
                    <p className="mb-3 font-permanent text-xs text-zinc-700 dark:text-zinc-300 uppercase flex items-center gap-1.5">
                        <Utensils className="w-4 h-4 shrink-0" />
                        {s.foodMode === 'potluck' ? 'Potluck: everyone brings something.' : `Food provided by ${s.foodOwnerId === viewer.id ? 'you' : name(s.foodOwnerId ?? '')}.`}
                    </p>
                    {stage === 'food' && <FoodStep state={state} busy={busy} act={act} />}
                    {stage === 'food' && gm && (
                        <>
                            <button type="button" disabled={busy} onClick={() => act('confirm-food')} className={`${BTN} mt-3 bg-teal-600 text-white hover:bg-teal-500`}>
                                <Check className="w-4 h-4" /> Food’s sorted: schedule it
                            </button>
                            <p className="mt-2 font-permanent text-[10px] text-zinc-600 dark:text-zinc-300 uppercase">
                                {unclaimedFood ? 'Unclaimed slots won’t hold it up. ' : ''}Otherwise the food step closes when the session starts.
                            </p>
                        </>
                    )}
                    {stage === 'food' && !gm && (
                        <p className="mt-2 font-permanent text-[10px] text-zinc-600 dark:text-zinc-300 uppercase">The {gmTitle} will confirm the food (or it closes when the session starts), and then it’s on.</p>
                    )}
                </div>
            )}

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
                        {whenOf(u.date, u.endDate)} · {u.isOnline ? 'online' : u.venue ? u.venue.name : 'in person'}
                    </span>
                    {!u.isOnline && u.venue?.address && (
                        <span className="block font-permanent text-[10px] text-zinc-600 dark:text-zinc-300 uppercase break-words">
                            <MapPin className="inline w-3 h-3 mr-0.5" />{u.venue.address}
                        </span>
                    )}
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
                        Shortlist new times. The party votes again. Until a new night is confirmed the session keeps its current date and events, but it’s back to being planned (no ready check). Then the Discord and calendar events move with it.
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
    const [kickoff, setKickoff] = useState<{ title: string; agenda: string; isOnline: boolean; foodMode: FoodMode | ''; foodOwnerId: string } | null>(null);
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
        const inPersonFood = !kickoff.isOnline && kickoff.foodMode ? kickoff.foodMode : null;
        const r = await post(`/api/planning/campaigns/${campaignId}/kickoff`, {
            title: kickoff.title, agenda: kickoff.agenda, isOnline: kickoff.isOnline,
            foodMode: inPersonFood, ...(inPersonFood === 'provided' ? { foodOwnerId: kickoff.foodOwnerId } : {}),
        });
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
                    <button type="button" onClick={() => setKickoff({ title: '', agenda: '', isOnline: true, foodMode: '', foodOwnerId: '' })}
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
                    <fieldset>
                        <legend className="block font-permanent text-[10px] text-teal-400 uppercase mb-1">Where</legend>
                        <div className="flex flex-wrap gap-4">
                            <label className="flex items-center gap-1.5 font-permanent text-xs text-white uppercase cursor-pointer">
                                <input type="radio" name="kickoff-where" checked={kickoff.isOnline} onChange={() => setKickoff({ ...kickoff, isOnline: true })} className="accent-teal-500" />
                                <Wifi className="w-3 h-3 text-teal-400" /> Online
                            </label>
                            <label className="flex items-center gap-1.5 font-permanent text-xs text-white uppercase cursor-pointer">
                                <input type="radio" name="kickoff-where" checked={!kickoff.isOnline} onChange={() => setKickoff({ ...kickoff, isOnline: false })} className="accent-teal-500" />
                                <MapPin className="w-3 h-3 text-teal-400" /> In person
                            </label>
                        </div>
                        <p className="mt-1 font-permanent text-[10px] text-zinc-300 uppercase">
                            {kickoff.isOnline ? 'The party picks a night, and it’s on — at the campaign’s table link.' : 'The party picks a night, then a venue, then sorts the food.'}
                        </p>
                    </fieldset>
                    {!kickoff.isOnline && (
                        <div className="flex flex-wrap gap-2">
                            <label className="block flex-1 min-w-[10rem]">
                                <span className="block font-permanent text-[10px] text-teal-400 uppercase mb-1">Food *</span>
                                <select required value={kickoff.foodMode} onChange={e => setKickoff({ ...kickoff, foodMode: e.target.value as FoodMode | '' })} className={INPUT_CLS}>
                                    <option value="">Choose…</option>
                                    <option value="potluck">Potluck</option>
                                    <option value="provided">Food provided</option>
                                </select>
                            </label>
                            {kickoff.foodMode === 'provided' && (
                                <label className="block flex-1 min-w-[10rem]">
                                    <span className="block font-permanent text-[10px] text-teal-400 uppercase mb-1">Provided by *</span>
                                    <select required value={kickoff.foodOwnerId} onChange={e => setKickoff({ ...kickoff, foodOwnerId: e.target.value })} className={INPUT_CLS}>
                                        <option value="">Choose…</option>
                                        {board.party.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                                    </select>
                                </label>
                            )}
                        </div>
                    )}
                    {kickoffError && <p role="alert" className="font-permanent text-xs text-red-400 uppercase">{kickoffError}</p>}
                    <button type="submit" disabled={starting || !kickoff.title.trim() || (!kickoff.isOnline && (!kickoff.foodMode || (kickoff.foodMode === 'provided' && !kickoff.foodOwnerId)))} className={`${BTN} bg-teal-600 text-white hover:bg-teal-500`}>
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
