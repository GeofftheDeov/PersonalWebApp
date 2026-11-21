"use client";

import { useState } from 'react';
import GildedPanel from '@/components/design-system/GildedPanel';
import { api, errorOf } from '@/lib/api';
import { CAMPAIGN_STATUSES, statusLabel, type CampaignStatus } from '@/lib/campaigns';
import {
  DEFAULT_GM_TITLE, campaignForm, formPayload,
  type CampaignDetail, type CampaignForm,
} from '@/lib/campaignPage';

/**
 * Editing a campaign, in place of its details on gilded leather (#224), with
 * the portfolio's fields: title, description, dates and status for anyone in
 * the party (`PUT /api/campaigns/:id`); the planning settings (the GM's
 * title, quorum, table link) for its owner and admins
 * (`PATCH /api/campaigns/:id/settings`); and the Discord server. Fields use
 * the composer's surface, line and radius.
 */
export default function EditCampaignForm({ campaign, isOwner, partySize, onSaved, onClose }: {
  campaign: CampaignDetail;
  /** The owner (or an admin) also edits the planning settings. */
  isOwner: boolean;
  /** For quorum's placeholder: the whole party. */
  partySize: number;
  /** The campaign as the server now has it; `done` is false when the settings failed (the form stays open). */
  onSaved: (campaign: Partial<CampaignDetail>, done: boolean) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<CampaignForm>(() => campaignForm(campaign));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const set = (k: keyof CampaignForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.startDate && form.endDate && form.endDate < form.startDate) { setError('The campaign can’t end before it starts.'); return; }
    setBusy(true);
    setError(null);
    setSettingsError(null);
    const { details, settings } = formPayload(form);
    const path = `/api/campaigns/${encodeURIComponent(campaign._id)}`;
    let saved: CampaignDetail;
    try {
      saved = await api.put<CampaignDetail>(path, details);
    } catch (err) {
      setError(errorOf(err, 'The campaign couldn’t be saved. Try again in a moment.'));
      setBusy(false);
      return;
    }
    if (!isOwner) { onSaved(saved, true); return; }
    try {
      const s = await api.patch<Pick<CampaignDetail, 'quorum' | 'tableLink' | 'gmTitle'>>(`${path}/settings`, settings);
      onSaved({ ...saved, quorum: s.quorum, tableLink: s.tableLink, gmTitle: s.gmTitle }, true);
    } catch (err) {
      // The details were saved; the settings weren't. Show what was, and keep the form open to fix the rest.
      onSaved({ ...saved, quorum: campaign.quorum, tableLink: campaign.tableLink, gmTitle: campaign.gmTitle }, false);
      setSettingsError(errorOf(err, 'The planning settings couldn’t be saved.'));
      setBusy(false);
    }
  };

  return (
    <GildedPanel as="section" className="hs-cp-details" aria-label="Edit the campaign">
      <form className="hs-cp-pad hs-form" onSubmit={save}>
        <div className="hs-cp-form-head">
          <h2>Edit the campaign</h2>
          <button type="button" className="hs-dialog-x" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <label className="hs-field"><span>Title</span>
          <input className="hs-input" required maxLength={120} value={form.title} onChange={set('title')} />
        </label>
        <label className="hs-field"><span>Description</span>
          <textarea className="hs-input" rows={3} value={form.description} onChange={set('description')} />
        </label>
        <div className="hs-grid2">
          <label className="hs-field"><span>Start date</span>
            <input className="hs-input" type="date" value={form.startDate} onChange={set('startDate')} />
          </label>
          <label className="hs-field"><span>End date</span>
            <input className="hs-input" type="date" min={form.startDate || undefined} value={form.endDate} onChange={set('endDate')} />
          </label>
          <label className="hs-field"><span>Status</span>
            <select className="hs-input" value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as CampaignStatus }))}>
              {CAMPAIGN_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
            </select>
          </label>
        </div>

        {isOwner && (
          <fieldset className="hs-cp-group">
            <legend>Planning</legend>
            <label className="hs-field"><span>What this campaign calls its Game Master</span>
              <input className="hs-input" required maxLength={40} placeholder={DEFAULT_GM_TITLE} value={form.gmTitle} onChange={set('gmTitle')} />
            </label>
            <div className="hs-grid2">
              <label className="hs-field"><span>Quorum (players a night needs)</span>
                <input className="hs-input" type="number" min={1} max={50} placeholder={`Whole party (${partySize})`} value={form.quorum} onChange={set('quorum')} />
              </label>
              <label className="hs-field"><span>Table link (online sessions)</span>
                <input className="hs-input" type="url" placeholder="https://foundry.example/game" value={form.tableLink} onChange={set('tableLink')} />
              </label>
            </div>
            <p className="hs-fine">
              The Game Master title is what the party sees: Dungeon Master, Host, Organizer. Leave quorum empty to need the
              whole party. The table link (Foundry, Roll20, a Discord voice channel) shows on every online session.
            </p>
            {settingsError && <p className="hs-alert" role="alert">{settingsError}</p>}
          </fieldset>
        )}

        <fieldset className="hs-cp-group">
          <legend>Discord</legend>
          <div className="hs-grid2">
            <label className="hs-field"><span>Discord server ID</span>
              <input className="hs-input" inputMode="numeric" placeholder="123456789012345678" value={form.discordGuildId} onChange={set('discordGuildId')} />
            </label>
            <label className="hs-field"><span>Voice channel ID (optional)</span>
              <input className="hs-input" inputMode="numeric" placeholder="123456789012345678" value={form.discordChannelId} onChange={set('discordChannelId')} />
            </label>
          </div>
          <p className="hs-fine">
            Lets new sessions make Discord events. Your bot (its token is in your API Key Vault under &ldquo;discord&rdquo;) must
            be in this server with Manage Events. With a voice channel, events are voice events; without one, they use the
            session&rsquo;s location. Turn on Developer Mode in Discord and right-click the server or channel to copy its ID.
          </p>
        </fieldset>

        {error && <p className="hs-alert" role="alert">{error}</p>}
        <div className="hs-actions">
          <button type="submit" className="hs-btn-amber" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
          <button type="button" className="hs-ghost" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </GildedPanel>
  );
}
