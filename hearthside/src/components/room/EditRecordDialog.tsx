"use client";

import { useState, type FormEvent } from 'react';
import GildedDialog from '@/components/GildedDialog';
import { api, errorOf } from '@/lib/api';
import { recordDraft, recordEdits, type LedgerPerson, type RecordDraft } from '@/lib/room';

/**
 * Your record, edited in a gilded dialog (layout A): name, handle, phone and
 * Discord, with the email shown but fixed. Save sends only the fields that
 * changed (`PUT /api/users/profile`), then `onSaved` (the page refreshes the
 * session's person) and closes.
 */
export default function EditRecordDialog({ person, onClose, onSaved }: {
  person: LedgerPerson;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<RecordDraft>(() => recordDraft(person));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (f: keyof RecordDraft) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [f]: e.target.value }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const edits = recordEdits(draft, person);
    if (!Object.keys(edits).length) { onClose(); return; }
    if (edits.name === '') { setError('Your name can’t be blank.'); return; }
    setBusy(true);
    setError(null);
    try {
      await api.put('/api/users/profile', edits);
      await onSaved();
      onClose();
    } catch (err) {
      setError(errorOf(err, 'Your record couldn’t be saved. Try again in a moment.'));
      setBusy(false);
    }
  };

  return (
    <GildedDialog title="Your record" onClose={onClose}>
      <form className="hs-form" onSubmit={save}>
        <label className="hs-field">
          <span>Name</span>
          <input className="hs-input" value={draft.name} onChange={set('name')} required autoComplete="name" />
        </label>
        <div className="hs-grid2">
          <label className="hs-field">
            <span>Handle</span>
            <span className="hs-room-at">
              <input className="hs-input" value={draft.handle} onChange={set('handle')} placeholder="yourhandle" autoComplete="off" />
            </span>
          </label>
          <label className="hs-field">
            <span>Phone</span>
            <input className="hs-input" value={draft.phone} onChange={set('phone')} inputMode="tel" autoComplete="tel" />
          </label>
        </div>
        <div className="hs-field">
          <label htmlFor="hs-room-email"><span>Email</span></label>
          <input className="hs-input" id="hs-room-email" value={person.email ?? ''} disabled aria-describedby="hs-room-email-fine" />
          <small className="hs-fine" id="hs-room-email-fine">Email can’t be changed here.</small>
        </div>
        <div className="hs-grid2">
          <label className="hs-field">
            <span>Discord name</span>
            <input className="hs-input" value={draft.discordHandle} onChange={set('discordHandle')} placeholder="username" autoComplete="off" />
          </label>
          <label className="hs-field">
            <span>Discord user ID</span>
            <input className="hs-input" value={draft.discordId} onChange={set('discordId')} placeholder="123456789012345678" inputMode="numeric" autoComplete="off" />
          </label>
        </div>
        <p className="hs-fine">To find your Discord user ID: Settings › Advanced › Developer Mode on, then right-click your name › Copy User ID.</p>
        {error && <p className="hs-alert" role="alert">{error}</p>}
        <div className="hs-actions">
          <button type="submit" className="hs-btn-amber" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
          <button type="button" className="hs-ghost" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </GildedDialog>
  );
}
