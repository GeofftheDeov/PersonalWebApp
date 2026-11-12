"use client";

import { useState, type FormEvent } from 'react';
import GildedDialog from '@/components/GildedDialog';
import { api, errorOf } from '@/lib/api';
import { CAMPAIGN_STATUSES, statusLabel, type CampaignStatus } from '@/lib/campaigns';

/** What the portfolio's form calls the Game Master until the owner names the role. */
const DEFAULT_GM_TITLE = 'Dungeon Master';

const EMPTY = { title: '', description: '', startDate: '', endDate: '', status: 'Not Started' as CampaignStatus, gmTitle: '' };

/**
 * New campaign, in a gilded dialog (spec #69): today's fields, as the
 * portfolio's form has them. `POST /api/campaigns` makes the creator its
 * owner and Game Master.
 */
export default function NewCampaignDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (form.endDate && form.endDate < form.startDate) { setError('The campaign can’t end before it starts.'); return; }
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/campaigns', { ...form, title: form.title.trim(), description: form.description.trim() });
      onCreated();
    } catch (err) {
      setError(errorOf(err, 'The campaign couldn’t be created.'));
      setBusy(false);
    }
  };

  return (
    <GildedDialog title="New campaign" onClose={onClose}>
      <form className="hs-form" onSubmit={submit}>
        <label className="hs-field"><span>Title</span>
          <input className="hs-input" required maxLength={120} value={form.title} onChange={set('title')} placeholder="The Lost Mines of Phandelver" />
        </label>
        <label className="hs-field"><span>Description</span>
          <textarea className="hs-input" required rows={3} value={form.description} onChange={set('description')} placeholder="A classic adventure awaits…" />
        </label>
        <div className="hs-grid2">
          <label className="hs-field"><span>Starts</span>
            <input className="hs-input" type="date" required value={form.startDate} onChange={set('startDate')} />
          </label>
          <label className="hs-field"><span>Ends (optional)</span>
            <input className="hs-input" type="date" min={form.startDate || undefined} value={form.endDate} onChange={set('endDate')} />
          </label>
        </div>
        <label className="hs-field"><span>Status</span>
          <select className="hs-input" required value={form.status} onChange={set('status')}>
            {CAMPAIGN_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
          </select>
        </label>
        <label className="hs-field"><span>What this campaign calls its Game Master</span>
          <input className="hs-input" maxLength={40} value={form.gmTitle} onChange={set('gmTitle')} placeholder={DEFAULT_GM_TITLE} />
        </label>
        <p className="hs-fine">Game Master, Host, Organizer: whatever your group says. Left blank, it&rsquo;s {DEFAULT_GM_TITLE}. You can change it later.</p>
        {error && <p className="hs-alert" role="alert">{error}</p>}
        <div className="hs-actions">
          <button type="submit" className="hs-btn-amber" disabled={busy}>{busy ? 'Creating…' : 'Create the campaign'}</button>
          <button type="button" className="hs-ghost" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </GildedDialog>
  );
}
