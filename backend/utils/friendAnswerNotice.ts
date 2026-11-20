/**
 * The bell row a person gets when someone answers their friend request:
 * "@Mira accepted your friend request" or "@Mira declined your friend request"
 * (a `system` row with no link, so the portfolio's bell, which opens nothing
 * for it, is unchanged).
 *
 * Hearthside's bell shows these too (#251): `meta` names the answer and who
 * gave it, so opening one there goes to that person's `/players/:id`. Rows
 * made before #251 have no `meta`; they're recognised by their title, which
 * hasn't changed since friend requests rang the bell, and open nothing.
 */

export type FriendAnswer = "accepted" | "declined";

/** What `notify()` takes for the row telling a request's sender how it was answered. */
export function friendAnswerNotice(answer: FriendAnswer, by: { id: string; name: string }, requestId: string) {
    return {
        type: "system" as const,
        title: `@${by.name} ${answer} your friend request`,
        meta: { friendAnswer: answer, fromUserId: by.id, friendRequestId: requestId },
    };
}

/** A row made before #251, by its title alone (Postgres regex). */
const LEGACY_TITLE = "^@.* (accepted|declined) your friend request$";

/** The notifications filter (db/model.ts) matching friend-request answers, old and new. */
export const FRIEND_ANSWER_FILTER: Record<string, unknown> = {
    type: "system",
    $or: [
        { "meta.friendAnswer": { $in: ["accepted", "declined"] } },
        { title: { $regex: LEGACY_TITLE } },
    ],
};
