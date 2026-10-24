"use client";

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Sword, Skull, ChevronRight } from 'lucide-react';

export interface PartyCharacter {
    _id: string;
    name: string;
    class?: string | null;
    level?: number | null;
    gameType?: string | null;
    isDead?: boolean;
    player: { _id: string; name: string; handle: string | null } | null;
    /** False once the player has been deactivated in this campaign (#37). */
    playerActive: boolean;
}

/**
 * The campaign's Characters tab (#36): every character in the party, with who
 * plays it. A deactivated player's characters stay on the roster as the
 * party's history (#31), listed apart under "Former party".
 */
export default function CampaignCharacters({ campaignId }: { campaignId: string }) {
    const [characters, setCharacters] = useState<PartyCharacter[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const controller = new AbortController();
        fetch(`/api/tabletop/characters?campaign=${encodeURIComponent(campaignId)}`, {
            headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
            signal: controller.signal,
        })
            .then(async res => {
                if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not load characters.');
                setCharacters(await res.json());
            })
            .catch(err => { if (err.name !== 'AbortError') setError(err.message); });
        return () => controller.abort();
    }, [campaignId]);

    if (error) return <p role="alert" className="font-permanent text-sm text-red-600 uppercase">{error}</p>;
    if (!characters) return <p className="font-permanent text-sm text-zinc-400 uppercase animate-pulse">Loading characters...</p>;
    if (characters.length === 0) {
        return (
            <div className="py-10 border-4 border-dashed border-zinc-300 dark:border-zinc-700 text-center">
                <Sword className="w-10 h-10 text-zinc-300 dark:text-zinc-600 mx-auto mb-2" />
                <p className="font-permanent text-sm text-zinc-400 uppercase">No characters in this party yet.</p>
            </div>
        );
    }

    const current = characters.filter(c => c.playerActive);
    const former = characters.filter(c => !c.playerActive);
    return (
        <div className="space-y-8">
            {current.length > 0 && <CharacterGrid characters={current} />}
            {former.length > 0 && (
                <div>
                    <h3 className="font-permanent text-sm text-zinc-400 uppercase mb-3">Former party ({former.length})</h3>
                    <CharacterGrid characters={former} faded />
                </div>
            )}
        </div>
    );
}

function CharacterGrid({ characters, faded = false }: { characters: PartyCharacter[]; faded?: boolean }) {
    return (
        <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 ${faded ? 'opacity-60' : ''}`}>
            {characters.map(c => (
                <Link
                    key={c._id}
                    href={`/game-night/characters/${c._id}`}
                    className="flex gap-3 p-4 border-4 border-black bg-white dark:bg-slate-800 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 transition-transform items-start group"
                >
                    <div className={`p-2 border-2 border-black shrink-0 ${c.isDead ? 'bg-zinc-600' : 'bg-yellow-400'}`}>
                        {c.isDead ? <Skull className="w-4 h-4 text-white" /> : <Sword className="w-4 h-4 text-black" />}
                    </div>
                    <div className="flex-grow min-w-0">
                        <h4 className={`font-permanent text-sm text-black dark:text-white uppercase truncate group-hover:text-teal-600 transition-colors ${c.isDead ? 'line-through' : ''}`}>{c.name}</h4>
                        <p className="text-xs font-permanent text-teal-600 dark:text-yellow-400 uppercase truncate">
                            {[c.class, c.level ? `Level ${c.level}` : null].filter(Boolean).join(' · ') || 'Adventurer'}
                        </p>
                        <p className="text-xs font-permanent text-zinc-400 uppercase truncate">
                            {c.player ? `Played by ${c.player.handle ? `@${c.player.handle}` : c.player.name}` : 'No player'}
                        </p>
                    </div>
                    <ChevronRight className="w-4 h-4 text-zinc-300 dark:text-zinc-600 shrink-0 self-center group-hover:text-teal-500 transition-colors" />
                </Link>
            ))}
        </div>
    );
}
