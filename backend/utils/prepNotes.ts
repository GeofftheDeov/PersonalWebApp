import CampaignMember from "../models/CampaignMember.js";
import { isAdmin } from "./gameNightPlannerUtils.js";
import { isSessionEventDescription } from "./frontendSites.js";

/**
 * Prep notes are the GM's (#213, spec #69). A session's `agenda` is its Game
 * Master's prep: only the campaign's Game Master, the session's one-session
 * stand-in (`gmOverride`, while still in the party) and admins read or write
 * it. Everyone else gets the session without an `agenda` key at all, so a
 * client can tell "you may see Prep notes" (the key is there, maybe null) from
 * "you may not" (it isn't).
 *
 * Nothing that leaves the app carries it either: Discord and Google Calendar
 * events (and the shareable Google link) are published without it. Their
 * description is the session's Hearthside page instead, when there is one (#214).
 */

const idOf = (ref: any): string => (ref == null ? "" : String(ref._id ?? ref));

/**
 * Who may read Prep notes, decided once per request for any number of
 * sessions: one admin check and one membership lookup. The same people as
 * isSessionGameMaster (gameNightPlannerUtils.ts), who may write them, and
 * roleIn's `gm` (planning/roles.ts), which the planning read uses: keep the
 * three in step.
 */
export async function prepNotesReader(user: any): Promise<(session: { campaign?: unknown; gmOverride?: unknown }) => boolean> {
    if (await isAdmin(user)) return () => true;
    if (!user?.id) return () => false;
    const memberships = await CampaignMember.find({ person: user.id, isActive: true }).select("campaign status");
    const seated = new Set<string>(memberships.map((m: any) => String(m.campaign)));
    const gm = new Set<string>(memberships.filter((m: any) => m.status === "Game Master").map((m: any) => String(m.campaign)));
    const me = String(user.id);
    return (session) => {
        const campaignId = idOf(session.campaign);
        if (gm.has(campaignId)) return true;
        // A stand-in counts only while they're still in the party (#89).
        return idOf(session.gmOverride) === me && seated.has(campaignId);
    };
}

/**
 * The shareable Google link as anyone but a reader gets it. Until #213 its
 * `details` were only ever the agenda, and links stored then still carry it
 * (perhaps an agenda since edited), so those details are dropped. Since #214
 * they may instead be just the session's Hearthside page, which is kept.
 */
export function scrubCalendarLink(link: string | null | undefined): string | null | undefined {
    if (!link || !link.includes("details=")) return link;
    try {
        const url = new URL(link);
        if (isSessionEventDescription(url.searchParams.get("details") ?? "")) return link;
        url.searchParams.delete("details");
        return url.toString();
    } catch {
        return link;
    }
}

/** A session (a model document or plain object) as someone who may not read Prep notes sees it. */
export function withoutPrepNotes<T extends Record<string, any>>(session: T): Omit<T, "agenda"> {
    const plain: any = typeof session?.toJSON === "function" ? session.toJSON() : { ...session };
    const { agenda: _agenda, ...rest } = plain;
    if ("googleCalendarLink" in rest) rest.googleCalendarLink = scrubCalendarLink(rest.googleCalendarLink);
    return rest;
}

/** The session as this reader sees it. */
export function forReader<T extends Record<string, any>>(canRead: (s: any) => boolean, session: T): any {
    return canRead(session) ? session : withoutPrepNotes(session);
}
