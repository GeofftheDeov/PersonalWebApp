import { bus, type EventMap } from "../events/index.js";

/**
 * Access events (#105, spec #58): the one way code that changes who is in a
 * campaign, or who is friends with whom, says so. The live channel listens
 * and recomputes the affected people's threads, so a socket that is already
 * open starts or stops getting a thread's messages and typing without
 * reconnecting.
 *
 * Call these after the change is committed, and await them before answering
 * the request: the event then reaches the bus before anything the caller does
 * next (a message sent straight after leaving is never delivered to the
 * leaver). A failure to publish is logged, never thrown: the change itself
 * already happened, and a socket picks it up on its next connect anyway.
 *
 * Every path that changes membership or friendship calls one of these. A new
 * one (#37's member deactivation, say) should too, rather than publishing on
 * its own.
 */

type MembershipAction = EventMap["campaign.changed"]["action"];

/**
 * A campaign's membership changed: `personId` joined (member-added, or
 * created for the campaign's creator) or left (member-removed). For
 * `deleted`, omit `personId`: everyone subscribed to the campaign loses it.
 */
export async function publishMembershipChanged(
    campaignId: string,
    action: MembershipAction,
    personId?: string | null,
): Promise<void> {
    await publishSafely("campaign.changed", {
        campaignId: String(campaignId),
        action,
        ...(personId ? { personId: String(personId) } : {}),
    });
}

/** Two people became friends (added) or stopped being friends (removed). */
export async function publishFriendshipChanged(a: string, b: string, action: "added" | "removed"): Promise<void> {
    await publishSafely("friendship.changed", { personIds: [String(a), String(b)], action });
}

/**
 * An account was deleted: its open sockets are closed (4001), because its
 * token names nobody now. Publish its membership and friendship changes too;
 * this only ends the sockets.
 */
export async function publishAccountDeleted(personId: string): Promise<void> {
    await publishSafely("account.deleted", { personId: String(personId) });
}

async function publishSafely<K extends "campaign.changed" | "friendship.changed" | "account.deleted">(
    event: K,
    payload: EventMap[K],
) {
    try {
        await bus.publish(event, payload);
    } catch (err: any) {
        console.error(`[access] could not publish ${event}:`, err?.message ?? err);
    }
}
