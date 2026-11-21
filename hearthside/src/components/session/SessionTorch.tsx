"use client";

import { useId, useState } from 'react';
import { Flame } from 'lucide-react';
import GildedDialog from '@/components/GildedDialog';
import { api, errorOf } from '@/lib/api';
import type { PartyMember } from '@/lib/useSessionPage';

/**
 * The one-session torch (#57, #89) on a session's card: who's running this
 * session in the GM's place, and, for the campaign's GM, passing it for this
 * session or taking it back. The stand-in may hand it back. Confirmed in a
 * gilded dialog. Backed by POST / DELETE /api/planning/sessions/:id/torch;
 * the server checks who may.
 */
export default function SessionTorch({ sessionId, gmTitle, party, gameMasterIds, standIn, viewerId, canPass, onChanged }: {
  sessionId: string;
  gmTitle: string;
  party: PartyMember[];
  gameMasterIds: string[];
  standIn: PartyMember | null;
  viewerId: string | null;
  /** The campaign's own GM (or an admin), not a stand-in. */
  canPass: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const selectId = useId();
  const [to, setTo] = useState('');
  const [asking, setAsking] = useState<'pass' | 'back' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isStandIn = !!standIn && standIn.id === viewerId;
  const candidates = party.filter((p) => !gameMasterIds.includes(p.id) && p.id !== standIn?.id);
  const chosen = candidates.find((c) => c.id === to) ?? null;
  if (!standIn && !(canPass && candidates.length)) return null;

  const send = async (method: 'POST' | 'DELETE') => {
    setBusy(true);
    setError(null);
    try {
      await api.request(`/api/planning/sessions/${encodeURIComponent(sessionId)}/torch`, {
        method, body: method === 'POST' ? { to } : undefined,
      });
      setAsking(null);
      setTo('');
      await onChanged();
    } catch (err) {
      setError(errorOf(err, 'The torch couldn’t be passed. Try again in a moment.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hs-sess-torch">
      {standIn ? (
        <p>
          <Flame className="hs-flame" strokeWidth={1.6} aria-hidden="true" />
          <span><b>{isStandIn ? 'You are' : `${standIn.name} is`}</b> running this session as {gmTitle}.</span>
          {(canPass || isStandIn) && (
            <button type="button" className="hs-btn is-torch" onClick={() => { setError(null); setAsking('back'); }}>
              {isStandIn ? 'Hand it back' : 'Take it back'}
            </button>
          )}
        </p>
      ) : null}
      {canPass && candidates.length > 0 && (
        <form onSubmit={(e) => { e.preventDefault(); if (chosen) { setError(null); setAsking('pass'); } }}>
          {!standIn && <Flame className="hs-flame" strokeWidth={1.6} aria-hidden="true" />}
          <label htmlFor={selectId}>{standIn ? 'Or pass it to' : 'Pass the torch for this session'}</label>
          <select id={selectId} value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Choose who runs it</option>
            {candidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button type="submit" className="hs-btn is-torch" disabled={!chosen}>Pass the torch</button>
        </form>
      )}
      {error && !asking && <p className="hs-sess-alert" role="alert">{error}</p>}

      {asking && (
        <GildedDialog
          title={asking === 'pass' ? 'Pass the torch?' : isStandIn ? 'Hand the torch back?' : 'Take the torch back?'}
          onClose={() => setAsking(null)}
        >
          <div className="hs-form">
            <p className="hs-dialog-text">
              {asking === 'pass'
                ? `${chosen?.name} runs this session as ${gmTitle}, and sees its prep notes. You stay the campaign’s ${gmTitle}.`
                : isStandIn
                  ? `This session goes back to the campaign’s ${gmTitle}.`
                  : `${standIn?.name} stops running this session, and you run it again.`}
            </p>
            {error && <p className="hs-alert" role="alert">{error}</p>}
            <div className="hs-actions">
              <button type="button" className="hs-btn-amber" disabled={busy} onClick={() => send(asking === 'pass' ? 'POST' : 'DELETE')}>
                {busy ? 'Passing…' : asking === 'pass' ? `Pass it to ${chosen?.name}` : isStandIn ? 'Hand it back' : 'Take it back'}
              </button>
              <button type="button" className="hs-ghost" onClick={() => setAsking(null)}>Never mind</button>
            </div>
          </div>
        </GildedDialog>
      )}
    </div>
  );
}
