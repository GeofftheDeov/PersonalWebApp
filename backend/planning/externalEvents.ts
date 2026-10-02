/**
 * Where a confirmed session goes outside the app (#57): a Discord scheduled
 * event and a Google Calendar event. The planner reaches Discord and Google
 * only through this interface, so tests hand it a fake that records calls.
 *
 * Credentials are the Game Master's, as they are for the one-off "add
 * session" form: the Discord bot token and the Google refresh token in their
 * API Key Vault. A session can have more than one Game Master (the campaign's,
 * plus a one-session stand-in), so the first one holding the key is used.
 */
import { getDecryptedKeys } from "../routes/apiKeyRoutes.js";
import { buildGoogleCalendarLink, createDiscordScheduledEvent, createGoogleCalendarEvent } from "../utils/integrations.js";

export interface PublishSessionInput {
    /** Whose vault to use, in order of preference. */
    gmIds: string[];
    name: string;
    description?: string;
    /** Where to show up: the table link, a venue, or "Online". */
    location: string;
    start: Date;
    end: Date;
    /** Set when the campaign is linked to a Discord server. */
    discord?: { guildId: string; channelId?: string };
}

export interface PublishedSession {
    discordEventId: string | null;
    googleEventId: string | null;
    /** Always built: an "add to Google Calendar" link that works for anyone. */
    googleCalendarLink: string;
    /** Why an event wasn't created, worded for the Game Master. */
    warnings: string[];
}

export interface ExternalEvents {
    publishSession(input: PublishSessionInput): Promise<PublishedSession>;
}

async function firstKey(gmIds: string[], provider: string) {
    for (const id of gmIds) {
        try {
            const keys = await getDecryptedKeys(id, provider);
            if (keys) return keys;
        } catch (err: any) {
            console.error(`[planning] reading ${provider} key failed:`, err.message);
        }
    }
    return null;
}

export const realExternalEvents: ExternalEvents = {
    async publishSession(input) {
        const out: PublishedSession = {
            discordEventId: null,
            googleEventId: null,
            googleCalendarLink: buildGoogleCalendarLink({
                title: input.name, description: input.description, location: input.location,
                start: input.start, end: input.end,
            }),
            warnings: [],
        };

        if (input.discord) {
            const keys = await firstKey(input.gmIds, "discord");
            if (!keys) {
                out.warnings.push("Discord event skipped: no 'discord' bot token in the Game Master's API Key Vault.");
            } else {
                try {
                    const ev = await createDiscordScheduledEvent({
                        botToken: keys.secret, guildId: input.discord.guildId, channelId: input.discord.channelId,
                        name: input.name, description: input.description, location: input.location,
                        start: input.start, end: input.end,
                    });
                    out.discordEventId = ev.id;
                } catch (err: any) {
                    out.warnings.push(`Discord event failed: ${err.message}`);
                }
            }
        }

        const google = await firstKey(input.gmIds, "google_calendar");
        if (!google) {
            out.warnings.push("Google Calendar not connected for the Game Master: the shareable link was made, but no event was added.");
        } else {
            try {
                const ev = await createGoogleCalendarEvent(google.secret, {
                    title: input.name, description: input.description, location: input.location,
                    start: input.start, end: input.end,
                });
                out.googleEventId = ev.id;
            } catch (err: any) {
                out.warnings.push(`Google Calendar event failed: ${err.message}`);
            }
        }
        return out;
    },
};
