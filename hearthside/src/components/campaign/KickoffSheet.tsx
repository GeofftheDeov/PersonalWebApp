"use client";

import { useId, useState, type FormEvent } from 'react';
import NoticeSheet from '@/components/design-system/NoticeSheet';
import { api, errorOf } from '@/lib/api';
import { EMPTY_KICKOFF, kickoffPayload, kickoffReady, type FoodMode, type KickoffForm, type Member } from '@/lib/noticeBoard';

/**
 * "Plan a session" (#57, #225): the GM pins up a new notice. Its title, prep
 * notes only the GM sees, online or in person, and in person how the food
 * works (a potluck, or provided by someone in the party). Starting it tells
 * the party, and the notice takes this sheet's place on the board.
 * Backed by POST /api/planning/campaigns/:id/kickoff.
 */
export default function KickoffSheet({ campaignId, campaignTitle, party, onStarted, onClose }: {
  campaignId: string;
  campaignTitle: string;
  /** Who can provide the food. */
  party: Member[];
  onStarted: () => void | Promise<void>;
  onClose: () => void;
}) {
  const id = useId();
  const [form, setForm] = useState<KickoffForm>(EMPTY_KICKOFF);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof KickoffForm>(k: K, v: KickoffForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const start = async (e: FormEvent) => {
    e.preventDefault();
    if (!kickoffReady(form)) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/planning/campaigns/${encodeURIComponent(campaignId)}/kickoff`, kickoffPayload(form));
    } catch (err) {
      setError(errorOf(err, 'Planning couldn’t be started. Try again in a moment.'));
      setBusy(false);
      return;
    }
    await onStarted();
  };

  return (
    <NoticeSheet seed={`${campaignId}/new`} className="hs-board-sheet" aria-labelledby={`${id}-h`}>
      <form onSubmit={start} aria-labelledby={`${id}-h`}>
        <div className="hs-sheet-head">
          <div className="hs-board-head-text">
            <div className="hs-kicker">{campaignTitle}</div>
            <h3 className="hs-sheet-title" id={`${id}-h`}>A new notice</h3>
            <p className="hs-byline">Start planning a session. The party is told.</p>
          </div>
          <button type="button" className="hs-btn" onClick={onClose}>Never mind</button>
        </div>
        <div className="hs-board-kickoff">
          <label className="hs-pick-field"><span>Session title</span>
            <input className="hs-paper-input" required maxLength={120} value={form.title} placeholder="Session 14: The Drowned Chapel"
              onChange={(e) => set('title', e.target.value)} />
          </label>
          <label className="hs-pick-field"><span>Prep notes (optional; only the Game Master sees them)</span>
            <textarea className="hs-paper-input" rows={2} maxLength={2000} value={form.agenda} onChange={(e) => set('agenda', e.target.value)} />
          </label>
          <fieldset className="hs-board-where">
            <legend>Where</legend>
            <div className="hs-board-choice">
              <label><input type="radio" name={`${id}-where`} checked={form.isOnline} onChange={() => set('isOnline', true)} /> Online</label>
              <label><input type="radio" name={`${id}-where`} checked={!form.isOnline} onChange={() => set('isOnline', false)} /> In person</label>
            </div>
            <p className="hs-board-fine">
              {form.isOnline ? 'The party picks a night, and it’s on, at the campaign’s table link.' : 'The party picks a night, then a venue, then sorts the food.'}
            </p>
          </fieldset>
          {!form.isOnline && (
            <div className="hs-board-row">
              <label className="hs-pick-field hs-board-grow"><span>Food</span>
                <select className="hs-paper-input" required value={form.foodMode} onChange={(e) => set('foodMode', e.target.value as FoodMode | '')}>
                  <option value="">Choose…</option>
                  <option value="potluck">Potluck</option>
                  <option value="provided">Food provided</option>
                </select>
              </label>
              {form.foodMode === 'provided' && (
                <label className="hs-pick-field hs-board-grow"><span>Provided by</span>
                  <select className="hs-paper-input" required value={form.foodOwnerId} onChange={(e) => set('foodOwnerId', e.target.value)}>
                    <option value="">Choose…</option>
                    {party.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
              )}
            </div>
          )}
          {error && <p className="hs-board-alert" role="alert">{error}</p>}
          <div className="hs-btn-row">
            <button type="submit" className="hs-btn is-primary" disabled={busy || !kickoffReady(form)}>{busy ? 'Starting…' : 'Start planning'}</button>
          </div>
        </div>
      </form>
    </NoticeSheet>
  );
}
