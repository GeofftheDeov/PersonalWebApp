"use client";

import GildedPanel from '@/components/design-system/GildedPanel';
import { campaignThreadKey, usePresence } from '@/lib/letters';
import { initials } from '@/lib/lettersFormat';
import { useSession } from '@/lib/session';
import LetterThread from './LetterThread';

/**
 * A campaign's Table Talk on its own page (#225): the party's thread, the
 * same one Letters lists, drawn by LetterThread on the shared hooks, so a
 * letter sent here shows in Letters too (and the other way round), live.
 * Being on the page, or having the thread open in Letters, puts you among
 * those here now (#37), shown above the compose bar, as on the portfolio.
 */
export default function TableTalk({ campaignId, title, partySize }: {
  campaignId: string;
  title: string;
  /** Players in the party, for the thread's subtitle. */
  partySize: number;
}) {
  const myId = useSession().user?.id ?? null;
  const here = usePresence(campaignThreadKey(campaignId));

  return (
    <section className="hs-cp-talk" aria-labelledby="hs-cp-talk-h">
      <h2 className="hs-sec" id="hs-cp-talk-h">
        <span>Table Talk</span>
        {here.length > 0 && <span className="hs-aside">{here.length} here now</span>}
      </h2>
      <GildedPanel className="hs-letters">
        <LetterThread
          letter={{
            kind: 'campaign', id: campaignId, title,
            subtitle: `Campaign · ${partySize} in the party`, avatarHint: initials(title),
          }}
          beforeCompose={here.length > 0 && (
            <div className="hs-cp-here">
              <span>Here now</span>
              <ul aria-label="Here now">
                {here.map((p) => (
                  <li key={p.id} title={p.id === myId ? `${p.name} (you)` : p.name}>
                    <span className="hs-avatar" aria-hidden="true">{initials(p.name)}</span>
                    <span className="hs-sr-only">{p.id === myId ? `${p.name} (you)` : p.name}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        />
      </GildedPanel>
    </section>
  );
}
