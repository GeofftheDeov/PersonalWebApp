"use client";

import { useState } from 'react';
import GildedDialog from '@/components/GildedDialog';
import { errorOf } from '@/lib/api';
import { removeBanner, type Banner } from '@/lib/banner';

/** Asks before taking a campaign's banner down; the card goes back to its dyed cloth. */
export default function RemoveBannerDialog({ campaign, onClose, onRemoved }: {
  campaign: { _id: string; title: string };
  onClose: () => void;
  onRemoved: (banner: Banner) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      onRemoved(await removeBanner(campaign._id));
    } catch (err) {
      setError(errorOf(err, 'The banner couldn’t be removed.'));
      setBusy(false);
    }
  };

  return (
    <GildedDialog title="Remove the banner?" onClose={onClose}>
      <div className="hs-form">
        <p className="hs-dialog-text">{campaign.title} goes back to its dyed cloth. You can add a banner again any time.</p>
        {error && <p className="hs-alert" role="alert">{error}</p>}
        <div className="hs-actions">
          <button type="button" className="hs-btn-amber" disabled={busy} onClick={remove}>{busy ? 'Removing…' : 'Remove it'}</button>
          <button type="button" className="hs-ghost" onClick={onClose}>Never mind</button>
        </div>
      </div>
    </GildedDialog>
  );
}
