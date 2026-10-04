import { query } from "../db/index.js";
import { isUuid } from "../db/model.js";
import { canAccessThread, parseThreadKey, type ThreadKey, type ThreadPerson } from "./threads.js";

/**
 * Read state (#100, spec #58): how far each person has read each thread.
 *
 * One thread_reads row per (person, thread key). A thread's unread count is
 * the messages after last_read_at that someone else sent (the Threads list
 * query joins this table). The position only ever moves forward, so two
 * devices marking read out of order can't resurrect read messages.
 */

export type ReadPosition = {
    threadKey: ThreadKey;
    lastReadAt: string;
    lastReadMessageId: string | null;
};

export type MarkReadResult =
    | { ok: true; position: ReadPosition }
    | { ok: false; reason: "invalid-thread" | "forbidden" | "invalid-message" | "no-such-message" };

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

    return {
        ok: true,
        position: {
            threadKey: key,
            lastReadAt: new Date(current.last_read_at).toISOString(),
            lastReadMessageId: current.last_read_message_id ? String(current.last_read_message_id) : null,
        },
    };
}
