"use client";

import Link from 'next/link';
import GildedPanel from '@/components/design-system/GildedPanel';
import { characterGroups, characterLine, playedBy, type PartyCharacter } from '@/lib/campaignRecords';

/**
 * The party's adventurers (#36, #225): each links to its adventurer's page
 * (`/characters/:id`, #229), with its class and level and who plays it. A
 * fallen one is struck through. The characters of players made inactive
 * here stay on the roster as the party's history, under "Former party".
 */
export default function CampaignCharacters({ characters, error }: { characters: PartyCharacter[] | null; error: string | null }) {
  if (error) return <p className="hs-note" role="alert">{error}</p>;
  if (!characters) return <p className="hs-note">Calling the roll…</p>;
  if (characters.length === 0) return <p className="hs-note">No characters in this party yet.</p>;
  const { current, former } = characterGroups(characters);
  return (
    <>
      {current.length > 0 && <Roster title="Adventurers" aside={`${current.length} in the party`} characters={current} />}
      {former.length > 0 && <Roster title="Former party" aside={String(former.length)} characters={former} former />}
    </>
  );
}

function Roster({ title, aside, characters, former = false }: { title: string; aside: string; characters: PartyCharacter[]; former?: boolean }) {
  return (
    <div>
      <h3 className="hs-sec"><span>{title}</span><span className="hs-aside">{aside}</span></h3>
      <GildedPanel>
        <ul className={former ? 'hs-cp-chars is-former' : 'hs-cp-chars'} aria-label={title}>
          {characters.map((c) => (
            <li key={c._id}>
              <Link href={`/characters/${encodeURIComponent(c._id)}`}>
                <span className={c.isDead ? 'hs-avatar is-char is-fallen' : 'hs-avatar is-char'} aria-hidden="true">
                  {(c.name.trim()[0] ?? '?').toUpperCase()}
                </span>
                <span className="hs-cp-row-text">
                  <span className={c.isDead ? 'hs-cp-row-title is-struck' : 'hs-cp-row-title'}>{c.name}</span>
                  <span className="hs-cp-when">{characterLine(c)}{c.isDead ? ' · fallen' : ''}</span>
                  <span className="hs-cp-meta">{playedBy(c)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </GildedPanel>
    </div>
  );
}
