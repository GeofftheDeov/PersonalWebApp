"use client";

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ImagePlus, Trash2, Upload, X, ZoomIn } from 'lucide-react';
import {
    BANNER_ASPECT, BANNER_INPUT_TYPES, BANNER_SOURCE_MAX_BYTES,
    type Banner, type CropRect, cropToBanner, removeBanner, uploadBanner,
} from '@/lib/banner';

/**
 * The owner's banner editor (#81): pick an image, drag and zoom it inside a
 * 4:1 frame, then upload the crop. The server re-checks that the caller owns
 * the campaign; this only appears for owners (and admins).
 */
export default function BannerEditor({ campaignId, hasBanner, onClose, onSaved }: {
    campaignId: string;
    hasBanner: boolean;
    onClose: () => void;
    onSaved: (banner: Banner) => void;
}) {
    const [img, setImg] = useState<HTMLImageElement | null>(null);
    const [zoom, setZoom] = useState(1);
    // Offset of the image's top-left corner from the frame's, in frame pixels.
    const [offset, setOffset] = useState({ x: 0, y: 0 });
    const [frameW, setFrameW] = useState(0);
    const [busy, setBusy] = useState<null | 'upload' | 'remove'>(null);
    const [error, setError] = useState<string | null>(null);
    const frameRef = useRef<HTMLDivElement>(null);
    const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
    const objectUrl = useRef<string | null>(null);

    const frameH = frameW / BANNER_ASPECT;
    // Cover the frame at zoom 1; zooming in scales from there.
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
    useEffect(() => { setOffset(o => clamp(o.x, o.y)); }, [clamp]);

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
            setImg(next);
            setZoom(1);
            // Centre it.
            const s = Math.max(frameW / next.naturalWidth, frameH / next.naturalHeight);
            setOffset({ x: (frameW - next.naturalWidth * s) / 2, y: (frameH - next.naturalHeight * s) / 2 });
        };
        next.onerror = () => setError('That file could not be read as an image.');
        next.src = url;
    };

    const setZoomAroundCentre = (z: number) => {
        if (!img) return;
        const next = baseScale * z;
        // Keep the point at the frame's centre where it is.
        const cx = (frameW / 2 - offset.x) / scale, cy = (frameH / 2 - offset.y) / scale;
        setZoom(z);
        setOffset(clamp(frameW / 2 - cx * next, frameH / 2 - cy * next, next));
    };

    const crop = (): CropRect | null => img && {
        sx: -offset.x / scale, sy: -offset.y / scale, sw: frameW / scale, sh: frameH / scale,
    };

    const save = async () => {
        const rect = crop();
        if (!img || !rect) return;
        setBusy('upload');
        setError(null);
        try {
            const blob = await cropToBanner(img, rect);
            onSaved(await uploadBanner(campaignId, blob, localStorage.getItem('token') || ''));
        } catch (e: any) {
            setError(e?.message || 'The banner could not be uploaded.');
        } finally {
            setBusy(null);
        }
    };

    const remove = async () => {
        setBusy('remove');
        setError(null);
        try {
            onSaved(await removeBanner(campaignId, localStorage.getItem('token') || ''));
        } catch (e: any) {
            setError(e?.message || 'The banner could not be removed.');
        } finally {
            setBusy(null);
        }
    };

    const onKey = (e: React.KeyboardEvent) => {
        const step = e.shiftKey ? 20 : 5;
        const d = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
        if (!d || !img) return;
        e.preventDefault();
        setOffset(o => clamp(o.x + d[0], o.y + d[1]));
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-labelledby="banner-editor-title">
            <div className="w-full max-w-2xl bg-slate-900 border-4 border-black shadow-[10px_10px_0px_0px_rgba(13,148,136,1)] p-6 sm:p-8 overflow-y-auto max-h-[90vh]">
                <div className="flex justify-between items-center mb-4">
                    <h2 id="banner-editor-title" className="font-permanent text-2xl text-white uppercase flex items-center gap-2">
                        <ImagePlus className="w-6 h-6 text-teal-400" /> Campaign Banner
                    </h2>
                    <button type="button" onClick={onClose} aria-label="Close" className="p-1 text-zinc-400 hover:text-white transition-colors"><X className="w-6 h-6" /></button>
                </div>

                <div
                    ref={frameRef}
                    tabIndex={img ? 0 : -1}
                    onKeyDown={onKey}
                    aria-label={img ? 'Banner crop. Drag, or use the arrow keys, to move the image.' : undefined}
                    className={`relative w-full aspect-[4/1] overflow-hidden border-4 border-black bg-slate-800 touch-none select-none ${img ? 'cursor-move' : ''}`}
                    onPointerDown={e => {
                        if (!img) return;
                        (e.target as Element).setPointerCapture?.(e.pointerId);
                        drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
                    }}
                    onPointerMove={e => {
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
                            className="absolute top-0 left-0 max-w-none pointer-events-none"
                            style={{ width: img.naturalWidth * scale, height: img.naturalHeight * scale, transform: `translate(${offset.x}px, ${offset.y}px)` }}
                        />
                    ) : (
                        <label className="absolute inset-0 flex flex-col items-center justify-center gap-2 cursor-pointer text-zinc-400 hover:text-white">
                            <Upload className="w-8 h-8" />
                            <span className="font-permanent text-sm uppercase">Pick an image</span>
                            <input type="file" accept={BANNER_INPUT_TYPES.join(',')} className="sr-only" onChange={e => pick(e.target.files?.[0])} />
                        </label>
                    )}
                </div>

                {img && (
                    <div className="mt-4 flex flex-wrap items-center gap-4">
                        <label className="flex items-center gap-2 flex-1 min-w-[12rem]">
                            <ZoomIn className="w-4 h-4 text-teal-400 shrink-0" />
                            <span className="sr-only">Zoom</span>
                            <input type="range" min={1} max={4} step={0.01} value={zoom} onChange={e => setZoomAroundCentre(Number(e.target.value))} className="w-full accent-teal-500" />
                        </label>
                        <label className="font-permanent text-xs text-teal-400 uppercase underline cursor-pointer">
                            Pick another
                            <input type="file" accept={BANNER_INPUT_TYPES.join(',')} className="sr-only" onChange={e => pick(e.target.files?.[0])} />
                        </label>
                    </div>
                )}

                <p className="text-[10px] text-zinc-500 mt-3 font-permanent uppercase leading-relaxed">
                    Banners are wide (4 : 1). Drag the image to choose what shows, and zoom to fit. JPEG, PNG or WebP; it&apos;s resized before upload.
                </p>
                {error && <p role="alert" className="mt-3 font-permanent text-xs text-red-400 uppercase">{error}</p>}

                <div className="flex flex-wrap gap-3 mt-6">
                    <button type="button" disabled={!img || !!busy} onClick={save}
                        className="flex-1 flex items-center justify-center gap-2 p-3 border-4 border-black bg-teal-600 text-white font-permanent uppercase hover:bg-teal-500 transition-colors shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] disabled:opacity-50 disabled:cursor-not-allowed">
                        <Upload className="w-4 h-4" /> {busy === 'upload' ? 'UPLOADING...' : 'SAVE BANNER'}
                    </button>
                    {hasBanner && (
                        <button type="button" disabled={!!busy} onClick={remove}
                            className="flex items-center justify-center gap-2 px-4 p-3 border-4 border-black bg-red-600 text-white font-permanent uppercase hover:bg-red-500 transition-colors disabled:opacity-50">
                            <Trash2 className="w-4 h-4" /> {busy === 'remove' ? 'REMOVING...' : 'REMOVE'}
                        </button>
                    )}
                    <button type="button" onClick={onClose} className="px-6 p-3 border-4 border-black bg-zinc-700 text-white font-permanent uppercase hover:bg-zinc-600 transition-colors">CANCEL</button>
                </div>
            </div>
        </div>
    );
}
