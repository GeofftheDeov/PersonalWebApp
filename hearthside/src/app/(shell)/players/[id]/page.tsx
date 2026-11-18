"use client";

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiError } from '@gtd/shared/api';
import LedgerHead from '@/components/room/LedgerHead';
import LedgerTabs from '@/components/room/LedgerTabs';
import RecordPanel from '@/components/room/RecordPanel';
import { api, errorOf } from '@/lib/api';
import { isOwnPage, sinceLabel, type LedgerPerson } from '@/lib/room';
import { useRequiredSession } from '@/lib/session';

type Load =
  | { status: 'loading' }
  | { status: 'ready'; person: LedgerPerson }
  | { status: 'error'; error: string };

/**
 * A player's page, `/players/:id` (spec #69). Your own id is Your Room, so
 * it goes there (#230). Anyone else's is drawn with the ledger's head and
 * record from what `GET /api/users/players/:id` shares (`toPublicPerson`),
 * with no campaigns. "Write a letter", the Friends pill and the rest of it
 * are #231's.
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
    api.get<LedgerPerson>(`/api/users/players/${encodeURIComponent(id)}`).then(
      (person) => live && setLoad({ status: 'ready', person }),
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
  const since = sinceLabel(load.person.createdAt);
  return (
    <>
      <LedgerHead person={load.person} line={since ? `Since ${since}` : null} />
      <LedgerTabs tabs={[{ id: 'record', label: 'Record' }]} tab="record" onTab={() => {}} label="Their record">
        <RecordPanel person={load.person} own={false} />
      </LedgerTabs>
    </>
  );
}
