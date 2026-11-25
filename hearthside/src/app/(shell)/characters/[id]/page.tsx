"use client";

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiError } from '@gtd/shared/api';
import AdventurerDialog from '@/components/adventurers/AdventurerDialog';
import ArtPanel from '@/components/adventurers/ArtPanel';
import FullSheet from '@/components/adventurers/FullSheet';
import Portrait from '@/components/adventurers/Portrait';
import GildedPanel from '@/components/design-system/GildedPanel';
import BackLink from '@/components/shell/BackLink';
import { api, errorOf } from '@/lib/api';
import {
  campaignIdOf, campaignTitleOf, canEditAdventurer, classLine, playedByLine, playerIdOf, statusOf, travelsWith,
  type Adventurer,
} from '@/lib/adventurers';
import { characterLine, type PartyCharacter } from '@/lib/campaignRecords';
import { useRequiredSession } from '@/lib/session';

type Load =
  | { status: 'loading' }
  | { status: 'ready'; adventurer: Adventurer }
  | { status: 'error'; error: string };

/**
 * An adventurer's page, `/characters/:id` (#229, spec #69): layout D's page
 * from prototype/hearthside-characters. The hero (their portrait in the
 * medallion, their name, class and level), their Art (#273), then their
 * sheet: who plays them, class, level, game, campaign and status, The full
 * sheet (#274: a link and/or an uploaded copy), Travels with (the party's
 * other adventurers) and Edit. There's no road yet (#198).
 *
 * Who may open it is the server's (#202): the player, their friends and
 * campaign-mates, the adventurer's party, and admins. Edit is for the player
 * and admins; anyone else reads it. Travels with shows only to someone the
 * server lets read the party (`?campaign=`, members and admins), and the
 * campaign links to its page only for them too.
 */
export default function AdventurerPage() {
  const params = useParams();
  const id = String(params?.id ?? '');
  const { status } = useRequiredSession();
  if (status !== 'signedIn') return <p className="hs-note hs-adv-wait" role="status">Finding the adventurer…</p>;
  return <AdventurerSheetPage key={id} id={id} />;
}

function AdventurerSheetPage({ id }: { id: string }) {
  const { user, capabilities } = useRequiredSession();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  // The party, or null while it loads or when the viewer may not see it (outside the campaign).
  const [party, setParty] = useState<PartyCharacter[] | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let live = true;
    api.get<Adventurer>(`/api/tabletop/characters/${encodeURIComponent(id)}`).then(
      (adventurer) => live && setLoad({ status: 'ready', adventurer }),
      (err) => live && setLoad({
        status: 'error',
        error: err instanceof ApiError && err.status === 404 ? 'There’s no such adventurer.'
          : err instanceof ApiError && err.status === 403 ? 'This adventurer isn’t yours to see. Their player, their friends and their party can.'
          : errorOf(err, 'This adventurer couldn’t be loaded.'),
      }),
    );
    return () => { live = false; };
  }, [id]);

  const adventurer = load.status === 'ready' ? load.adventurer : null;
  const campaignId = adventurer ? campaignIdOf(adventurer) : null;
  useEffect(() => {
    setParty(null);
    if (!campaignId) return;
    let live = true;
    api.get<PartyCharacter[]>(`/api/tabletop/characters?campaign=${encodeURIComponent(campaignId)}`)
      .then((p) => { if (live) setParty(p); }, () => {});
    return () => { live = false; };
  }, [campaignId]);

  if (load.status === 'loading') return <p className="hs-note hs-adv-wait" role="status">Finding the adventurer…</p>;
  if (load.status === 'error') {
    return (
      <>
        <BackLink href="/characters">Adventurers</BackLink>
        <header className="hs-page-head">
          <h1>A closed door</h1>
          <p>{load.error}</p>
        </header>
      </>
    );
  }

  const c = load.adventurer;
  const canEdit = canEditAdventurer(c, user, capabilities);
  const mates = party ? travelsWith(party, c._id) : null;
  const playerId = playerIdOf(c);
  const campaignTitle = campaignTitleOf(c);

  return (
    <>
      <BackLink href="/characters" full="All adventurers">Adventurers</BackLink>

      <GildedPanel as="header" className={c.isDead ? 'hs-page-head hs-adv-hero is-fallen' : 'hs-page-head hs-adv-hero'}>
        <span className="hs-adv-medal"><Portrait name={c.name} src={c.portraitUrl} face /></span>
        <div className="hs-adv-hero-who">
          <h1>{c.name}</h1>
          <p className="hs-adv-hero-k">{[classLine(c), c.gameType?.trim()].filter(Boolean).join(' · ')}</p>
          {c.isDead && <p className="hs-adv-hero-fell">Fallen</p>}
        </div>
        {c.level != null && (
          <span className="hs-adv-lvl" role="img" aria-label={`Level ${c.level}`}><small>Level</small><b>{c.level}</b></span>
        )}
      </GildedPanel>

      <ArtPanel
        characterId={c._id}
        name={c.name}
        art={c.art ?? []}
        canEdit={canEdit}
        onChange={(reply) => setLoad({ status: 'ready', adventurer: { ...c, ...reply } })}
      />

      <section className="hs-adv-sheet-sec" aria-labelledby="hs-adv-sheet-h">
        <h2 className="hs-sec" id="hs-adv-sheet-h"><span>Their sheet</span></h2>
        <GildedPanel className="hs-adv-sheet">
          <dl className="hs-adv-dl">
            <div>
              <dt>Played by</dt>
              <dd>
                {playerId && playerId !== user?.id
                  ? <Link className="hs-adv-link" href={`/players/${encodeURIComponent(playerId)}`}>{playedByLine(c, user?.id)}</Link>
                  : playedByLine(c, user?.id)}
              </dd>
            </div>
            <div><dt>Class</dt><dd>{c.class?.trim() || <span className="hs-adv-none">Not set</span>}</dd></div>
            <div><dt>Level</dt><dd>{c.level ?? <span className="hs-adv-none">Not set</span>}</dd></div>
            <div><dt>Game</dt><dd>{c.gameType?.trim() || <span className="hs-adv-none">Not set</span>}</dd></div>
            <div>
              <dt>Campaign</dt>
              <dd>
                {!campaignId ? <span className="hs-adv-none">Not in a campaign yet</span>
                  : party ? <Link className="hs-adv-link" href={`/campaigns/${encodeURIComponent(campaignId)}`}>{campaignTitle ?? 'Their campaign'}</Link>
                  : campaignTitle ?? 'In a campaign'}
              </dd>
            </div>
            <div><dt>Status</dt><dd>{statusOf(c)}</dd></div>
          </dl>

          <FullSheet
            characterId={c._id}
            sheetUrl={c.sheetUrl}
            sheet={c.sheet}
            canEdit={canEdit}
            onEditLink={() => setEditing(true)}
            onChange={(sheet) => setLoad({ status: 'ready', adventurer: { ...c, sheet } })}
          />

          {mates && (
            <div className="hs-adv-mates-sec">
              <h3 className="hs-adv-panel-h" id="hs-adv-mates-h">Travels with</h3>
              {mates.length ? (
                <ul className="hs-adv-mates" aria-labelledby="hs-adv-mates-h">
                  {mates.map((m) => (
                    <li key={m._id}>
                      <Link href={`/characters/${encodeURIComponent(m._id)}`} className="hs-adv-mate">
                        <span className="hs-adv-medal is-small"><Portrait name={m.name} src={m.portraitUrl} face /></span>
                        <span className="hs-adv-mate-text">
                          <b>{m.name}</b>
                          <small>
                            {characterLine(m)}
                            {m.player && ` · ${m.player._id === user?.id ? 'you' : m.player.handle ? `@${m.player.handle}` : m.player.name}`}
                          </small>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="hs-adv-empty-line">Nobody else in the party yet.</p>
              )}
            </div>
          )}

          {canEdit && (
            <div className="hs-adv-foot">
              <button type="button" className="hs-btn-amber hs-adv-edit" onClick={() => setEditing(true)}>Edit</button>
            </div>
          )}
        </GildedPanel>
      </section>

      {editing && (
        <AdventurerDialog
          adventurer={c}
          onClose={() => setEditing(false)}
          onSaved={(saved) => { setEditing(false); setLoad({ status: 'ready', adventurer: saved }); }}
        />
      )}
    </>
  );
}
