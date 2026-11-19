"use client";

import { useState, type FormEvent } from 'react';
import GildedDialog from '@/components/GildedDialog';
import { api, errorOf } from '@/lib/api';
import {
  EMPTY_SESSION_FORM, sessionFormNeeds, sessionFormProblem, sessionPayload,
  type CampaignSession, type DiscordLink, type SessionForm,
} from '@/lib/campaignRecords';

/** A switch, as the prototype draws them: a track and a knob, then its words. */
function Switch({ on, onChange, children }: { on: boolean; onChange: (on: boolean) => void; children: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} className="hs-switch" onClick={() => onChange(!on)}>
      <i aria-hidden="true" /><span>{children}</span>
    </button>
  );
}

/**
 * The GM's "Add a session" (#225), in a gilded dialog: a session with its
 * night already fixed (the Notice Board is for planning one with the party).
 * Its title, start and end, where, online or not, the prep notes, and
 * whether to make a Discord event and a Google Calendar event, which need
 * both times (and Discord a location, unless the campaign has a voice
 * channel). Backed by POST /api/tabletop/sessions; the server saves the
 * session before it makes any event (#214), and returns warnings for any
 * event it couldn't make.
 */
export default function AddSessionDialog({ campaign, onAdded, onClose }: {
  campaign: DiscordLink & { _id: string };
  onAdded: (session: CampaignSession, warnings: string[]) => void | Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = useState<SessionForm>(EMPTY_SESSION_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needs = sessionFormNeeds(form, campaign);
  const set = <K extends keyof SessionForm>(k: K, v: SessionForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const problem = sessionFormProblem(form, campaign);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      const made = await api.post<CampaignSession & { warnings?: string[] }>('/api/tabletop/sessions', sessionPayload(form, campaign._id));
      await onAdded(made, made.warnings ?? []);
    } catch (err) {
      setError(errorOf(err, 'The session couldn’t be added. Try again in a moment.'));
      setBusy(false);
    }
  };

  return (
    <GildedDialog title="Add a session" onClose={onClose}>
      <form className="hs-form" onSubmit={save}>
        <label className="hs-field"><span>Title</span>
          <input className="hs-input" required maxLength={120} value={form.title} onChange={(e) => set('title', e.target.value)} />
        </label>
        <div className="hs-grid2">
          <label className="hs-field"><span>Starts{needs.times ? ' (required)' : ''}</span>
            <input className="hs-input" type="datetime-local" required={needs.times} value={form.date} onChange={(e) => set('date', e.target.value)} />
          </label>
          <label className="hs-field"><span>Ends{needs.times ? ' (required)' : ''}</span>
            <input className="hs-input" type="datetime-local" required={needs.times} min={form.date || undefined} value={form.endDate}
              onChange={(e) => set('endDate', e.target.value)} />
          </label>
        </div>
        <label className="hs-field"><span>Location{needs.location ? ' (required)' : ''}</span>
          <input className="hs-input" required={needs.location} placeholder={form.isOnline ? 'Online' : 'Geoff’s place'}
            value={form.location} onChange={(e) => set('location', e.target.value)} />
        </label>
        <Switch on={form.isOnline} onChange={(v) => set('isOnline', v)}>Online session</Switch>
        <label className="hs-field"><span>Prep notes (only the Game Master sees them)</span>
          <textarea className="hs-input" rows={3} value={form.agenda} onChange={(e) => set('agenda', e.target.value)} />
        </label>
        <fieldset className="hs-cp-group">
          <legend>Events elsewhere</legend>
          <Switch on={form.createDiscordEvent} onChange={(v) => set('createDiscordEvent', v)}>
            {campaign.discordGuildId ? 'Make a Discord event' : 'Make a Discord event (link a server on this campaign first)'}
          </Switch>
          <Switch on={form.createGoogleEvent} onChange={(v) => set('createGoogleEvent', v)}>Make a Google Calendar event</Switch>
          {needs.times && (
            <p className="hs-fine">
              Events need a start and an end time{form.createDiscordEvent && !campaign.discordChannelId ? ', and Discord needs a location (or online)' : ''}.
              Prep notes stay off the event: only the Game Master sees them.
            </p>
          )}
        </fieldset>
        {error && <p className="hs-alert" role="alert">{error}</p>}
        <div className="hs-actions">
          <button type="submit" className="hs-btn-amber" disabled={busy}>{busy ? 'Adding…' : 'Add the session'}</button>
          <button type="button" className="hs-ghost" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </GildedDialog>
  );
}
