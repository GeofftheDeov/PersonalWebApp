import { OAuth2Client } from 'google-auth-library';

/**
 * External event integrations for tabletop sessions.
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

export async function createDiscordScheduledEvent(input: DiscordEventInput): Promise<{ id: string }> {
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
export async function createGoogleCalendarEvent(
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
