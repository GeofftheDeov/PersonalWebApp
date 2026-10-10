/**
 * Campaign banners (#81, part of #57). A campaign owner (or an admin) gives the
 * campaign a ~4:1 banner image:
 *
 *   1. requestBannerUpload  checks the type and size, mints a fresh object key
 *                           under this campaign's prefix, and returns a
 *                           presigned PUT the browser uploads the cropped image to.
 *   2. setBanner            saves that key on the campaign (replacing any earlier
 *                           banner, whose object is then deleted).
 *   3. clearBanner          removes it.
 *
 * Reads go through `bannerUrlFor`, a CloudFront URL or a presigned GET; the
 * bucket is never public. S3 is reached only through integrations().uploads,
 * which Letters attachments and profile pictures will reuse.
 *
 * Keys are never taken from the client as-is: the server builds them as
 * `campaign-banners/<campaignId>/<uuid>.<ext>`, and setBanner accepts only a key
 * of exactly that shape for the same campaign. So an owner can't point their
 * banner at another campaign's object, at some other prefix, or at a path with
 * `..` in it, and no upload can overwrite an existing object.
 */
import crypto from "crypto";
import { query } from "../db/index.js";
import { bus } from "../events/index.js";
import { integrations, UploadsNotConfiguredError } from "../utils/integrations.js";
import { SettingsError, requireCampaignOwner } from "./campaignSettings.js";

/** The image types a banner may be, and the file extension each is stored under. */
export const BANNER_TYPES: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
};

/** 5 MB. */
export const BANNER_MAX_BYTES = 5 * 1024 * 1024;

/** How long the browser has to start the upload. */
const UPLOAD_URL_SECONDS = 300;

const PREFIX = "campaign-banners";
const KEY_RE = /^campaign-banners\/([0-9a-f-]{36})\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$/;

export interface BannerUpload {
    url: string;
    method: "PUT";
    headers: Record<string, string>;
    key: string;
    expiresAt: Date;
    maxBytes: number;
}

export interface Banner {
    bannerKey: string | null;
    bannerUrl: string | null;
}

function notConfigured(err: unknown): never {
    if (err instanceof UploadsNotConfiguredError) {
        throw new SettingsError(503, "Banner uploads aren't set up on this server yet.");
    }
    throw err;
}

/** A banner key minted for this campaign, or null. */
const isBannerKeyOf = (key: unknown, campaignId: string): key is string => {
    const m = typeof key === "string" ? KEY_RE.exec(key) : null;
    return !!m && m[1] === campaignId.toLowerCase();
};

/**
 * Where the browser can read a banner from, or null when there is none or it
 * can't be read right now (uploads switched off). Never throws: a listing
 * should still load without its pictures.
 */
export async function bannerUrlFor(key: string | null | undefined): Promise<string | null> {
    if (!key) return null;
    try {
        return (await integrations().uploads.readUrl({ key })).url;
    } catch {
        return null;
    }
}

/** A campaign as the API returns it, plus `bannerUrl`. */
export async function withBannerUrl<T extends { bannerKey?: string | null }>(campaign: T): Promise<T & { bannerUrl: string | null }> {
    return { ...campaign, bannerUrl: await bannerUrlFor(campaign.bannerKey) };
}

export async function requestBannerUpload(actorId: string, campaignId: string, body: any): Promise<BannerUpload> {
    const c = await requireCampaignOwner(actorId, campaignId);
    const contentType = typeof body?.contentType === "string" ? body.contentType.trim().toLowerCase() : "";
    const ext = BANNER_TYPES[contentType];
    if (!ext) throw new SettingsError(400, "A banner must be a JPEG, PNG or WebP image.");
    const size = body?.size;
    if (!Number.isInteger(size) || size < 1) throw new SettingsError(400, "Send the image's size in bytes.");
    if (size > BANNER_MAX_BYTES) throw new SettingsError(400, "A banner can be at most 5 MB.");

    const key = `${PREFIX}/${c.id}/${crypto.randomUUID()}.${ext}`;
    const put = await integrations().uploads
        .presignPut({ key, contentType, contentLength: size, expiresInSeconds: UPLOAD_URL_SECONDS })
        .catch(notConfigured);
    return { ...put, maxBytes: BANNER_MAX_BYTES };
}

async function saveBanner(campaign: any, key: string | null): Promise<Banner> {
    // Read the key being replaced under a row lock, in the same statement as the
    // write, so two saves at once each delete what they really replaced.
    const { rows: [row] } = await query(
        `UPDATE campaigns c SET banner_key = $2
           FROM (SELECT id, banner_key FROM campaigns WHERE id = $1 FOR UPDATE) old
          WHERE c.id = old.id
         RETURNING old.banner_key AS previous`,
        [campaign.id, key]);
    const previous: string | null = row?.previous ?? null;
    if (previous !== key) {
        bus.publish("campaign.changed", { campaignId: campaign.id, action: "updated" }).catch(() => { /* non-fatal */ });
        // The replaced image is no longer reachable from anywhere; tidy it up.
        // Best effort: a failure leaves an orphan object, not a broken banner.
        if (previous && isBannerKeyOf(previous, campaign.id)) {
            integrations().uploads.deleteObject(previous).catch((err) => {
                console.warn(`Could not delete the old banner ${previous}:`, err?.message ?? err);
            });
        }
    }
    return { bannerKey: key, bannerUrl: await bannerUrlFor(key) };
}

export async function setBanner(actorId: string, campaignId: string, body: any): Promise<Banner> {
    const c = await requireCampaignOwner(actorId, campaignId);
    const key = body?.key;
    if (!isBannerKeyOf(key, c.id)) {
        throw new SettingsError(400, "That isn't a banner uploaded for this campaign. Request an upload URL first.");
    }
    return saveBanner(c, key);
}

export async function clearBanner(actorId: string, campaignId: string): Promise<Banner> {
    const c = await requireCampaignOwner(actorId, campaignId);
    return saveBanner(c, null);
}
