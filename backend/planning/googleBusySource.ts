/**
 * Google Calendar as a busy source (#84). Reads free/busy on the person's own
 * primary calendar with their own Google connection, through the integrations
 * module. Free/busy answers are bare intervals, so no title is ever fetched,
 * let alone stored.
 */
import { integrations } from "../utils/integrations.js";
import { loadGoogleGrant } from "../utils/googleCalendarGrant.js";
import type { BusySourceAdapter } from "./busySources.js";

const NOT_CONNECTED = "Connect Google Calendar first.";
const RECONSENT = "Reconnect Google Calendar and allow it to see when you're busy (Google asks once more).";

const configured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

/** Google's error, reworded for the person whose calendar it is. */
function explain(err: any): string {
    const message = String(err?.message ?? "");
    if (/invalid_grant|\b401\b/.test(message)) return "Google no longer accepts this connection. Reconnect Google Calendar.";
    if (/\b403\b|insufficient/i.test(message)) return RECONSENT;
    if (/timeout|aborted/i.test(message)) return "Google Calendar took too long to answer.";
    return `Google Calendar couldn't be read (${message.slice(0, 160) || "no reason given"}).`;
}

export const googleBusySource: BusySourceAdapter = {
    name: "google",

    async connection(personId) {
        const grant = await loadGoogleGrant(personId);
        if (!grant) {
            return {
                connected: false, ready: false, needsReconsent: false,
                problem: configured() ? NOT_CONNECTED : "Google Calendar isn't set up on this server.",
            };
        }
        if (!grant.canReadFreeBusy) return { connected: true, ready: false, needsReconsent: true, problem: RECONSENT };
        return { connected: true, ready: true, needsReconsent: false, problem: null };
    },

    async fetchBusy(personId, range) {
        const grant = await loadGoogleGrant(personId);
        if (!grant) throw new Error(NOT_CONNECTED);
        if (!grant.canReadFreeBusy) throw new Error(RECONSENT);
        try {
            const busy = await integrations().google.freeBusy(grant.refreshToken, range);
            // Only the two times cross into the app, whatever else came back.
            return busy.map((b) => ({ start: b.start, end: b.end }));
        } catch (err: any) {
            throw new Error(explain(err));
        }
    },
};
