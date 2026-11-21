"use client";

import { useEffect, useState, type FormEvent } from 'react';
import GildedDialog from '@/components/GildedDialog';
import Portrait from '@/components/adventurers/Portrait';
import { api, errorOf, getOrNull } from '@/lib/api';
import {
  EMPTY_ADVENTURER, MAX_LEVEL, adventurerPayload, campaignChoices, formOf, formProblem,
  type Adventurer, type AdventurerForm,
} from '@/lib/adventurers';

/**
 * New adventurer and Edit (#229, spec #69): one gilded dialog with today's
 * fields (name, class, level, game, campaign and whether they've fallen), as
 * the portfolio's forms have them. `POST /api/tabletop/characters` makes the
 * viewer its player; `PUT /api/tabletop/characters/:id` is its player's (or an
 * admin's). Whatever the server refuses, a 403 included, is said in the
 * dialog, which stays open (#235).
 */
export default function AdventurerDialog({ adventurer, onClose, onSaved }: {
  /** The adventurer to edit; leave it out for a new one. */
  adventurer?: Adventurer;
  onClose: () => void;
  /** The server's reply: the adventurer as saved. */
  onSaved: (saved: Adventurer) => void;
}) {
  const editing = !!adventurer;
  const [form, setForm] = useState<AdventurerForm>(() => (adventurer ? formOf(adventurer) : EMPTY_ADVENTURER));
  const [campaigns, setCampaigns] = useState<{ _id: string; title: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: 'name' | 'class' | 'level' | 'gameType' | 'campaign') =>
    (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // The campaigns to put them in: the viewer's own (an admin's list is every campaign, as the API allows).
  useEffect(() => {
    let live = true;
    getOrNull<{ _id: string; title: string }[]>('/api/campaigns').then((list) => {
      if (live && list) setCampaigns(list.map((c) => ({ _id: String(c._id), title: c.title })));
    });
    return () => { live = false; };
  }, []);
  const choices = campaignChoices(campaigns, adventurer ?? null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = formProblem(form);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      const body = adventurerPayload(form);
      const saved = adventurer
        ? await api.put<Adventurer>(`/api/tabletop/characters/${encodeURIComponent(adventurer._id)}`, body)
        : await api.post<Adventurer>('/api/tabletop/characters', body);
      onSaved(saved);
    } catch (err) {
      setError(errorOf(err, editing ? 'The changes couldn’t be saved.' : 'The adventurer couldn’t be added.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <GildedDialog title={adventurer ? `Edit ${adventurer.name}` : 'New adventurer'} onClose={onClose}>
      <form className="hs-form hs-adv-form" onSubmit={submit} noValidate>
        <div className="hs-adv-form-top">
          <span className={form.isDead ? 'hs-adv-frame is-fallen' : 'hs-adv-frame'}><Portrait name={form.name || '?'} /></span>
          <div className="hs-adv-form-who">
            <label className="hs-field"><span>Name</span>
              <input className="hs-input" required maxLength={120} autoComplete="off" value={form.name} onChange={set('name')} placeholder="What the party calls them" />
            </label>
            <p className="hs-fine">Their portrait comes later. Until then, their initials hang in the frame.</p>
          </div>
        </div>
        <div className="hs-adv-form-cls">
          <label className="hs-field"><span>Class</span>
            <input className="hs-input" maxLength={80} value={form.class} onChange={set('class')} placeholder="Paladin, Netrunner" />
          </label>
          <label className="hs-field"><span>Level</span>
            <input className="hs-input" type="number" inputMode="numeric" required min={1} max={MAX_LEVEL} step={1} value={form.level} onChange={set('level')} />
          </label>
        </div>
        <label className="hs-field"><span>Game</span>
          <input className="hs-input" maxLength={80} value={form.gameType} onChange={set('gameType')} placeholder="D&D 5e, Starfinder, Call of Cthulhu" />
        </label>
        <label className="hs-field"><span>Campaign</span>
          <select className="hs-input" value={form.campaign} onChange={set('campaign')}>
            <option value="">Not in a campaign yet</option>
            {choices.map((c) => <option key={c._id} value={c._id}>{c.title}</option>)}
          </select>
        </label>
        <div className="hs-field"><span id="hs-adv-status">Status</span>
          <div className="hs-adv-seg" role="group" aria-labelledby="hs-adv-status">
            <button type="button" aria-pressed={!form.isDead} onClick={() => setForm((f) => ({ ...f, isDead: false }))}>Adventuring</button>
            <button type="button" aria-pressed={form.isDead} onClick={() => setForm((f) => ({ ...f, isDead: true }))}>Fallen</button>
          </div>
        </div>
        {error && <p className="hs-alert" role="alert">{error}</p>}
        <div className="hs-actions">
          <button type="submit" className="hs-btn-amber" disabled={busy}>
            {busy ? 'Saving…' : editing ? 'Save' : 'Add to the roster'}
          </button>
          <button type="button" className="hs-ghost" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </GildedDialog>
  );
}
