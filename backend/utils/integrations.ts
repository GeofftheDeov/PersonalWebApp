import { OAuth2Client } from 'google-auth-library';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Everything the app sends to or reads from an outside service for tabletop
 * sessions (#79): Discord scheduled events and who is "interested" in them
 * (#85), Google Calendar events and free/busy (#84), and S3 presigned uploads
 * (for banners, #81).
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
 * Moving a session's night (#87) PATCHes both kinds of event with only the
 * changed fields, and cancelling one DELETEs them. A delete of an event
 * that's already gone succeeds.
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

export interface DiscordEventRef {
    botToken: string;
    guildId: string;
    eventId: string;
}

/** Only the fields given are changed. */
export interface DiscordEventChanges extends DiscordEventRef {
    name?: string;
    description?: string;
    location?: string;
    start?: Date;
    end?: Date;
}

async function discordEventRequest(method: 'PATCH' | 'DELETE', ref: DiscordEventRef, body?: unknown): Promise<Response> {
    const res = await fetch(`${DISCORD_API}/guilds/${ref.guildId}/scheduled-events/${ref.eventId}`, {
        method,
        headers: {
            'Authorization': `Bot ${ref.botToken}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Discord API ${res.status}: ${detail.slice(0, 300)}`);
    }
    return res;
}

/** Moves or edits a scheduled event (e.g. when a session's night changes, #87). */
async function updateDiscordScheduledEvent(input: DiscordEventChanges): Promise<{ id: string }> {
    if (input.start && input.start.getTime() <= Date.now()) {
        throw new Error('Discord events must start in the future');
    }
    const body: any = {};
    if (input.name !== undefined) body.name = input.name.slice(0, 100);
    if (input.description !== undefined) body.description = input.description.slice(0, 1000);
    if (input.location !== undefined) body.entity_metadata = { location: input.location.slice(0, 100) };
    if (input.start) body.scheduled_start_time = input.start.toISOString();
    if (input.end) body.scheduled_end_time = input.end.toISOString();
    const data: any = await (await discordEventRequest('PATCH', input, body)).json();
    return { id: data.id };
}

/** Removes a scheduled event. One that's already gone counts as removed. */
async function deleteDiscordScheduledEvent(ref: DiscordEventRef): Promise<void> {
    try {
        await discordEventRequest('DELETE', ref);
    } catch (err: any) {
        if (!/^Discord API 404\b/.test(err.message)) throw err;
    }
}

/**
 * A failed Discord REST call. `status` is the HTTP status; `code` is Discord's
 * JSON error code when it sent one (e.g. 50001 Missing Access, 10004 Unknown
 * Guild), so callers can tell "the bot isn't in that server" from an outage.
 */
export class DiscordApiError extends Error {
    constructor(public status: number, public code: number | null, detail: string) {
        super(`Discord API ${status}: ${detail.slice(0, 300)}`);
        this.name = 'DiscordApiError';
    }
}

/** One of a guild's scheduled events, cut down to what busy time needs. The name is never copied. */
export interface DiscordScheduledEventTimes {
    id: string;
    start: Date;
    /** Discord leaves this empty for voice and stage events that set no end. */
    end: Date | null;
    /** 1 scheduled, 2 active, 3 completed, 4 canceled. */
    status: number;
}

/** Longest a Discord read waits out one rate-limit window before giving up. */
const DISCORD_MAX_RATE_WAIT_MS = 5_000;
/** Interested users come 100 to a page; past this many pages the rest are ignored. */
const DISCORD_MAX_USER_PAGES = 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET from Discord's REST API as the bot, minding its rate limits
 * (https://discord.com/developers/docs/topics/rate-limits):
 *   - a 429 is retried once after its retry_after, if that is short;
 *   - when a response says the bucket is now empty (X-RateLimit-Remaining: 0),
 *     it waits out X-RateLimit-Reset-After before returning, so the next call
 *     in the same bucket isn't refused.
 */
async function discordGet(botToken: string, path: string): Promise<any> {
    for (let attempt = 0; ; attempt++) {
        const res = await fetch(`${DISCORD_API}${path}`, {
            headers: { 'Authorization': `Bot ${botToken}` },
            signal: AbortSignal.timeout(10_000),
        });
        const text = await res.text().catch(() => '');
        let body: any = null;
        try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }

        if (res.status === 429) {
            const waitMs = Math.ceil(Number(body?.retry_after ?? res.headers.get('retry-after') ?? 60) * 1000);
            if (attempt === 0 && waitMs <= DISCORD_MAX_RATE_WAIT_MS) { await sleep(waitMs); continue; }
            throw new DiscordApiError(429, null, 'rate limited');
        }
        if (!res.ok) throw new DiscordApiError(res.status, typeof body?.code === 'number' ? body.code : null, text);

        if (res.headers.get('x-ratelimit-remaining') === '0') {
            const resetMs = Math.ceil(Number(res.headers.get('x-ratelimit-reset-after') ?? 0) * 1000);
            if (resetMs > 0) await sleep(Math.min(resetMs, DISCORD_MAX_RATE_WAIT_MS));
        }
        return body;
    }
}

/**
 * The guild's scheduled events (scheduled and active ones). One call: this
 * route isn't paginated.
 *   https://discord.com/developers/docs/resources/guild-scheduled-event#list-scheduled-events-for-guild
 */
async function listDiscordScheduledEvents(botToken: string, guildId: string): Promise<DiscordScheduledEventTimes[]> {
    const data = await discordGet(botToken, `/guilds/${encodeURIComponent(guildId)}/scheduled-events`);
    // Copy only the id, times and status: names and descriptions never enter the app.
    return (Array.isArray(data) ? data : []).map((e: any) => ({
        id: String(e.id),
        start: new Date(e.scheduled_start_time),
        end: e.scheduled_end_time ? new Date(e.scheduled_end_time) : null,
        status: Number(e.status),
    }));
}

/**
 * The Discord user ids of everyone marked "interested" in one scheduled
 * event, 100 per page, paged with `after` (Discord returns them in user-id
 * order when `after` is given).
 *   https://discord.com/developers/docs/resources/guild-scheduled-event#get-guild-scheduled-event-users
 */
async function listDiscordInterestedUsers(botToken: string, guildId: string, eventId: string): Promise<string[]> {
    const ids: string[] = [];
    let after = '0';
    for (let page = 0; page < DISCORD_MAX_USER_PAGES; page++) {
        const data = await discordGet(botToken,
            `/guilds/${encodeURIComponent(guildId)}/scheduled-events/${encodeURIComponent(eventId)}/users?limit=100&after=${after}`);
        // Only the user id is kept: no names, avatars or member data.
        const batch: string[] = (Array.isArray(data) ? data : []).map((u: any) => String(u?.user?.id ?? '')).filter(Boolean);
        ids.push(...batch);
        if (batch.length < 100) break;
        after = batch[batch.length - 1];
    }
    return ids;
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

async function googleAccessToken(refreshToken: string): Promise<string> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured');
    }
    const client = new OAuth2Client(clientId, clientSecret);
    client.setCredentials({ refresh_token: refreshToken });
    const { token } = await client.getAccessToken();
    if (!token) throw new Error('Failed to refresh Google access token');
    return token;
}

async function googleEventRequest(method: 'PATCH' | 'DELETE', refreshToken: string, eventId: string, body?: unknown): Promise<Response> {
    const token = await googleAccessToken(refreshToken);
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
        method,
        headers: {
            'Authorization': `Bearer ${token}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Google Calendar API ${res.status}: ${detail.slice(0, 300)}`);
    }
    return res;
}

/** Moves or edits an event on the refresh token owner's primary calendar. Only the fields given change. */
async function updateGoogleCalendarEvent(
    refreshToken: string,
    eventId: string,
    changes: Partial<CalendarEventInput>,
): Promise<{ id: string }> {
    const body: any = {};
    if (changes.title !== undefined) body.summary = changes.title;
    if (changes.description !== undefined) body.description = changes.description;
    if (changes.location !== undefined) body.location = changes.location;
    if (changes.start) body.start = { dateTime: changes.start.toISOString() };
    if (changes.end) body.end = { dateTime: changes.end.toISOString() };
    const data: any = await (await googleEventRequest('PATCH', refreshToken, eventId, body)).json();
    // A deleted event is kept, as "cancelled", and can still be patched: moving
    // it would show nothing on anyone's calendar, so report it as gone.
    if (data.status === 'cancelled') throw new Error('Google Calendar event was deleted');
    return { id: data.id };
}

/** Removes an event. One that's already gone (404, or 410 once deleted) counts as removed. */
async function deleteGoogleCalendarEvent(refreshToken: string, eventId: string): Promise<void> {
    try {
        await googleEventRequest('DELETE', refreshToken, eventId);
    } catch (err: any) {
        if (!/^Google Calendar API (404|410)\b/.test(err.message)) throw err;
    }
}

export interface FreeBusyInput {
    start: Date;
    end: Date;
}

/** One stretch of busy time. Google's free/busy answer has no titles, ids or anything else. */
export interface BusyInterval {
    start: Date;
    end: Date;
}

/**
 * When the owner of the refresh token is busy on their primary Google
 * Calendar (#84). freeBusy.query returns bare busy intervals: no titles, no
 * event ids. It does NOT accept the calendar.events scope; the token needs
 * calendar.freebusy (or calendar.readonly / calendar / calendar.events.freebusy).
 *   https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query
 * Google refuses one query longer than about three months (timeRangeTooLong);
 * callers ask for at most ~64 days.
 */
async function queryGoogleFreeBusy(refreshToken: string, input: FreeBusyInput): Promise<BusyInterval[]> {
    const token = await googleAccessToken(refreshToken);
    const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            timeMin: input.start.toISOString(),
            timeMax: input.end.toISOString(),
            items: [{ id: 'primary' }],
        }),
        signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Google Calendar API ${res.status}: ${detail.slice(0, 300)}`);
    }
    const data: any = await res.json();
    const primary = data?.calendars?.primary;
    if (!primary) throw new Error('Google Calendar API: no free/busy answer for the primary calendar');
    if (Array.isArray(primary.errors) && primary.errors.length) {
        throw new Error(`Google Calendar API: ${primary.errors.map((e: any) => e?.reason).join(', ')}`);
    }
    // Copy only the two times: nothing else Google sends is kept.
    return (Array.isArray(primary.busy) ? primary.busy : []).map((b: any) => ({
        start: new Date(b.start),
        end: new Date(b.end),
    }));
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
        /** Changes only the fields given. Throws if the event is gone or has already started. */
        updateScheduledEvent(input: DiscordEventChanges): Promise<{ id: string }>;
        /** An event that's already gone counts as deleted. */
        deleteScheduledEvent(ref: DiscordEventRef): Promise<void>;
        /** The guild's scheduled and active events: ids, times and status only. Throws DiscordApiError. */
        listScheduledEvents(botToken: string, guildId: string): Promise<DiscordScheduledEventTimes[]>;
        /** Discord user ids marked "interested" in one event, every page. Throws DiscordApiError. */
        listInterestedUsers(botToken: string, guildId: string, eventId: string): Promise<string[]>;
    };
    google: {
        /** Inserts on the primary calendar of whoever owns the refresh token. */
        createCalendarEvent(refreshToken: string, input: CalendarEventInput): Promise<{ id: string }>;
        /** Changes only the fields given, on the token owner's primary calendar. */
        updateCalendarEvent(refreshToken: string, eventId: string, changes: Partial<CalendarEventInput>): Promise<{ id: string }>;
        /** An event that's already gone counts as deleted. */
        deleteCalendarEvent(refreshToken: string, eventId: string): Promise<void>;
        /** Busy intervals on the token owner's primary calendar. Needs the calendar.freebusy scope. */
        freeBusy(refreshToken: string, input: FreeBusyInput): Promise<BusyInterval[]>;
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
    discord: {
        createScheduledEvent: createDiscordScheduledEvent,
        updateScheduledEvent: updateDiscordScheduledEvent,
        deleteScheduledEvent: deleteDiscordScheduledEvent,
        listScheduledEvents: listDiscordScheduledEvents,
        listInterestedUsers: listDiscordInterestedUsers,
    },
    google: {
        createCalendarEvent: createGoogleCalendarEvent,
        updateCalendarEvent: updateGoogleCalendarEvent,
        deleteCalendarEvent: deleteGoogleCalendarEvent,
        freeBusy: queryGoogleFreeBusy,
    },
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
