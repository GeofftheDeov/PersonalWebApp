"use client";

import { useId, useState } from 'react';
import { Flame } from 'lucide-react';
import ConfirmDialog from '@/components/ConfirmDialog';
import { api } from '@/lib/api';
import {
  claimQuestion, gmTitleOf, memberName, torchPassQuestion,
  type CampaignDetail, type PartyView,
} from '@/lib/campaignPage';

/**
 * The campaign's torch (#89, #193) under the Game Master in its details, on
 * leather, in the torch's orange with its flame: the GM (or an admin) passes
 * it for good; on an admin-managed campaign nobody holds, a party member may
 * claim it. Each is confirmed in a gilded dialog. Backed by
 * `POST /api/campaigns/:id/torch {to, from?}` and `POST /api/campaigns/:id/torch/claim`;
 * both reply with the campaign's `owner`, which a first holder becomes.
 */
export default function CampaignTorch({ campaign, view, viewerId, onChanged }: {
  campaign: CampaignDetail;
  view: PartyView;
  viewerId: string | null;
  /** After a pass or claim: the campaign's owner now, to show it; then re-read the party. */
  onChanged: (owner: string | null) => Promise<void>;
}) {
  const toId = useId();
  const fromId = useId();
  const [choosing, setChoosing] = useState(false);
  const [to, setTo] = useState('');
  const [from, setFrom] = useState('');
  const [asking, setAsking] = useState<'pass' | 'claim' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const title = gmTitleOf(campaign);
  const path = `/api/campaigns/${encodeURIComponent(campaign._id)}/torch`;

  const target = view.torchCandidates.find((m) => m.playerId === to) ?? null;
  const viewerIsGm = view.gameMasters.some((m) => m.playerId === viewerId);
  // A GM passing it steps down themselves; an admin who isn't one names who does when there's more than one.
  const stepsDown = viewerIsGm
    ? view.gameMasters.find((m) => m.playerId === viewerId) ?? null
    : view.gameMasters.length === 1 ? view.gameMasters[0] : view.gameMasters.find((m) => m.playerId === from) ?? null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!target) { setError(`Choose the new ${title}.`); return; }
    if (view.torchNeedsFrom && !stepsDown) { setError(`Choose which ${title} steps down.`); return; }
    setError(null);
    setAsking('pass');
  };

  const pass = async () => {
    const body = !viewerIsGm && view.torchNeedsFrom && stepsDown ? { to, from: stepsDown.playerId } : { to };
    const passed = await api.post<{ owner: string | null }>(path, body);
    setAsking(null);
    setChoosing(false);
    setTo('');
    setFrom('');
    await onChanged(passed.owner);
  };

  const claim = async () => {
    const claimed = await api.post<{ owner: string | null }>(`${path}/claim`);
    setAsking(null);
    await onChanged(claimed.owner);
  };

  if (!view.canPassTorch && !view.canClaimTorch) return null;

  return (
    <div className="hs-cp-torch">
      {view.canPassTorch && !choosing && (
        <button type="button" className="hs-cp-link is-torch" onClick={() => { setChoosing(true); setError(null); }}>
          <Flame className="hs-cp-flame" strokeWidth={1.5} aria-hidden="true" /> Pass the torch
        </button>
      )}
      {view.canClaimTorch && (
        <button type="button" className="hs-btn-torch" onClick={() => { setError(null); setAsking('claim'); }}>
          <Flame className="hs-cp-flame" strokeWidth={1.5} aria-hidden="true" /> Claim the torch
        </button>
      )}
      {view.canPassTorch && choosing && (
        <form className="hs-cp-torch-form" onSubmit={submit} aria-label="Pass the torch">
          <label className="hs-sr-only" htmlFor={toId}>New {title}</label>
          <select id={toId} className="hs-input" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">New {title}…</option>
            {view.torchCandidates.map((m) => <option key={m._id} value={m.playerId!}>{memberName(m)}</option>)}
          </select>
          {view.torchNeedsFrom && (
            <>
              <label className="hs-sr-only" htmlFor={fromId}>Who steps down</label>
              <select id={fromId} className="hs-input" value={from} onChange={(e) => setFrom(e.target.value)}>
                <option value="">Who steps down…</option>
                {view.gameMasters.map((m) => <option key={m._id} value={m.playerId!}>{memberName(m)}</option>)}
              </select>
            </>
          )}
          <div className="hs-actions">
            <button type="submit" className="hs-btn-torch">
              <Flame className="hs-cp-flame" strokeWidth={1.5} aria-hidden="true" /> Pass it
            </button>
            <button type="button" className="hs-ghost" onClick={() => { setChoosing(false); setError(null); }}>Never mind</button>
          </div>
        </form>
      )}
      {error && <p className="hs-alert" role="alert">{error}</p>}

      {asking === 'pass' && target && (
        <ConfirmDialog
          title="Pass the torch?"
          yes="Pass the torch"
          busy="Passing…"
          onYes={pass}
          onClose={() => setAsking(null)}
          fallbackError="The torch couldn’t be passed. Try again in a moment."
        >
          {torchPassQuestion(campaign, { to: target, from: stepsDown, viewerIsGm })}
        </ConfirmDialog>
      )}
      {asking === 'claim' && (
        <ConfirmDialog
          title="Claim the torch?"
          yes="Claim the torch"
          busy="Claiming…"
          onYes={claim}
          onClose={() => setAsking(null)}
          fallbackError="The torch couldn’t be claimed. Try again in a moment."
        >
          {claimQuestion(campaign)}
        </ConfirmDialog>
      )}
    </div>
  );
}
