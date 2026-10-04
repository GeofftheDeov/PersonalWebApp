/**
 * Where a confirmed session goes outside the app (#57): a Discord scheduled
 * event and a Google Calendar event. The planner reaches Discord and Google
 * only through this interface, so tests can hand it a fake. The real one
 * makes its calls through the integrations module (utils/integrations.ts), so
 * a test can instead install the integrations fake and see the raw calls.
 *
 * Credentials are the Game Master's, as they are for the one-off "add
 * session" form: the Discord bot token and the Google refresh token in their
 * API Key Vault. A session can have more than one Game Master (the campaign's,
 * plus a one-session stand-in), so the first one holding the key is used.
 */
import { getDecryptedKeys } from "../routes/apiKeyRoutes.js";
import { buildGoogleCalendarLink, integrations } from "../utils/integrations.js";

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

export interface RescheduleSessionInput extends PublishSessionInput {
    /** The events the session already has. Each is moved to the new time, or replaced if it can't be. */
    existing: { discordEventId: string | null; googleEventId: string | null };
    /**
     * Also create an event where the session has none -- what confirming the
     * night would have made (online sessions). In person, only events that
     * already exist are moved.
     */
    createMissing: boolean;
}

export interface WithdrawSessionInput {
    gmIds: string[];
    /** The campaign's Discord server, which a Discord event lives in. */
    discordGuildId: string | null;
    discordEventId: string | null;
    googleEventId: string | null;
}

export interface WithdrawnSession {
    discordRemoved: boolean;
    googleRemoved: boolean;
    warnings: string[];
}

export interface ExternalEvents {
    publishSession(input: PublishSessionInput): Promise<PublishedSession>;
    /**
     * A scheduled session's night moved (#87). The returned ids are the ones
     * the session should keep: the same when moved, the replacement when
     * replaced, the old one when neither worked (and a warning says so).
     */
    rescheduleSession(input: RescheduleSessionInput): Promise<PublishedSession>;
    /** The session isn't happening: remove its events. */
    withdrawSession(input: WithdrawSessionInput): Promise<WithdrawnSession>;
}

/** The first of these people (in order) whose API Key Vault holds a key for `provider`. */
export async function firstKey(gmIds: string[], provider: string) {
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

/**
 * Moves one service's event, or replaces it: when the move fails (the event
 * was deleted, or has started), a new event is made and the old one removed.
 * With no event yet, makes one if `createMissing`. Returns the id to keep.
 */
async function moveOrReplace(service: string, existingId: string | null, createMissing: boolean, warnings: string[], ops: {
    update: (id: string) => Promise<unknown>;
    create: () => Promise<{ id: string }>;
    remove: (id: string) => Promise<unknown>;
}): Promise<string | null> {
    if (!existingId) {
        if (!createMissing) return null;
        try {
            return (await ops.create()).id;
        } catch (err: any) {
            warnings.push(`${service} event failed: ${err.message}`);
            return null;
        }
    }
    try {
        await ops.update(existingId);
        return existingId;
    } catch (moveErr: any) {
        let replacement: string;
        try {
            replacement = (await ops.create()).id;
        } catch (err: any) {
            warnings.push(`${service} event couldn't be moved (${moveErr.message}) or replaced (${err.message}); it still shows the old time.`);
            return existingId;
        }
        try {
            await ops.remove(existingId);
        } catch (err: any) {
            warnings.push(`A new ${service} event was made for the new time, but the old one couldn't be removed: ${err.message}`);
        }
        return replacement;
    }
}

export const realExternalEvents: ExternalEvents = {
    async rescheduleSession(input) {
        const out: PublishedSession = {
            discordEventId: input.existing.discordEventId,
            googleEventId: input.existing.googleEventId,
            googleCalendarLink: buildGoogleCalendarLink({
                title: input.name, description: input.description, location: input.location,
                start: input.start, end: input.end,
            }),
            warnings: [],
        };
        const { start, end } = input;

        if (input.existing.discordEventId || (input.createMissing && input.discord)) {
            const keys = await firstKey(input.gmIds, "discord");
            if (!input.discord) {
                out.warnings.push("Discord event couldn't be moved: the campaign is no longer linked to a Discord server.");
            } else if (!keys) {
                out.warnings.push(input.existing.discordEventId
                    ? "Discord event couldn't be moved: no 'discord' bot token in the Game Master's API Key Vault."
                    : "Discord event skipped: no 'discord' bot token in the Game Master's API Key Vault.");
            } else {
                const ref = { botToken: keys.secret, guildId: input.discord.guildId };
                out.discordEventId = await moveOrReplace("Discord", input.existing.discordEventId, input.createMissing, out.warnings, {
                    update: (eventId) => integrations().discord.updateScheduledEvent({ ...ref, eventId, start, end }),
                    create: () => integrations().discord.createScheduledEvent({
                        ...ref, channelId: input.discord!.channelId,
                        name: input.name, description: input.description, location: input.location, start, end,
                    }),
                    remove: (eventId) => integrations().discord.deleteScheduledEvent({ ...ref, eventId }),
                });
            }
        }

        if (input.existing.googleEventId || input.createMissing) {
            const google = await firstKey(input.gmIds, "google_calendar");
            if (!google) {
                out.warnings.push(input.existing.googleEventId
                    ? "Google Calendar event couldn't be moved: Google Calendar isn't connected for the Game Master."
                    : "Google Calendar not connected for the Game Master: the shareable link was made, but no event was added.");
            } else {
                out.googleEventId = await moveOrReplace("Google Calendar", input.existing.googleEventId, input.createMissing, out.warnings, {
                    update: (eventId) => integrations().google.updateCalendarEvent(google.secret, eventId, { start, end }),
                    create: () => integrations().google.createCalendarEvent(google.secret, {
                        title: input.name, description: input.description, location: input.location, start, end,
                    }),
                    remove: (eventId) => integrations().google.deleteCalendarEvent(google.secret, eventId),
                });
            }
        }
        return out;
    },

    async withdrawSession(input) {
        const out: WithdrawnSession = { discordRemoved: false, googleRemoved: false, warnings: [] };
        if (input.discordEventId) {
            const keys = await firstKey(input.gmIds, "discord");
            if (!input.discordGuildId || !keys) {
                out.warnings.push("The Discord event couldn't be removed: " +
                    (!input.discordGuildId ? "the campaign is no longer linked to a Discord server." : "no 'discord' bot token in the Game Master's API Key Vault."));
            } else {
                try {
                    await integrations().discord.deleteScheduledEvent({
                        botToken: keys.secret, guildId: input.discordGuildId, eventId: input.discordEventId,
                    });
                    out.discordRemoved = true;
                } catch (err: any) {
                    out.warnings.push(`The Discord event couldn't be removed: ${err.message}`);
                }
            }
        }
        if (input.googleEventId) {
            const google = await firstKey(input.gmIds, "google_calendar");
            if (!google) {
                out.warnings.push("The Google Calendar event couldn't be removed: Google Calendar isn't connected for the Game Master.");
            } else {
                try {
                    await integrations().google.deleteCalendarEvent(google.secret, input.googleEventId);
                    out.googleRemoved = true;
                } catch (err: any) {
                    out.warnings.push(`The Google Calendar event couldn't be removed: ${err.message}`);
                }
            }
        }
        return out;
    },

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
                    const ev = await integrations().discord.createScheduledEvent({
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
                const ev = await integrations().google.createCalendarEvent(google.secret, {
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
