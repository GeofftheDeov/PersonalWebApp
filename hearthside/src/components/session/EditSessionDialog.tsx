"use client";

import { useState, type FormEvent } from 'react';
import GildedDialog from '@/components/GildedDialog';
import { errorOf } from '@/lib/api';
import { fromDatetimeLocal, toDatetimeLocal } from '@/lib/sessionPage';
import type { SessionDetail, SessionPatch } from '@/lib/useSessionPage';

/**
 * Edit, for the GM (spec #69): the session's title, night, place and
 * recording link, in a gilded dialog. The tale and Prep notes are written on
 * the page itself. A session being planned gets its night from the Notice
 * Board, so its times aren't offered here. Only what changed is sent.
 */
export default function EditSessionDialog({ session, name, onClose, onSave }: {
  session: SessionDetail;
  /** What the page calls the session: its title, or "Session 6". */
  name: string;
  onClose: () => void;
  onSave: (patch: SessionPatch) => Promise<unknown>;
}) {
  const planning = session.status === 'planning';
  const initial = {
    title: session.title ?? '',
    date: toDatetimeLocal(session.date),
    endDate: toDatetimeLocal(session.endDate),
    location: session.location ?? '',
    isOnline: !!session.isOnline,
    vodUrl: session.vodUrl ?? '',
  };
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: 'title' | 'date' | 'endDate' | 'location' | 'vodUrl') =>
    (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (form.date && form.endDate && form.endDate <= form.date) { setError('The session has to end after it starts.'); return; }
    if (!form.date && form.endDate) { setError('Give it a start as well as an end.'); return; }
    const patch: SessionPatch = {};
    if (form.title.trim() !== initial.title) patch.title = form.title.trim();
    if (!planning && form.date !== initial.date) patch.date = fromDatetimeLocal(form.date);
    if (!planning && form.endDate !== initial.endDate) patch.endDate = fromDatetimeLocal(form.endDate);
    if (form.location.trim() !== initial.location) patch.location = form.location.trim();
    if (form.isOnline !== initial.isOnline) patch.isOnline = form.isOnline;
    if (form.vodUrl.trim() !== initial.vodUrl) patch.vodUrl = form.vodUrl.trim();
    if (!Object.keys(patch).length) { onClose(); return; }
    setBusy(true);
    setError(null);
    try {
      await onSave(patch);
      onClose();
    } catch (err) {
      setError(errorOf(err, 'The session couldn’t be saved. Try again in a moment.'));
      setBusy(false);
    }
  };

  return (
    <GildedDialog title={`Edit ${name}`} onClose={onClose}>
      <form className="hs-form" onSubmit={submit}>
        <label className="hs-field"><span>Title</span>
          <input className="hs-input" maxLength={160} value={form.title} onChange={set('title')} placeholder={name} />
        </label>
        {planning ? (
          <p className="hs-fine">Its night is still being voted on the Notice Board.</p>
        ) : (
          <div className="hs-grid2">
            <label className="hs-field"><span>Starts</span>
              <input className="hs-input" type="datetime-local" value={form.date} onChange={set('date')} />
            </label>
            <label className="hs-field"><span>Ends</span>
              <input className="hs-input" type="datetime-local" value={form.endDate} min={form.date || undefined} onChange={set('endDate')} />
            </label>
          </div>
        )}
        <label className="hs-sess-check">
          <input type="checkbox" checked={form.isOnline} onChange={(e) => setForm((f) => ({ ...f, isOnline: e.target.checked }))} />
          Online session (the campaign&rsquo;s table link shows on the card)
        </label>
        <label className="hs-field"><span>Location</span>
          <input className="hs-input" maxLength={200} value={form.location} onChange={set('location')} placeholder={form.isOnline ? 'Online' : 'Geoff’s place'} />
        </label>
        <label className="hs-field"><span>Recording link</span>
          <input className="hs-input" type="url" value={form.vodUrl} onChange={set('vodUrl')} placeholder="https://" />
        </label>
        {error && <p className="hs-alert" role="alert">{error}</p>}
        <div className="hs-actions">
          <button type="submit" className="hs-btn-amber" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" className="hs-ghost" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </GildedDialog>
  );
}
