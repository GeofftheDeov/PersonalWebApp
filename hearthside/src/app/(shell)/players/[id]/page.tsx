"use client";

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiError } from '@gtd/shared/api';
import LedgerHead from '@/components/room/LedgerHead';
import LedgerTabs from '@/components/room/LedgerTabs';
import RecordPanel from '@/components/room/RecordPanel';
import { useLetters } from '@/components/letters/LettersProvider';
import { api, errorOf } from '@/lib/api';
import {
  displayName, friendship, isOwnPage, personId, visitorLine, visitorView, type LedgerPerson, type PlayerReply,
} from '@/lib/room';
import { useRequiredSession } from '@/lib/session';

type Load =
  | { status: 'loading' }
  | { status: 'ready'; person: LedgerPerson; friends: boolean }
  | { status: 'error'; error: string };

/**
 * Another player's page, `/players/:id` (#231, spec #69): layout A as a
 * visitor. Your own id is Your Room, so it goes there (#230). Anyone else's
 * is the ledger's head and record, drawn from the public fields of
 * `GET /api/users/players/:id` (`visitorView`), with "Write a letter" and the
 * Friends pill in place of Edit (`friendship`). It never shows their
 * campaigns, and has no tab strip until #200 gives it adventurers and
 * sessions together.
 */
export default function PlayerPage() {
  const params = useParams();
  const id = String(params?.id ?? '');
  const router = useRouter();
  const { user } = useRequiredSession();
  const own = isOwnPage(id, user);

  useEffect(() => {
    if (own) router.replace(`/room${window.location.hash}`);
  }, [own, router]);

  if (!user || own) return <p className="hs-note hs-room-wait" role="status">Opening the room…</p>;
  return <PlayerLedger key={id} id={id} />;
}

function PlayerLedger({ id }: { id: string }) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    api.get<PlayerReply>(`/api/users/players/${encodeURIComponent(id)}`).then(
      (reply) => live && setLoad({ status: 'ready', ...visitorView(reply) }),
      (err) => live && setLoad({
        status: 'error',
        error: err instanceof ApiError && err.status === 404 ? 'There’s no such player.' : errorOf(err, 'Their page couldn’t be loaded.'),
      }),
    );
    return () => { live = false; };
  }, [id]);

  if (load.status === 'loading') return <p className="hs-note hs-room-wait" role="status">Opening the room…</p>;
  if (load.status === 'error') {
    return (
      <header className="hs-page-head">
        <h1>A closed door</h1>
        <p>{load.error}</p>
      </header>
    );
  }
  const { person, friends } = load;
  return (
    <>
      <LedgerHead
        person={person}
        line={visitorLine(person)}
        actions={<VisitorActions id={personId(person) || id} name={displayName(person)} friends={friends} />}
      />
      <LedgerTabs tabs={[{ id: 'record', label: 'Record' }]} tab="record" onTab={() => {}} label="Their record">
        <RecordPanel person={person} own={false} />
      </LedgerTabs>
    </>
  );
}

/** In place of Edit: a friend's "Write a letter" (your DM with them in Letters, #221) and the Friends pill. */
function VisitorActions({ id, name, friends }: { id: string; name: string; friends: boolean }) {
  const letters = useLetters();
  const { pill, canWrite, note } = friendship(friends);
  return (
    <>
      {canWrite && (
        <button type="button" className="hs-btn-amber hs-room-edit" onClick={() => letters.openDm(id, name)}>Write a letter</button>
      )}
      {pill && <span className="hs-room-pill is-ok hs-room-friend">{pill}</span>}
      {note && <p className="hs-room-visit-note">{note}</p>}
    </>
  );
}
