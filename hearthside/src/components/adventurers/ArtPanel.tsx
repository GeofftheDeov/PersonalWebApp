"use client";

import { useEffect, useState } from 'react';
import GildedDialog from '@/components/GildedDialog';
import ImageCropDialog from '@/components/ImageCropDialog';
import { errorOf } from '@/lib/api';
import { ART_ASPECT, makePortrait, removeArt, uploadArt, type ArtReply } from '@/lib/adventurerFiles';
import type { AdventurerArt } from '@/lib/adventurers';

/**
 * An adventurer's Art panel (#273, spec #198): every piece in a grid, the
 * portrait marked. A piece opens large in a viewer that steps through the
 * rest. The player (or an admin) also gets an Add art tile, which opens the
 * 3:4 cropper, and in the viewer Make this the portrait and Remove. Anyone
 * else who may read the adventurer sees the art without those.
 */
export default function ArtPanel({ characterId, name, art, canEdit, onChange }: {
  characterId: string;
  name: string;
  art: AdventurerArt[];
  canEdit: boolean;
  onChange: (reply: ArtReply) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  if (!art.length && !canEdit) return null;

  return (
    <section className="hs-adv-art-sec" aria-labelledby="hs-adv-art-h">
      <h2 className="hs-sec" id="hs-adv-art-h">
        <span>Art</span>
        {art.length > 0 && <span className="hs-aside">{art.length === 1 ? '1 piece' : `${art.length} pieces`}</span>}
      </h2>
      <ul className="hs-adv-art" aria-label={`${name}’s art`}>
        {art.map((a, i) => (
          <li key={a._id}>
            <button type="button" className="hs-adv-art-piece" onClick={() => setOpen(i)}
              aria-label={`Open piece ${i + 1} of ${art.length}${a.isPortrait ? ', the portrait' : ''}`}>
              <span className="hs-adv-pt" aria-hidden="true">
                {a.url ? <img className="hs-adv-pt-img" src={a.url} alt="" loading="lazy" decoding="async" draggable={false} />
                  : <span className="hs-adv-pt-none"><span>?</span></span>}
              </span>
              {a.isPortrait && <span className="hs-adv-art-mark">Portrait</span>}
            </button>
          </li>
        ))}
        {canEdit && (
          <li>
            <button type="button" className="hs-adv-art-add" onClick={() => setAdding(true)}>
              <span aria-hidden="true">+</span>Add art
            </button>
          </li>
        )}
      </ul>

      {adding && (
        <ImageCropDialog
          title={`Art for ${name}`}
          aspect={ART_ASPECT}
          portrait
          label="Art crop"
          hint="It hangs at 3:4 in their frame, and their medallion zooms onto the top of it. Drag to choose what shows. JPEG, PNG or WebP; it’s resized before it’s uploaded."
          saveLabel="Add the art"
          failure="The art couldn’t be uploaded."
          save={(img, crop) => uploadArt(characterId, img, crop)}
          onClose={() => setAdding(false)}
          onSaved={(reply) => { setAdding(false); onChange(reply); }}
        />
      )}

      {open !== null && art[open] && (
        <ArtViewer
          characterId={characterId}
          name={name}
          art={art}
          index={open}
          canEdit={canEdit}
          onStep={setOpen}
          onClose={() => setOpen(null)}
          onChange={(reply) => {
            onChange(reply);
            if (!reply.art.length) setOpen(null);
            else setOpen((i) => Math.min(i ?? 0, reply.art.length - 1));
          }}
        />
      )}
    </section>
  );
}

function ArtViewer({ characterId, name, art, index, canEdit, onStep, onClose, onChange }: {
  characterId: string;
  name: string;
  art: AdventurerArt[];
  index: number;
  canEdit: boolean;
  onStep: (i: number) => void;
  onClose: () => void;
  onChange: (reply: ArtReply) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const piece = art[index];
  const many = art.length > 1;
  const step = (d: number) => onStep((index + d + art.length) % art.length);

  useEffect(() => { setConfirming(false); setError(null); }, [index]);

  const act = async (fn: () => Promise<ArtReply>, failure: string) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await fn());
      setConfirming(false);
    } catch (err) {
      setError(errorOf(err, failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <GildedDialog title={`${name}’s art`} onClose={onClose} wide>
      <div
        className="hs-adv-view"
        onKeyDown={(e) => {
          if (!many || (e.target as HTMLElement).closest('button')) return;
          if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
          if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
        }}
      >
        <figure className="hs-adv-view-fig" tabIndex={many ? 0 : undefined} aria-label={many ? 'Use the arrow keys to step through the art' : undefined}>
          {piece.url
            ? <img src={piece.url} alt={`${name}, piece ${index + 1} of ${art.length}${piece.isPortrait ? ' (the portrait)' : ''}`} />
            : <p className="hs-note">This piece can&rsquo;t be shown just now.</p>}
          <figcaption className="hs-fine">
            {many ? `${index + 1} of ${art.length}` : 'The only piece'}
            {piece.isPortrait && ' · the portrait'}
          </figcaption>
        </figure>
        {error && <p className="hs-alert" role="alert">{error}</p>}
        <div className="hs-actions hs-adv-view-acts">
          {many && (
            <>
              <button type="button" className="hs-ghost" onClick={() => step(-1)} aria-label="Previous piece">‹ Previous</button>
              <button type="button" className="hs-ghost" onClick={() => step(1)} aria-label="Next piece">Next ›</button>
            </>
          )}
          {canEdit && !piece.isPortrait && (
            <button type="button" className="hs-btn-amber" disabled={busy}
              onClick={() => act(() => makePortrait(characterId, piece._id), 'The portrait couldn’t be changed.')}>
              Make this the portrait
            </button>
          )}
          {canEdit && (confirming ? (
            <>
              <button type="button" className="hs-btn-amber" disabled={busy}
                onClick={() => act(() => removeArt(characterId, piece._id), 'The art couldn’t be removed.')}>
                {busy ? 'Removing…' : 'Yes, remove it'}
              </button>
              <button type="button" className="hs-ghost" onClick={() => setConfirming(false)}>Keep it</button>
            </>
          ) : (
            <button type="button" className="hs-ghost" onClick={() => setConfirming(true)}>Remove</button>
          ))}
        </div>
      </div>
    </GildedDialog>
  );
}
