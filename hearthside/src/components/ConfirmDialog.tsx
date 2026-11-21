"use client";

import { useState, type ReactNode } from 'react';
import GildedDialog from '@/components/GildedDialog';
import { errorOf } from '@/lib/api';

export interface ConfirmDialogProps {
  /** The question, as the dialog's heading: "Leave the campaign?" */
  title: string;
  /** What happens if they say yes. */
  children: ReactNode;
  /** The yes button: "Leave". */
  yes: string;
  /** The yes button while it works: "Leaving…". */
  busy?: string;
  /** Does it. Throw to keep the dialog open and show what went wrong. */
  onYes: () => Promise<void>;
  onClose: () => void;
  /** Shown when the call fails without the server saying why. */
  fallbackError?: string;
}

/**
 * A confirmation in a gilded dialog, in place of `window.confirm` (spec #69):
 * the question, what happens, then the yes button and Never mind. The yes
 * button runs `onYes`; if it throws, the dialog stays open with the error.
 * Mount it to ask; the parent unmounts it when `onYes` is done or on close.
 *
 *   {asking && <ConfirmDialog title="Leave the campaign?" yes="Leave" busy="Leaving…"
 *      onYes={leave} onClose={() => setAsking(false)}>You'll need the invite link to rejoin.</ConfirmDialog>}
 */
export default function ConfirmDialog({ title, children, yes, busy: busyLabel, onYes, onClose, fallbackError }: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await onYes();
    } catch (err) {
      setError(errorOf(err, fallbackError ?? 'That didn’t work. Try again in a moment.'));
      setBusy(false);
    }
  };

  return (
    <GildedDialog title={title} onClose={onClose}>
      <div className="hs-form">
        <p className="hs-dialog-text">{children}</p>
        {error && <p className="hs-alert" role="alert">{error}</p>}
        <div className="hs-actions">
          <button type="button" className="hs-btn-amber" disabled={busy} onClick={go}>{busy && busyLabel ? busyLabel : yes}</button>
          <button type="button" className="hs-ghost" onClick={onClose}>Never mind</button>
        </div>
      </div>
    </GildedDialog>
  );
}
