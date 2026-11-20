/**
 * The campaign invite page (#232, spec #69): `/join/:id`, where `:id` is the
 * campaign's id (the link a party copies from its page, `inviteLink`, and the
 * portfolio's old `/game-night/join/:id`).
 *
 * Someone may arrive with a pending invite (a friend invited them, which rang
 * their bell) or with only the link. Accepting answers the pending invite when
 * there is one (`PUT /api/campaign-invites/:id/respond`), so their bell clears
 * and the inviter hears back; with only the link it joins
 * (`POST /api/campaigns/:id/join`). Framework-free, so the rules are tested on
 * their own (test/invite.test.ts).
 */
import type { Member } from "./campaignPage";

/** The page for a campaign's invite: what to come back to after signing in. */
export const joinPath = (campaignId: string): string => `/join/${encodeURIComponent(campaignId)}`;

/** Someone as `GET /api/campaign-invites/mine` sends an inviter (the public fields). */
export interface Inviter {
  _id?: string;
  name?: string | null;
  handle?: string | null;
}

/** A pending invite, as `GET /api/campaign-invites/mine` lists it. */
export interface PendingInvite {
  _id: string;
  /** The campaign, populated (`_id`, `title`, …), or just its id. */
  campaign: string | { _id?: string; id?: string; title?: string | null } | null;
  from?: Inviter | null;
  status?: string;
}

const campaignIdOf = (i: PendingInvite): string | null =>
  typeof i.campaign === "string" ? i.campaign : i.campaign?._id ?? i.campaign?.id ?? null;

/** The viewer's pending invite to this campaign, if they have one (the newest: the list comes newest first). */
export function pendingInviteFor(invites: readonly PendingInvite[] | null | undefined, campaignId: string): PendingInvite | null {
  const id = campaignId.toLowerCase();
  return invites?.find((i) => (i.status ?? "pending") === "pending" && campaignIdOf(i)?.toLowerCase() === id) ?? null;
}

/** Who sent the invite, as the page names them: @handle, else their name, else nobody. */
export function inviterName(invite: PendingInvite | null | undefined): string | null {
  const from = invite?.from;
  if (from?.handle) return `@${from.handle}`;
  return from?.name?.trim() || null;
}

/**
 * Whether the viewer already has a seat: an active member of the party. The
 * members list is only readable by the party (and admins), so null means
 * "not in it" for anyone else.
 */
export function hasSeat(members: readonly Member[] | null | undefined, viewerId: string | null | undefined): boolean {
  return !!viewerId && !!members?.some((m) => m.playerId === viewerId && m.isActive !== false);
}

/** "1 at the table" / "4 at the table", counting the active party; null when the party can't be read. */
export function partyCount(members: readonly Member[] | null | undefined): string | null {
  if (!members) return null;
  const n = members.filter((m) => m.isActive !== false && m.playerId).length;
  return n ? `${n} at the table` : null;
}
