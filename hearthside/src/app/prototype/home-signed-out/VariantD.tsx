"use client";

import Link from 'next/link';
import { useState } from 'react';
import NoticeSheet from '@/components/design-system/NoticeSheet';

const SEATS = [
  { key: 'board', name: 'The Notice Board', text: 'The GM calls a session. The party votes on the night, then settles where you’ll play and who brings food.' },
  { key: 'letters', name: 'Letters', text: 'A group chat for each campaign and messages between players, live as they’re typed.' },
  { key: 'almanac', name: 'The Almanac', text: 'Every session your campaigns have had or have coming, on one calendar.' },
  { key: 'adventurers', name: 'Adventurers', text: 'Your characters, with the campaigns and sessions they’ve played through.' },
  { key: 'quests', name: 'Your Quests', text: 'What you’ve signed up for, like hosting or bringing drinks, with reminders before the night.' },
] as const;

/**
 * D — The round table. The session page's table top, seen from above, with
 * Hearthside's five places sitting round it on brass plates. Choosing a seat
 * puts what that place does on the card in the middle; the card always ends
 * with Sign in and Create an account. On a phone the table shrinks to a
 * picture over the card, and the seats become a row of buttons under it.
 */
export default function VariantD() {
  const [seat, setSeat] = useState<string | null>(null);
  const chosen = SEATS.find((s) => s.key === seat) ?? null;

  return (
    <div className="hs-shell-wrap">
      <main className="hs-hd">
        <header className="hs-hd-head">
          <p className="hs-brand">Hearthside<small>The Party Gathers</small></p>
          <h1 className="hs-hd-title">Pull up a chair. Your party plans its game nights here.</h1>
        </header>

        <div className="hs-hd-room">
          <div className="hs-hd-table" aria-hidden="true" />
          <div className="hs-hd-seats" role="group" aria-label="What’s at the table">
            {SEATS.map((s, i) => (
              <button
                key={s.key}
                type="button"
                className="hs-hd-seat"
                style={{ ['--i' as string]: i, ['--n' as string]: SEATS.length }}
                aria-pressed={seat === s.key}
                onClick={() => setSeat(seat === s.key ? null : s.key)}
              >
                {s.name}
              </button>
            ))}
          </div>
          <NoticeSheet seed="hs-hd-card" className="hs-hd-card" aria-live="polite">
            {chosen ? (
              <>
                <p className="hs-kicker">At the table</p>
                <h2 className="hs-sheet-title hs-hd-card-title">{chosen.name}</h2>
                <p className="hs-hd-card-text">{chosen.text}</p>
              </>
            ) : (
              <>
                <p className="hs-kicker">Welcome</p>
                <h2 className="hs-sheet-title hs-hd-card-title">There’s a seat for you</h2>
                <p className="hs-hd-card-text">Choose a seat to see what’s there, or come in.</p>
              </>
            )}
            <div className="hs-btn-row hs-hd-acts">
              <Link href="/login" className="hs-btn is-primary hs-hd-btn">Sign in</Link>
              <Link href="/signup" className="hs-btn hs-hd-btn">Create an account</Link>
            </div>
          </NoticeSheet>
        </div>
      </main>
    </div>
  );
}
