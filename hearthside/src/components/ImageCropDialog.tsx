"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import GildedDialog from '@/components/GildedDialog';
import { CROP_INPUT_TYPES, CROP_SOURCE_MAX_BYTES, type CropRect } from '@/lib/crop';

/**
 * A cropper in a gilded dialog: pick an image, drag and zoom it inside a
 * frame of `aspect` (width : height), then hand the crop to `save`, which
 * crops, encodes and uploads it. Campaign banners (#81, 4:1) and an
 * adventurer's art (#273, 3:4) use it.
 */
export default function ImageCropDialog<T>({ title, aspect, portrait = false, hint, label, saveLabel, failure, save: upload, onClose, onSaved }: {
  title: string;
  /** Width : height of the frame and the crop. */
  aspect: number;
  /** A tall frame, kept narrow so it fits the dialog. */
  portrait?: boolean;
  /** Under the frame: where it shows and what it takes. */
  hint: string;
  /** The frame's accessible name, e.g. "Banner crop". */
  label: string;
  saveLabel: string;
  /** Said when `save` fails without a message of its own. */
  failure: string;
  /** Crops `crop` of `img`, uploads it and saves it. */
  save: (img: HTMLImageElement, crop: CropRect) => Promise<T>;
  onClose: () => void;
  onSaved: (saved: T) => void;
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

  const frameH = frameW / aspect;
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
    if (!CROP_INPUT_TYPES.includes(file.type)) { setError('Pick a JPEG, PNG or WebP image.'); return; }
    if (file.size > CROP_SOURCE_MAX_BYTES) { setError('That image is over 25 MB. Pick a smaller one.'); return; }
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    const url = URL.createObjectURL(file);
    objectUrl.current = url;
    const next = new Image();
    next.onload = () => {
      // Centred, just covering the frame.
      const w = frameRef.current?.clientWidth ?? frameW, h = w / aspect;
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
      onSaved(await upload(img, rect));
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : failure);
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
    <input type="file" accept={CROP_INPUT_TYPES.join(',')} className="hs-sr-only" aria-label={label}
      onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
  );

  return (
    <GildedDialog title={title} onClose={onClose} wide={!portrait}>
      <div className="hs-form">
        <div
          ref={frameRef}
          className={['hs-crop', img ? '' : 'is-empty', portrait ? 'is-portrait' : ''].filter(Boolean).join(' ')}
          style={{ aspectRatio: String(aspect) }}
          tabIndex={img ? 0 : -1}
          onKeyDown={onKey}
          aria-label={img ? `${label}. Drag, or use the arrow keys, to move the image.` : undefined}
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

        <p className="hs-fine">{hint}</p>
        {error && <p className="hs-alert" role="alert">{error}</p>}

        <div className="hs-actions">
          <button type="button" className="hs-btn-amber" disabled={!img || busy} onClick={save}>
            {busy ? 'Uploading…' : saveLabel}
          </button>
          <button type="button" className="hs-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </GildedDialog>
  );
}
