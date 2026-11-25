/**
 * Campaign banners (#81), from Hearthside. The owner crops an image to 4:1 in
 * the browser; the backend hands out a presigned S3 PUT; the browser uploads
 * the crop straight to S3, then saves its key on the campaign. The same flow
 * as the portfolio's (frontend/src/lib/banner.ts), through Hearthside's API client.
 */
import { api } from './api';
import { CROP_INPUT_TYPES, CROP_SOURCE_MAX_BYTES, cropImage, type CropRect } from './crop';

export type { CropRect };

/** Width : height of every banner. */
export const BANNER_ASPECT = 4;
/** The cropped banner is at most this wide (and a quarter of it tall). */
const BANNER_OUT_WIDTH = 1600;
/** What the server accepts; the crop is re-encoded to fit. */
const BANNER_MAX_BYTES = 5 * 1024 * 1024;
/** Image types the picker offers. The crop re-encodes to WebP (or JPEG). */
export const BANNER_INPUT_TYPES = CROP_INPUT_TYPES;
/** The biggest source file the cropper will open (it's re-encoded far smaller). */
export const BANNER_SOURCE_MAX_BYTES = CROP_SOURCE_MAX_BYTES;

export interface Banner { bannerKey: string | null; bannerUrl: string | null }

/** Draws `crop` of `img` onto a 4:1 canvas and encodes it to fit in 5 MB (lib/crop.ts). */
export const cropToBanner = (img: HTMLImageElement, crop: CropRect): Promise<Blob> =>
    cropImage(img, crop, { aspect: BANNER_ASPECT, maxWidth: BANNER_OUT_WIDTH, maxBytes: BANNER_MAX_BYTES });

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
