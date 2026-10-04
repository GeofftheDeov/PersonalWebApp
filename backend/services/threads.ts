import { isUuid } from "../db/model.js";
import { getAuthorizedCampaignIds, getMemberCampaignIds } from "../utils/gameNightPlannerUtils.js";
import { findPersonById } from "../utils/personUtils.js";

/**
 * Threads (#97, spec #58): the one place that decides who sees which
 * conversation.
 *
 * A thread is identified by its **thread key**:
 *   - `campaign:<campaign id>` — a campaign's Table Talk
 *   - `dm:<dm_key>`            — a friend DM; dm_key is the two account ids,
 *                                sorted, joined by ":" (the messages.dm_key value)
 *
 * Two questions, two answers:
 *   - visibleThreadKeys(person): every campaign they're a member of, whatever
 *     its status, plus one DM thread per current friend. Membership-only, so an
 *     admin's set doesn't include every campaign on the site. Live subscriptions
 *     use this set; the thread list narrows it to active campaigns.
 *   - canAccessThread(person, key): campaign threads follow campaign access
 *     (members, and admins for any campaign); DM threads are friends-only and
 *     only for the two people in the pair. Malformed keys are refused.
 */

export type ThreadKey = string;

export type ParsedThreadKey =
    | { kind: "campaign"; campaignId: string }
    | { kind: "dm"; dmKey: string; people: readonly [string, string] };

/** Anyone with an account id; matches `req.user`. */
export type ThreadPerson = { id: string };

/** The messages.dm_key value for a pair: both ids, sorted. */
export const dmKeyFor = (a: string, b: string): string => [String(a), String(b)].sort().join(":");

export const campaignThreadKey = (campaignId: string): ThreadKey => `campaign:${campaignId}`;

export const dmThreadKey = (a: string, b: string): ThreadKey => `dm:${dmKeyFor(a, b)}`;

/**
 * Parses a thread key, or returns null for anything that isn't exactly a
 * well-formed key: an unknown kind, an id that isn't a uuid, a DM pair that
 * isn't two distinct ids in sorted order.
 */
export function parseThreadKey(key: unknown): ParsedThreadKey | null {
    if (typeof key !== "string") return null;
    const sep = key.indexOf(":");
    if (sep < 0) return null;
    const kind = key.slice(0, sep);
    const rest = key.slice(sep + 1);

    if (kind === "campaign") {
        return isUuid(rest) ? { kind: "campaign", campaignId: rest } : null;
    }
    if (kind === "dm") {
        const people = rest.split(":");
        if (people.length !== 2) return null;
        const [a, b] = people;
        if (!isUuid(a) || !isUuid(b) || a === b) return null;
        // One canonical key per pair, so a key always names the stored dm_key.
        if (dmKeyFor(a, b) !== rest) return null;
        return { kind: "dm", dmKey: rest, people: [a, b] };
    }
    return null;
}

/** Current friends' account ids, once each, never yourself. */
async function friendIds(person: ThreadPerson): Promise<string[]> {
    const me = await findPersonById(person.id, "friends");
    const ids = (me?.doc?.friends ?? []).map((f: unknown) => String(f));
    return [...new Set<string>(ids)].filter((id) => isUuid(id) && id !== String(person.id));
}

/** Thread keys for the person's campaign memberships plus one DM per friend. */
export async function visibleThreadKeys(person: ThreadPerson): Promise<ThreadKey[]> {
    if (!person?.id || !isUuid(String(person.id))) return [];
    const [campaignIds, friends] = await Promise.all([getMemberCampaignIds(person), friendIds(person)]);
    return [
        ...[...new Set(campaignIds)].map(campaignThreadKey),
        ...friends.map((f) => dmThreadKey(person.id, f)),
    ];
}

/** Whether the person may read, send to and stream this thread. */
export async function canAccessThread(person: ThreadPerson, key: ThreadKey): Promise<boolean> {
    if (!person?.id) return false;
    const thread = parseThreadKey(key);
    if (!thread) return false;

    if (thread.kind === "campaign") {
        const authorized = await getAuthorizedCampaignIds(person);
        if (authorized === null) return true; // admin: any campaign's history
        return authorized.some((id: unknown) => String(id) === thread.campaignId);
    }

    const me = String(person.id);
    if (!thread.people.includes(me)) return false;
    const other = thread.people[0] === me ? thread.people[1] : thread.people[0];
    return (await friendIds(person)).includes(other);
}
