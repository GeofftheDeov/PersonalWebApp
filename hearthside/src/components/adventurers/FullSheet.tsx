"use client";

import { useState } from 'react';
import { errorOf } from '@/lib/api';
import { fileSizeLabel, removeSheet, SHEET_INPUT_TYPES, sheetFileProblem, uploadSheet } from '@/lib/adventurerFiles';
import { sheetLinkHost, type AdventurerSheetCopy } from '@/lib/adventurers';

/**
 * The full sheet (#274, spec #198), in the adventurer's sheet panel: a link to
 * wherever it lives (set in Edit) and/or a copy the player uploaded, a PDF or
 * a picture kept exactly as it was. Anyone who may read the adventurer opens
 * them; the player (or an admin) uploads, replaces or removes the copy.
 */
export default function FullSheet({ characterId, sheetUrl, sheet, canEdit, onEditLink, onChange }: {
  characterId: string;
  sheetUrl: string | null | undefined;
  sheet: AdventurerSheetCopy | null | undefined;
  canEdit: boolean;
  /** Opens Edit, where the link is set. */
  onEditLink: () => void;
  onChange: (sheet: AdventurerSheetCopy | null) => void;
}) {
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!sheetUrl && !sheet && !canEdit) return null;

  const upload = async (file: File | undefined) => {
    if (!file) return;
    const problem = sheetFileProblem(file);
    if (problem) { setError(problem); return; }
    setBusy('upload');
    setError(null);
    try {
      onChange((await uploadSheet(characterId, file)).sheet);
    } catch (err) {
      setError(errorOf(err, 'The sheet couldn’t be uploaded.'));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('remove');
    setError(null);
    try {
      onChange((await removeSheet(characterId)).sheet);
      setConfirming(false);
    } catch (err) {
      setError(errorOf(err, 'The copy couldn’t be removed.'));
    } finally {
      setBusy(null);
    }
  };

  const size = fileSizeLabel(sheet?.size);

  return (
    <div className="hs-adv-full">
      <h3 className="hs-adv-panel-h" id="hs-adv-full-h">The full sheet</h3>
      <ul className="hs-adv-full-list" aria-labelledby="hs-adv-full-h">
        {sheetUrl && (
          <li>
            <a className="hs-adv-link" href={sheetUrl} target="_blank" rel="noopener noreferrer">
              Open the sheet<span className="hs-sr-only"> (opens in a new tab)</span>
            </a>
            <small> on {sheetLinkHost(sheetUrl)}</small>
          </li>
        )}
        {sheet && (
          <li>
            {sheet.url
              ? <a className="hs-adv-link" href={sheet.url} target="_blank" rel="noopener noreferrer">{sheet.name}<span className="hs-sr-only"> (opens in a new tab)</span></a>
              : <span>{sheet.name}</span>}
            <small>{[' an uploaded copy', size].filter(Boolean).join(' · ')}</small>
          </li>
        )}
        {!sheetUrl && !sheet && <li className="hs-adv-none">No sheet yet. Link to where it lives, or upload a copy.</li>}
      </ul>

      {canEdit && (
        <div className="hs-adv-full-acts">
          <label className={busy ? 'hs-ghost is-busy' : 'hs-ghost'} aria-disabled={busy ? true : undefined}>
            {busy === 'upload' ? 'Uploading…' : sheet ? 'Replace the copy' : 'Upload a sheet'}
            <input type="file" className="hs-sr-only" accept={SHEET_INPUT_TYPES.join(',')} disabled={!!busy}
              aria-label={sheet ? 'Replace the copy' : 'Upload a sheet'}
              onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          {sheet && (confirming ? (
            <>
              <button type="button" className="hs-btn-amber" disabled={!!busy} onClick={remove}>
                {busy === 'remove' ? 'Removing…' : 'Yes, remove the copy'}
              </button>
              <button type="button" className="hs-ghost" onClick={() => setConfirming(false)}>Keep it</button>
            </>
          ) : (
            <button type="button" className="hs-ghost" onClick={() => setConfirming(true)}>Remove the copy</button>
          ))}
          <button type="button" className="hs-ghost" onClick={onEditLink}>{sheetUrl ? 'Change the link' : 'Link to it'}</button>
        </div>
      )}
      {canEdit && <p className="hs-fine hs-adv-full-fine">A PDF or a picture, up to 10 MB. It&rsquo;s kept exactly as you upload it.</p>}
      {error && <p className="hs-alert hs-adv-full-fine" role="alert">{error}</p>}
    </div>
  );
}
