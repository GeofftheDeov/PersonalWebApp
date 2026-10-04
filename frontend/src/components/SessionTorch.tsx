"use client";

import { useState } from 'react';
import { Flame, Undo2 } from 'lucide-react';

/**
 * The one-session torch pass (#57, #89): who's standing in as this session's
 * Game Master, and, for the campaign's GM, the control to pass the torch for
 * this session or take it back. The stand-in may hand it back too. Backed by
 * POST / DELETE /api/planning/sessions/:id/torch; the server enforces who may.
 */

export interface StandIn { id: string; name: string }

interface Props {
    sessionId: string;
    gmTitle: string;
    /** The party. The campaign's GMs and the current stand-in aren't offered. */
    party: StandIn[];
    gameMasterIds: string[];
    standIn: StandIn | null;
    viewerId: string | null;
    /** The campaign's own GM (or an admin), not a stand-in. */
    canPass: boolean;
    onChanged: () => void | Promise<void>;
    /** "dark" sits on the slate panels of the session page. */
    tone?: 'light' | 'dark';
}

const BTN = "flex items-center gap-1.5 px-3 py-1.5 border-2 border-black font-permanent uppercase text-xs transition-colors shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] disabled:opacity-40";

export default function SessionTorch({ sessionId, gmTitle, party, gameMasterIds, standIn, viewerId, canPass, onChanged, tone = 'light' }: Props) {
    const [to, setTo] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const candidates = party.filter(p => !gameMasterIds.includes(p.id) && p.id !== standIn?.id);
    const isStandIn = Boolean(standIn && standIn.id === viewerId);
    const muted = tone === 'dark' ? 'text-zinc-300' : 'text-zinc-600 dark:text-zinc-300';
    const strong = tone === 'dark' ? 'text-white' : 'text-black dark:text-white';

    if (!standIn && !canPass) return null;

    const send = async (method: 'POST' | 'DELETE', body?: unknown) => {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api/planning/sessions/${sessionId}/torch`, {
                method,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            if (!res.ok) setError((await res.json().catch(() => ({}))).error || 'Something went wrong.');
            else setTo('');
            await onChanged();
        } catch {
            setError('Could not reach the server.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="space-y-2">
            {standIn && (
                <p className={`font-permanent text-xs uppercase flex items-center gap-1.5 flex-wrap ${strong}`}>
                    <Flame className="w-4 h-4 text-orange-500 shrink-0" />
                    <span>Temporary {gmTitle} for this session: <span className="text-orange-600 dark:text-orange-400">{isStandIn ? 'you' : standIn.name}</span></span>
                    {(canPass || isStandIn) && (
                        <button type="button" disabled={busy}
                            onClick={() => { if (window.confirm(isStandIn ? `Hand this session back to the ${gmTitle}?` : `Take the torch back from ${standIn.name}?`)) send('DELETE'); }}
                            className={`ml-1 flex items-center gap-1 font-permanent text-[10px] uppercase underline ${muted} hover:text-red-600 disabled:opacity-40`}>
                            <Undo2 className="w-3 h-3" /> {isStandIn ? 'Hand it back' : 'Take it back'}
                        </button>
                    )}
                </p>
            )}
            {canPass && candidates.length > 0 && (
                <form className="flex flex-wrap items-center gap-2"
                    onSubmit={e => {
                        e.preventDefault();
                        const name = candidates.find(c => c.id === to)?.name;
                        if (name && window.confirm(`Pass the torch to ${name} for this session? They'll run it as ${gmTitle}; you stay the campaign's ${gmTitle}.`)) send('POST', { to });
                    }}>
                    <label className={`font-permanent text-[10px] uppercase ${muted}`} htmlFor={`torch-${sessionId}`}>
                        {standIn ? 'Or pass it to' : 'Pass the torch for this session to'}
                    </label>
                    <select id={`torch-${sessionId}`} value={to} onChange={e => setTo(e.target.value)}
                        className="p-1.5 border-2 border-black bg-white text-black font-permanent text-xs uppercase outline-none focus:border-teal-500 max-w-full">
                        <option value="">Choose a player</option>
                        {candidates.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <button type="submit" disabled={busy || !to} className={`${BTN} bg-orange-500 text-black hover:bg-white`}>
                        <Flame className="w-4 h-4" /> Pass the torch
                    </button>
                </form>
            )}
            {error && <p role="alert" className="font-permanent text-xs text-red-600 dark:text-red-400 uppercase">{error}</p>}
        </div>
    );
}
