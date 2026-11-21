/**
 * Campaign banners (#81), from Hearthside. The owner crops an image to 4:1 in
 * the browser; the backend hands out a presigned S3 PUT; the browser uploads
 * the crop straight to S3, then saves its key on the campaign. The same flow
 * as the portfolio's (frontend/src/lib/banner.ts), through Hearthside's API client.
 */
import { api } from './api';

/** Width : height of every banner. */
export const BANNER_ASPECT = 4;
/** The cropped banner is at most this wide (and a quarter of it tall). */
const BANNER_OUT_WIDTH = 1600;
/** What the server accepts; the crop is re-encoded to fit. */
const BANNER_MAX_BYTES = 5 * 1024 * 1024;
/** Image types the picker offers. The crop re-encodes to WebP (or JPEG). */
export const BANNER_INPUT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
/** The biggest source file the cropper will open (it's re-encoded far smaller). */
export const BANNER_SOURCE_MAX_BYTES = 25 * 1024 * 1024;

export interface Banner { bannerKey: string | null; bannerUrl: string | null }

/** A rectangle of the source image, in its natural pixels. */
export interface CropRect { sx: number; sy: number; sw: number; sh: number }

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/**
 * Draws `crop` of `img` onto a 4:1 canvas and encodes it: WebP where the
 * browser can, else JPEG, stepping the quality down until it fits in 5 MB.
 */
export async function cropToBanner(img: HTMLImageElement, crop: CropRect): Promise<Blob> {
    const width = Math.max(1, Math.round(Math.min(BANNER_OUT_WIDTH, crop.sw)));
    const height = Math.max(1, Math.round(width / BANNER_ASPECT));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser can’t crop images.');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);

    for (const quality of [0.85, 0.7, 0.5]) {
        let blob = await toBlob(canvas, 'image/webp', quality);
        // Browsers that can't encode WebP hand back a PNG instead.
        if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', quality);
        if (blob && blob.size <= BANNER_MAX_BYTES) return blob;
    }
    throw new Error('The cropped banner is still over 5 MB. Try a smaller image.');
}

/** Uploads a cropped banner to S3 and makes it the campaign's banner. */
export async function uploadBanner(campaignId: string, blob: Blob): Promise<Banner> {
    const put = await api.post<{ url: string; method: 'PUT'; headers: Record<string, string>; key: string }>(
        `/api/campaigns/${campaignId}/banner/upload-url`,
        { contentType: blob.type, size: blob.size },
    );
    // Straight to S3 with a plain fetch: the presigned URL is its own credential.
    const res = await fetch(put.url, { method: put.method, headers: put.headers, body: blob });
    if (!res.ok) throw new Error(`The upload to storage failed (${res.status}).`);
    return api.put<Banner>(`/api/campaigns/${campaignId}/banner`, { key: put.key });
}

export const removeBanner = (campaignId: string) =>
    api.delete<Banner>(`/api/campaigns/${campaignId}/banner`);
