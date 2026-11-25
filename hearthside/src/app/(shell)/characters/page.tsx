"use client";

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import AdventurerDialog from '@/components/adventurers/AdventurerDialog';
import Portrait from '@/components/adventurers/Portrait';
import { api, errorOf, getOrNull } from '@/lib/api';
import {
  campaignIdOf, campaignTitleOf, classLine, nextLabel, nextSessions, rosterOf,
  type Adventurer, type RosterSession,
} from '@/lib/adventurers';
import { useRequiredSession } from '@/lib/session';

/**
 * Adventurers, `/characters` (#229, spec #69): layout D's roster, "Gallery +
 * road", from prototype/hearthside-characters. The viewer's own adventurers
 * hang as portraits in gilded frames on the floor, each with a brass name
 * plate (name, class and level) and the next session in its campaign under
 * it; the fallen hang in the Hall of Heroes below. Each frame holds their
 * portrait (#273), or their initials until they have one. New adventurer
 * opens the gilded dialog, then their page.
 */
export default function AdventurersPage() {
  const router = useRouter();
  const { status, user } = useRequiredSession();
  const [list, setList] = useState<Adventurer[] | null>(null);
  const [sessions, setSessions] = useState<RosterSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await api.get<Adventurer[]>('/api/tabletop/characters'));
      setError(null);
    } catch (err) {
      setError(errorOf(err, 'The roster couldn’t be loaded. Try again in a moment.'));
    }
  }, []);

  useEffect(() => {
    if (status !== 'signedIn') return;
    load();
    // The next session under each portrait; left out if it doesn't load.
    getOrNull<RosterSession[]>('/api/tabletop/sessions').then((s) => { if (s) setSessions(s); });
  }, [status, load]);

  const [now] = useState(() => new Date());
  const next = useMemo(() => nextSessions(sessions, now), [sessions, now]);
  const roster = list && user ? rosterOf(list, user.id) : null;
  const empty = !!roster && !roster.adventuring.length && !roster.fallen.length;

  const card = (c: Adventurer) => {
    const cid = campaignIdOf(c);
    const nx = !c.isDead && cid ? next.get(cid) : undefined;
    return (
      <li key={c._id}>
        <Link href={`/characters/${encodeURIComponent(c._id)}`} className={c.isDead ? 'hs-adv-card is-fallen' : 'hs-adv-card'}>
          <span className="hs-adv-frame">
            <Portrait name={c.name} src={c.portraitUrl} />
            {c.isDead && <span className="hs-adv-ribbon">Fallen</span>}
          </span>
          <span className="hs-adv-plate"><b>{c.name}</b><small>{classLine(c)}</small></span>
          <span className="hs-adv-under">
            {nx && <b>{nextLabel(nx, now)}</b>}
            {cid ? campaignTitleOf(c) ?? 'In a campaign' : 'Not in a campaign yet'}
          </span>
        </Link>
      </li>
    );
  };

  return (
    <>
      <header className="hs-page-head hs-adv-head">
        <div>
          <h1>Adventurers</h1>
          {roster && (
            <p>
              {empty ? 'Nobody yet' : <b>{roster.adventuring.length} adventuring</b>}
              {roster.fallen.length > 0 && <> · {roster.fallen.length} fallen</>}
            </p>
          )}
        </div>
        {roster && !empty && (
          <button type="button" className="hs-btn-amber hs-adv-new" onClick={() => setAdding(true)}>New adventurer</button>
        )}
      </header>

      {error ? (
        <p className="hs-note" role="alert">{error}</p>
      ) : !roster ? (
        <p className="hs-note">Gathering the roster…</p>
      ) : empty ? (
        <section className="hs-adv-empty" aria-labelledby="hs-adv-first">
          <span className="hs-adv-frame" aria-hidden="true"><span className="hs-adv-pt"><span className="hs-adv-pt-none"><span>?</span></span></span></span>
          <div>
            <h2 id="hs-adv-first">Your first adventurer</h2>
            <p>Give them a name, and say what they are in your game&rsquo;s own words. Everything else can wait.</p>
            <button type="button" className="hs-btn-amber hs-adv-new" onClick={() => setAdding(true)}>New adventurer</button>
          </div>
        </section>
      ) : (
        <>
          {roster.adventuring.length > 0 ? (
            <ul className="hs-adv-wall" aria-label="Adventuring">{roster.adventuring.map(card)}</ul>
          ) : (
            <p className="hs-note">Nobody&rsquo;s adventuring just now.</p>
          )}
          {roster.fallen.length > 0 && (
            <section className="hs-adv-hall" aria-labelledby="hs-adv-hall">
              <h2 className="hs-sec" id="hs-adv-hall">
                <span>The Hall of Heroes</span>
                <span className="hs-aside">{roster.fallen.length} fallen</span>
              </h2>
              <ul className="hs-adv-wall" aria-label="The Hall of Heroes">{roster.fallen.map(card)}</ul>
            </section>
          )}
        </>
      )}

      {adding && (
        <AdventurerDialog
          onClose={() => setAdding(false)}
          onSaved={(made) => { setAdding(false); router.push(`/characters/${encodeURIComponent(made._id)}`); }}
        />
      )}
    </>
  );
}
