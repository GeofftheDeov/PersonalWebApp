import { query } from "../db/index.js";
import { isUuid } from "../db/model.js";
import { bus } from "../events/index.js";
import { canAccessThread, parseThreadKey, type ThreadKey, type ThreadPerson } from "./threads.js";

/**
 * Read state (#100, spec #58): how far each person has read each thread.
 *
 * One thread_reads row per (person, thread key). A thread's unread count is
 * the messages after last_read_at that someone else sent (the Threads list
 * query joins this table). The position only ever moves forward, so two
 * devices marking read out of order can't resurrect read messages.
 *
 * When a mark-read moves the position forward, it publishes `thread.read`
 * (ephemeral) so the live channel can sync the person's other devices (#102).
 */

export type ReadPosition = {
    threadKey: ThreadKey;
    lastReadAt: string;
    lastReadMessageId: string | null;
};

export type MarkReadResult =
    | { ok: true; position: ReadPosition }
    | { ok: false; reason: "invalid-thread" | "forbidden" | "invalid-message" | "no-such-message" };

/**
 * Each person's unread count in one thread: the messages after their read
 * position that someone else sent (the rule listThreads uses). For the live
 * channel's `thread.updated` frames (#102). Ids that aren't uuids count 0, and
 * so does a malformed thread key. One query for all the people.
 */
export async function unreadCounts(threadKey: ThreadKey, personIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>(personIds.map((id) => [id, 0]));
    const thread = parseThreadKey(threadKey);
    const people = [...new Set(personIds)].filter(isUuid);
    if (!thread || !people.length) return counts;
    const { rows } = await query<{ person_id: string; unread: number }>(
        `SELECT p.id AS person_id,
                (SELECT count(*) FROM messages msg
                  WHERE ${thread.kind === "campaign" ? "msg.campaign_id = $3::uuid" : "msg.dm_key = $3"}
                    AND msg.sender_id <> p.id::text
                    AND msg.created_at > COALESCE(r.last_read_at, '-infinity'))::int AS unread
           FROM unnest($1::uuid[]) AS p(id)
           LEFT JOIN thread_reads r ON r.person_id = p.id AND r.thread_key = $2`,
        [people, threadKey, thread.kind === "campaign" ? thread.campaignId : thread.dmKey]);
    for (const r of rows) counts.set(String(r.person_id), r.unread);
    return counts;
}

/** Marks the thread read up to (and including) `messageId`, which must belong to it. */
export async function markThreadRead(person: ThreadPerson, threadKey: unknown, messageId: unknown): Promise<MarkReadResult> {
    const thread = parseThreadKey(threadKey);
    if (!thread) return { ok: false, reason: "invalid-thread" };
    const key = threadKey as ThreadKey;
    if (!(await canAccessThread(person, key))) return { ok: false, reason: "forbidden" };
    if (typeof messageId !== "string" || !isUuid(messageId)) return { ok: false, reason: "invalid-message" };

    const { rows: [message] } = thread.kind === "campaign"
        ? await query(`SELECT id FROM messages WHERE id = $1 AND campaign_id = $2`, [messageId, thread.campaignId])
        : await query(`SELECT id FROM messages WHERE id = $1 AND dm_key = $2`, [messageId, thread.dmKey]);
    if (!message) return { ok: false, reason: "no-such-message" };

    // created_at is copied inside Postgres: a JS Date keeps only milliseconds,
    // and a truncated position would leave the read message itself unread.
    const { rows: [row] } = await query(
        `INSERT INTO thread_reads (person_id, thread_key, last_read_at, last_read_message_id)
         SELECT $1, $2, m.created_at, m.id FROM messages m WHERE m.id = $3
         ON CONFLICT (person_id, thread_key) DO UPDATE
            SET last_read_at = EXCLUDED.last_read_at,
                last_read_message_id = EXCLUDED.last_read_message_id,
                updated_at = now()
          WHERE thread_reads.last_read_at < EXCLUDED.last_read_at
         RETURNING last_read_at, last_read_message_id`,
        [person.id, key, message.id]);
    // No row back means the stored position was already at or past this message.
    const current = row ?? (await query(
        `SELECT last_read_at, last_read_message_id FROM thread_reads WHERE person_id = $1 AND thread_key = $2`,
        [person.id, key])).rows[0];
    if (!current) return { ok: false, reason: "no-such-message" }; // deleted mid-request

    const position: ReadPosition = {
        threadKey: key,
        lastReadAt: new Date(current.last_read_at).toISOString(),
        lastReadMessageId: current.last_read_message_id ? String(current.last_read_message_id) : null,
    };
    // Only a move forward is news: the person's other devices already have any position at or past this one.
    if (row) await publishRead(String(person.id), position);
    return { ok: true, position };
}

/**
 * Tells the live channel the person's position moved (`thread.read`, #102).
 * Ephemeral, not `publish`: the frame only syncs sockets open right now (the
 * broadcast path is at-most-once either way), the position itself is already
 * stored in thread_reads, and no once-per-service consumer needs reads, so
 * persisting one per thread view would only grow the Redis stream. Best
 * effort: a failure here never fails the mark-read.
 */
async function publishRead(personId: string, position: ReadPosition) {
    try {
        const unread = await unreadCounts(position.threadKey, [personId]);
        await bus.publishEphemeral("thread.read", {
            personId,
            threadKey: position.threadKey,
            lastReadAt: position.lastReadAt,
            lastReadMessageId: position.lastReadMessageId,
            unreadCount: unread.get(personId) ?? 0,
        });
    } catch (err: any) {
        console.error("[read-state] could not publish thread.read:", err.message);
    }
}
