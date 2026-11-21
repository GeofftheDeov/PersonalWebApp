"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import GildedDialog from '@/components/GildedDialog';
import {
  BANNER_ASPECT, BANNER_INPUT_TYPES, BANNER_SOURCE_MAX_BYTES,
  type Banner, type CropRect, cropToBanner, uploadBanner,
} from '@/lib/banner';

/**
 * The owner's banner cropper (#81) in a gilded dialog: pick an image, drag
 * and zoom it inside a 4:1 frame, then upload the crop. The server checks
 * that the caller owns the campaign; this only opens for owners and admins.
 */
export default function BannerEditor({ campaignId, onClose, onSaved }: {
  campaignId: string;
  onClose: () => void;
  onSaved: (banner: Banner) => void;
}) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  // Where the image's top-left corner is, from the frame's, in frame pixels.
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [frameW, setFrameW] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const objectUrl = useRef<string | null>(null);

  const frameH = frameW / BANNER_ASPECT;
  // At zoom 1 the image just covers the frame; zooming scales from there.
  const baseScale = img && frameW ? Math.max(frameW / img.naturalWidth, frameH / img.naturalHeight) : 1;
  const scale = baseScale * zoom;

  const clamp = useCallback((x: number, y: number, s = scale) => {
    if (!img) return { x: 0, y: 0 };
    const minX = frameW - img.naturalWidth * s, minY = frameH - img.naturalHeight * s;
    return { x: Math.min(0, Math.max(minX, x)), y: Math.min(0, Math.max(minY, y)) };
  }, [img, frameW, frameH, scale]);

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setFrameW(el.clientWidth));
    ro.observe(el);
    setFrameW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Keep the image covering the frame when the frame resizes.
  useEffect(() => { setOffset((o) => clamp(o.x, o.y)); }, [clamp]);

  useEffect(() => () => { if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); }, []);

  const pick = (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (!BANNER_INPUT_TYPES.includes(file.type)) { setError('Pick a JPEG, PNG or WebP image.'); return; }
    if (file.size > BANNER_SOURCE_MAX_BYTES) { setError('That image is over 25 MB. Pick a smaller one.'); return; }
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    const url = URL.createObjectURL(file);
    objectUrl.current = url;
    const next = new Image();
    next.onload = () => {
      // Centred, just covering the frame.
      const w = frameRef.current?.clientWidth ?? frameW, h = w / BANNER_ASPECT;
      const s = Math.max(w / next.naturalWidth, h / next.naturalHeight);
      setImg(next);
      setZoom(1);
      setOffset({ x: (w - next.naturalWidth * s) / 2, y: (h - next.naturalHeight * s) / 2 });
    };
    next.onerror = () => setError('That file couldn’t be read as an image.');
    next.src = url;
  };

  const zoomTo = (z: number) => {
    if (!img) return;
    const next = baseScale * z;
    // Keep the point at the frame's centre where it is.
    const cx = (frameW / 2 - offset.x) / scale, cy = (frameH / 2 - offset.y) / scale;
    setZoom(z);
    setOffset(clamp(frameW / 2 - cx * next, frameH / 2 - cy * next, next));
  };

  const save = async () => {
    if (!img || !frameW) return;
    const rect: CropRect = { sx: -offset.x / scale, sy: -offset.y / scale, sw: frameW / scale, sh: frameH / scale };
    setBusy(true);
    setError(null);
    try {
      onSaved(await uploadBanner(campaignId, await cropToBanner(img, rect)));
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'The banner couldn’t be uploaded.');
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 20 : 5;
    const d = ({ ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] } as Record<string, number[]>)[e.key];
    if (!d || !img) return;
    e.preventDefault();
    setOffset((o) => clamp(o.x + d[0], o.y + d[1]));
  };

  const picker = (label: string) => (
    <input type="file" accept={BANNER_INPUT_TYPES.join(',')} className="hs-sr-only" aria-label={label}
      onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
  );

  return (
    <GildedDialog title="The campaign's banner" onClose={onClose} wide>
      <div className="hs-form">
        <div
          ref={frameRef}
          className={img ? 'hs-crop' : 'hs-crop is-empty'}
          tabIndex={img ? 0 : -1}
          onKeyDown={onKey}
          aria-label={img ? 'Banner crop. Drag, or use the arrow keys, to move the image.' : undefined}
          onPointerDown={(e) => {
            if (!img) return;
            e.currentTarget.setPointerCapture?.(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d) setOffset(clamp(d.ox + e.clientX - d.x, d.oy + e.clientY - d.y));
          }}
          onPointerUp={() => { drag.current = null; }}
          onPointerCancel={() => { drag.current = null; }}
        >
          {img ? (
            <img
              src={img.src}
              alt=""
              draggable={false}
              style={{ width: img.naturalWidth * scale, height: img.naturalHeight * scale, transform: `translate(${offset.x}px, ${offset.y}px)` }}
            />
          ) : (
            <label className="hs-crop-pick"><span>Pick an image</span>{picker('Pick an image')}</label>
          )}
        </div>

        {img && (
          <div className="hs-crop-row">
            <label className="hs-zoom">
              <span>Zoom</span>
              <input type="range" min={1} max={4} step={0.01} value={zoom} aria-label="Zoom" onChange={(e) => zoomTo(Number(e.target.value))} />
            </label>
            <label className="hs-ghost hs-crop-again">Pick another image{picker('Pick another image')}</label>
          </div>
        )}

        <p className="hs-fine">
          It shows at 4:1 behind the campaign&rsquo;s card, and across the top of its page. Drag to choose what shows.
          JPEG, PNG or WebP; it&rsquo;s resized before it&rsquo;s uploaded.
        </p>
        {error && <p className="hs-alert" role="alert">{error}</p>}

        <div className="hs-actions">
          <button type="button" className="hs-btn-amber" disabled={!img || busy} onClick={save}>
            {busy ? 'Uploading…' : 'Save the banner'}
          </button>
          <button type="button" className="hs-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </GildedDialog>
  );
}
