import { OAuth2Client } from 'google-auth-library';

/**
 * Everything the app sends to or reads from an outside service for tabletop
 * sessions (#79): Discord scheduled events, Google Calendar events and
 * free/busy (#84), and S3 presigned uploads (for banners, #81).
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
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured');
    }

    const client = new OAuth2Client(clientId, clientSecret);
    client.setCredentials({ refresh_token: refreshToken });
    const { token } = await client.getAccessToken();
    if (!token) throw new Error('Failed to refresh Google access token');

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

export interface Integrations {
    discord: {
        createScheduledEvent(input: DiscordEventInput): Promise<{ id: string }>;
    };
    google: {
        /** Inserts on the primary calendar of whoever owns the refresh token. */
        createCalendarEvent(refreshToken: string, input: CalendarEventInput): Promise<{ id: string }>;
        /** Busy intervals on the token owner's primary calendar. Needs the calendar.freebusy scope. */
        freeBusy(refreshToken: string, input: FreeBusyInput): Promise<BusyInterval[]>;
    };
    uploads: {
        /** A URL the browser PUTs one object to directly. The caller checks type and size first. */
        presignPut(input: PresignPutInput): Promise<PresignedPut>;
    };
}

export const realIntegrations: Integrations = {
    discord: { createScheduledEvent: createDiscordScheduledEvent },
    google: {
        createCalendarEvent: createGoogleCalendarEvent,
        freeBusy: queryGoogleFreeBusy,
    },
    uploads: {
        // The bucket, its CORS rule, the task role's s3:PutObject grant and the
        // AWS SDK arrive with banners (#81). Until then nothing calls this.
        async presignPut() {
            throw new Error('S3 uploads are not configured yet');
        },
    },
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
