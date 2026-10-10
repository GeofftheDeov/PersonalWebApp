/**
 * Campaign banners (#81). The owner crops an image to 4:1 in the browser, the
 * backend hands out a presigned S3 PUT, the browser uploads the cropped image
 * straight to S3, and then saves the object key on the campaign.
 */

/** Width : height of every banner. */
export const BANNER_ASPECT = 4;
/** The cropped banner is at most this wide (and a quarter of it tall). */
const BANNER_OUT_WIDTH = 1600;
/** What the server accepts; the cropped image is re-encoded to fit. */
export const BANNER_MAX_BYTES = 5 * 1024 * 1024;
/** Image types the picker offers. The crop re-encodes to WebP (or JPEG). */
export const BANNER_INPUT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
/** Biggest source file the cropper will open (it's re-encoded far smaller). */
export const BANNER_SOURCE_MAX_BYTES = 25 * 1024 * 1024;

export interface Banner { bannerKey: string | null; bannerUrl: string | null }

/** A rectangle of the source image, in its natural pixels. */
export interface CropRect { sx: number; sy: number; sw: number; sh: number }

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number) =>
    new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, quality));

/**
 * Draw `crop` of `img` onto a 4:1 canvas and encode it: WebP where the browser
 * can, else JPEG, stepping the quality down until it fits in 5 MB.
 */
export async function cropToBanner(img: HTMLImageElement, crop: CropRect): Promise<Blob> {
    const width = Math.max(1, Math.round(Math.min(BANNER_OUT_WIDTH, crop.sw)));
    const height = Math.max(1, Math.round(width / BANNER_ASPECT));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot crop images.');
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

async function api<T>(path: string, init: RequestInit, token: string): Promise<T> {
    const res = await fetch(path, {
        ...init,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body as T;
}

/** Upload a cropped banner to S3 and make it the campaign's banner. */
export async function uploadBanner(campaignId: string, blob: Blob, token: string): Promise<Banner> {
    const put = await api<{ url: string; method: 'PUT'; headers: Record<string, string>; key: string }>(
        `/api/campaigns/${campaignId}/banner/upload-url`,
        { method: 'POST', body: JSON.stringify({ contentType: blob.type, size: blob.size }) },
        token,
    );
    const res = await fetch(put.url, { method: put.method, headers: put.headers, body: blob });
    if (!res.ok) throw new Error(`The upload to storage failed (${res.status}).`);
    return api<Banner>(`/api/campaigns/${campaignId}/banner`, { method: 'PUT', body: JSON.stringify({ key: put.key }) }, token);
}

export const removeBanner = (campaignId: string, token: string) =>
    api<Banner>(`/api/campaigns/${campaignId}/banner`, { method: 'DELETE' }, token);

/** A stable pick from a few on-palette gradients, so each campaign keeps its own fallback. */
export function fallbackBannerStyle(seed: string): { background: string } {
    const palettes = [
        ['#0d9488', '#134e4a'], // teal
        ['#facc15', '#ca8a04'], // yellow
        ['#334155', '#0f172a'], // slate
        ['#14b8a6', '#facc15'], // teal → yellow
        ['#1e293b', '#0d9488'], // night → teal
    ];
    let h = 0;
    for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const [a, b] = palettes[h % palettes.length];
    return {
        background: `repeating-linear-gradient(135deg, rgba(0,0,0,0.12) 0 2px, transparent 2px 14px), linear-gradient(120deg, ${a}, ${b})`,
    };
}
