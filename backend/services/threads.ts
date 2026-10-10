import { query } from "../db/index.js";
import { isUuid } from "../db/model.js";
import { getAuthorizedCampaignIds, getMemberCampaignIds } from "../utils/gameNightPlannerUtils.js";
import { findPersonById, personDisplayName } from "../utils/personUtils.js";

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
 *
 * And the Letters list built on the first (#100):
 *   - listThreads(person, filter): visibleThreadKeys narrowed to active
 *     campaigns and to DMs that have messages, each with title, subtitle, last
 *     activity and unread count (read state lives in services/readState.ts).
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

/* ------------------------------------------------------------------ */
/* The thread list (#100)                                              */
/* ------------------------------------------------------------------ */

export type ThreadFilter = "all" | "campaigns" | "friends";
export const THREAD_FILTERS: readonly ThreadFilter[] = ["all", "campaigns", "friends"];

/** One row of the Letters list. Never carries message text. */
export type ThreadListEntry = {
    threadKey: ThreadKey;
    kind: "campaign" | "dm";
    /** What to open: the campaign id, or the friend's account id. */
    targetId: string;
    title: string;
    /** Up to two initials to draw an avatar from. */
    avatarHint: string;
    subtitle: string;
    /** The newest message's time, or null for a campaign nobody has written in yet. */
    lastActivityAt: string | null;
    /** Messages after the person's read position that someone else sent. */
    unreadCount: number;
};

/**
 * campaigns.status values that mean the game is over. The vocabulary is
 * 'Not Started' | 'In Progress' | 'Completed'; there is no archived state, so
 * an active campaign is any that isn't Completed.
 */
const FINISHED_CAMPAIGN_STATUSES = ["Completed"];

const initials = (name: string): string =>
    name.split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

const toIso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);

/** The person's active campaigns among `campaignIds`, with party size, last activity and unread count. */
async function campaignEntries(me: string, campaignIds: string[]): Promise<ThreadListEntry[]> {
    if (!campaignIds.length) return [];
    const { rows } = await query<{ id: string; title: string; party: number; last_at: Date | null; unread: number }>(
        `SELECT c.id, c.title,
                (SELECT count(DISTINCT m.person_id) FROM campaign_members m
                  WHERE m.campaign_id = c.id AND m.person_id IS NOT NULL)::int AS party,
                last.at AS last_at,
                (SELECT count(*) FROM messages msg
                  WHERE msg.campaign_id = c.id AND msg.sender_id <> $2
                    AND msg.created_at > COALESCE(r.last_read_at, '-infinity'))::int AS unread
           FROM campaigns c
           LEFT JOIN thread_reads r ON r.person_id = $1 AND r.thread_key = 'campaign:' || c.id
           LEFT JOIN LATERAL (SELECT created_at AS at FROM messages
                               WHERE campaign_id = c.id ORDER BY created_at DESC LIMIT 1) last ON true
          WHERE c.id = ANY($3::uuid[]) AND c.status <> ALL($4::text[])`,
        [me, me, campaignIds, FINISHED_CAMPAIGN_STATUSES]);
    return rows.map((r) => ({
        threadKey: campaignThreadKey(r.id),
        kind: "campaign",
        targetId: String(r.id),
        title: r.title,
        avatarHint: initials(r.title),
        subtitle: `Campaign · ${r.party} in the party`,
        lastActivityAt: toIso(r.last_at),
        unreadCount: r.unread,
    }));
}

/** DM threads among `dms` that have at least one message, titled by the friend. */
async function dmEntries(me: string, dms: { dmKey: string; friendId: string }[]): Promise<ThreadListEntry[]> {
    if (!dms.length) return [];
    const { rows } = await query<{ dm_key: string; last_at: Date; unread: number }>(
        `SELECT k.dm_key, last.at AS last_at,
                (SELECT count(*) FROM messages msg
                  WHERE msg.dm_key = k.dm_key AND msg.sender_id <> $2
                    AND msg.created_at > COALESCE(r.last_read_at, '-infinity'))::int AS unread
           FROM unnest($3::text[]) AS k(dm_key)
           JOIN LATERAL (SELECT created_at AS at FROM messages
                          WHERE dm_key = k.dm_key ORDER BY created_at DESC LIMIT 1) last ON true
           LEFT JOIN thread_reads r ON r.person_id = $1 AND r.thread_key = 'dm:' || k.dm_key`,
        [me, me, dms.map((d) => d.dmKey)]);
    if (!rows.length) return [];

    const friendOf = new Map(dms.map((d) => [d.dmKey, d.friendId]));
    const { rows: people } = await query(
        `SELECT id, handle, name, first_name AS "firstName", last_name AS "lastName", email
           FROM accounts WHERE id = ANY($1::uuid[])`,
        [rows.map((r) => friendOf.get(r.dm_key))]);
    const nameOf = new Map(people.map((p: any) => [String(p.id), personDisplayName(p)]));

    return rows.map((r) => {
        const friendId = friendOf.get(r.dm_key)!;
        const title = nameOf.get(friendId) ?? "Unknown Player";
        return {
            threadKey: `dm:${r.dm_key}`,
            kind: "dm",
            targetId: friendId,
            title,
            avatarHint: initials(title),
            subtitle: "Friend",
            lastActivityAt: toIso(r.last_at),
            unreadCount: r.unread,
        };
    });
}

/**
 * The Letters list: one thread per active campaign the person is a member of
 * and one per friend they've exchanged messages with, newest activity first.
 * Built on visibleThreadKeys, so it shows nothing the access rules don't.
 */
export async function listThreads(person: ThreadPerson, filter: ThreadFilter = "all"): Promise<ThreadListEntry[]> {
    const me = String(person?.id ?? "");
    const campaignIds: string[] = [];
    const dms: { dmKey: string; friendId: string }[] = [];
    for (const key of await visibleThreadKeys(person)) {
        const thread = parseThreadKey(key);
        if (thread?.kind === "campaign") campaignIds.push(thread.campaignId);
        else if (thread?.kind === "dm") {
            dms.push({ dmKey: thread.dmKey, friendId: thread.people[0] === me ? thread.people[1] : thread.people[0] });
        }
    }

    const [campaigns, friends] = await Promise.all([
        filter === "friends" ? [] : campaignEntries(me, campaignIds),
        filter === "campaigns" ? [] : dmEntries(me, dms),
    ]);

    const at = (t: ThreadListEntry) => (t.lastActivityAt ? Date.parse(t.lastActivityAt) : -Infinity);
    return [...campaigns, ...friends].sort((a, b) => at(b) - at(a) || a.title.localeCompare(b.title));
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
