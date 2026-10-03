import { OAuth2Client } from 'google-auth-library';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Everything the app sends to or reads from an outside service for tabletop
 * sessions (#79): Discord scheduled events, Google Calendar events, and S3
 * presigned uploads (for banners, #81).
 *
 * Callers reach these services only through `integrations()`. They never call
 * Discord, Google or S3 themselves. Tests swap the whole module for a fake that
 * records every call (testing/fakeIntegrations.ts) using `installIntegrations`.
 * Production never installs anything, so it always gets `realIntegrations`.
 *
 * To add an outside call (e.g. Google free/busy, Discord "interested" users,
 * or updating an event when a night moves), add the method to `Integrations`,
 * implement it in `realIntegrations`, and give it a default in the fake. The
 * compiler points at each place that's missing.
 *
 * Discord scheduled events  — https://discord.com/developers/docs/resources/guild-scheduled-event
 *   Required: name, privacy_level, scheduled_start_time, entity_type.
 *   VOICE (2)    additionally requires channel_id.
 *   EXTERNAL (3) additionally requires entity_metadata.location AND scheduled_end_time.
 *
 * Google Calendar events    — https://developers.google.com/calendar/api/v3/reference/events/insert
 *   Required: start and end. We also send summary, description, location.
 *
 * S3 uploads (#81)          — one private bucket, reached with the AWS SDK v3.
 *   UPLOADS_BUCKET   the bucket; unset or empty means uploads are off ("not configured")
 *   UPLOADS_REGION   its region (else AWS_REGION, else us-east-2)
 *   UPLOADS_CDN_URL  optional CloudFront origin (e.g. https://dxxxx.cloudfront.net) in
 *                    front of the bucket; reads use it instead of a presigned GET
 *   Credentials come from the SDK's default chain: the ECS task role in AWS,
 *   AWS_ACCESS_KEY_ID / AWS_PROFILE locally. The bucket is never public.
 */

const DISCORD_API = 'https://discord.com/api/v10';

export interface DiscordEventInput {
    botToken: string;
    guildId: string;
    /** Voice channel — if provided, a VOICE event is created; otherwise EXTERNAL. */
    channelId?: string;
    name: string;
    description?: string;
    /** Required for EXTERNAL events (max 100 chars). */
    location?: string;
    start: Date;
    /** Required for EXTERNAL events. */
    end?: Date;
}

async function createDiscordScheduledEvent(input: DiscordEventInput): Promise<{ id: string }> {
    const isVoice = !!input.channelId;

    if (!isVoice && !input.location) {
        throw new Error('Discord external events require a location');
    }
    if (!isVoice && !input.end) {
        throw new Error('Discord external events require an end time');
    }
    if (input.start.getTime() <= Date.now()) {
        throw new Error('Discord events must start in the future');
    }

    const body: any = {
        name: input.name.slice(0, 100),
        privacy_level: 2, // GUILD_ONLY — the only supported value
        scheduled_start_time: input.start.toISOString(),
        entity_type: isVoice ? 2 : 3,
    };
    if (input.description) body.description = input.description.slice(0, 1000);
    if (input.end) body.scheduled_end_time = input.end.toISOString();
    if (isVoice) {
        body.channel_id = input.channelId;
    } else {
        body.entity_metadata = { location: (input.location as string).slice(0, 100) };
    }

    const res = await fetch(`${DISCORD_API}/guilds/${input.guildId}/scheduled-events`, {
        method: 'POST',
        headers: {
            'Authorization': `Bot ${input.botToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Discord API ${res.status}: ${detail.slice(0, 300)}`);
    }
    const data: any = await res.json();
    return { id: data.id };
}

export interface CalendarEventInput {
    title: string;
    description?: string;
    location?: string;
    start: Date;
    end: Date;
}

/** Format a date as Google Calendar's UTC stamp: YYYYMMDDTHHMMSSZ */
const gcalStamp = (d: Date) => d.toISOString().replace(/[-:]|\.\d{3}/g, '');

/**
 * Build a shareable "add to Google Calendar" template link.
 * No auth required — anyone who clicks it gets a pre-filled event form.
 */
export function buildGoogleCalendarLink(input: CalendarEventInput): string {
    const params = new URLSearchParams({
        action: 'TEMPLATE',
        text: input.title,
        dates: `${gcalStamp(input.start)}/${gcalStamp(input.end)}`,
    });
    if (input.description) params.set('details', input.description);
    if (input.location) params.set('location', input.location);
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * Create an event on the user's primary Google Calendar via the Calendar API.
 * Requires a refresh token previously obtained with calendar.events scope.
 */
async function createGoogleCalendarEvent(
    refreshToken: string,
    input: CalendarEventInput,
): Promise<{ id: string }> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured');
    }

    const client = new OAuth2Client(clientId, clientSecret);
    client.setCredentials({ refresh_token: refreshToken });
    const { token } = await client.getAccessToken();
    if (!token) throw new Error('Failed to refresh Google access token');

    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            summary: input.title,
            description: input.description || undefined,
            location: input.location || undefined,
            start: { dateTime: input.start.toISOString() },
            end: { dateTime: input.end.toISOString() },
        }),
    });

    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Google Calendar API ${res.status}: ${detail.slice(0, 300)}`);
    }
    const data: any = await res.json();
    return { id: data.id };
}

export interface PresignPutInput {
    /** Object key, built by the caller (e.g. `campaign-banners/<campaignId>/<uuid>.webp`). */
    key: string;
    /** Checked by the caller against what it accepts (banners: jpeg, png or webp). */
    contentType: string;
    /** Exact size in bytes, checked by the caller (banners: max 5 MB) and signed so the upload must match. */
    contentLength: number;
    /** How long the URL works. Default 300 seconds. */
    expiresInSeconds?: number;
}

export interface PresignedPut {
    url: string;
    method: 'PUT';
    /** Headers the browser must send with the PUT, exactly as given. */
    headers: Record<string, string>;
    key: string;
    expiresAt: Date;
}

export interface ReadUrlInput {
    key: string;
    /** How long a presigned GET works. Default 3600 seconds. Ignored behind CloudFront. */
    expiresInSeconds?: number;
}

export interface ReadUrl {
    url: string;
    /** When a presigned URL stops working; null for a CloudFront URL, which doesn't. */
    expiresAt: Date | null;
}

/** Uploads are switched off: no bucket is configured for this environment. */
export class UploadsNotConfiguredError extends Error {
    constructor() { super('S3 uploads are not configured yet (UPLOADS_BUCKET is unset)'); }
}

function uploadsConfig() {
    const bucket = process.env.UPLOADS_BUCKET?.trim();
    if (!bucket) throw new UploadsNotConfiguredError();
    const region = process.env.UPLOADS_REGION?.trim() || process.env.AWS_REGION?.trim() || 'us-east-2';
    const cdn = process.env.UPLOADS_CDN_URL?.trim().replace(/\/+$/, '') || null;
    return { bucket, region, cdn };
}

const s3Clients = new Map<string, S3Client>();
function s3(region: string): S3Client {
    let client = s3Clients.get(region);
    if (!client) {
        client = new S3Client({
            region,
            // Without these the SDK adds a CRC32 of the (empty) body to presigned
            // PUT URLs, and S3 then rejects the browser's real upload.
            requestChecksumCalculation: 'WHEN_REQUIRED',
            responseChecksumValidation: 'WHEN_REQUIRED',
        });
        s3Clients.set(region, client);
    }
    return client;
}

async function presignS3Put(input: PresignPutInput): Promise<PresignedPut> {
    const { bucket, region } = uploadsConfig();
    const expiresIn = input.expiresInSeconds ?? 300;
    const url = await getSignedUrl(
        s3(region),
        new PutObjectCommand({ Bucket: bucket, Key: input.key, ContentType: input.contentType, ContentLength: input.contentLength }),
        // Both headers are part of the signature, so S3 refuses an upload whose
        // type or byte count differs from what the caller checked.
        { expiresIn, signableHeaders: new Set(['content-type', 'content-length']) },
    );
    return {
        url,
        method: 'PUT',
        // The browser sets Content-Length itself from the body; it must match.
        headers: { 'Content-Type': input.contentType },
        key: input.key,
        expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
}

async function s3ReadUrl(input: ReadUrlInput): Promise<ReadUrl> {
    const { bucket, region, cdn } = uploadsConfig();
    if (cdn) return { url: `${cdn}/${input.key.split('/').map(encodeURIComponent).join('/')}`, expiresAt: null };
    const expiresIn = input.expiresInSeconds ?? 3600;
    const url = await getSignedUrl(s3(region), new GetObjectCommand({ Bucket: bucket, Key: input.key }), { expiresIn });
    return { url, expiresAt: new Date(Date.now() + expiresIn * 1000) };
}

async function s3DeleteObject(key: string): Promise<void> {
    const { bucket, region } = uploadsConfig();
    await s3(region).send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export interface Integrations {
    discord: {
        createScheduledEvent(input: DiscordEventInput): Promise<{ id: string }>;
    };
    google: {
        /** Inserts on the primary calendar of whoever owns the refresh token. */
        createCalendarEvent(refreshToken: string, input: CalendarEventInput): Promise<{ id: string }>;
    };
    uploads: {
        /** A URL the browser PUTs one object to directly. The caller checks type and size first. */
        presignPut(input: PresignPutInput): Promise<PresignedPut>;
        /** A URL that reads one object: through CloudFront when configured, else a presigned GET. */
        readUrl(input: ReadUrlInput): Promise<ReadUrl>;
        /** Remove an object (e.g. the banner a new one replaced). Missing objects are not an error. */
        deleteObject(key: string): Promise<void>;
    };
}

export const realIntegrations: Integrations = {
    discord: { createScheduledEvent: createDiscordScheduledEvent },
    google: { createCalendarEvent: createGoogleCalendarEvent },
    uploads: { presignPut: presignS3Put, readUrl: s3ReadUrl, deleteObject: s3DeleteObject },
};

let active: Integrations = realIntegrations;

/** The integrations in use: the real ones unless a test installed a fake. */
export function integrations(): Integrations {
    return active;
}

/** Swap in another implementation (tests only). Returns a function that puts the previous one back. */
export function installIntegrations(impl: Integrations): () => void {
    const previous = active;
    active = impl;
    return () => { active = previous; };
}
