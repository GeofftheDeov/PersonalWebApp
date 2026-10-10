import pool, { query } from "../db/index.js";
import { isUuid } from "../db/model.js";
import Campaign from "../models/Campaign.js";
import { bus } from "../events/index.js";
import { notify } from "../utils/notify.js";
import { findCampaignPeopleIds, findPersonById, personDisplayName } from "../utils/personUtils.js";
import {
    campaignThreadKey,
    canAccessThread,
    dmThreadKey,
    parseThreadKey,
    type ParsedThreadKey,
    type ThreadKey,
    type ThreadPerson,
} from "./threads.js";

/**
 * Thread messages (#101, spec #58): history and send, addressed by thread key.
 *
 * Every consumer reads and writes a conversation the same way, whether it's a
 * campaign's Table Talk or a friend DM. Access is the Threads module's one
 * check (canAccessThread). Sending still publishes the `gamenight.message` /
 * `social.dm` bus events the live channel turns into `message.created` frames,
 * and still rings the bell.
 *
 *   threadHistory(person, key, { limit, before })  newest first; `before` is a
 *                                                   message id in the thread or
 *                                                   a timestamp
 *   sendThreadMessage(person, key, { body, eventId, clientId })
 *                                                   a resend with the same
 *                                                   clientId returns the stored
 *                                                   message, so it lands once
 *
 * Attachments (#104) join `SendInput` and the `messages` row here.
 */

/** A messages row, as stored. */
export type MessageRow = {
    id: string;
    campaign_id: string | null;
    event_id: string | null;
    dm_key: string | null;
    recipient: string | null;
    sender_id: string;
    sender_name: string;
    sender_email: string;
    body: string;
    created_at: Date;
    client_id: string | null;
};

/**
 * A message as the thread endpoints return it: the same shape as the live
 * channel's `message.created` frame (backend/live/PROTOCOL.md), so a client
 * treats history and live messages alike. Never the sender's email.
 */
export type ThreadMessage = {
    id: string;
    sender: { id: string; name: string };
    body: string;
    createdAt: string;
    eventId?: string;
};

export const toThreadMessage = (row: MessageRow): ThreadMessage => ({
    id: String(row.id),
    sender: { id: String(row.sender_id), name: row.sender_name },
    body: row.body,
    createdAt: new Date(row.created_at).toISOString(),
    ...(row.event_id ? { eventId: String(row.event_id) } : {}),
});

/** The SQL condition (on alias `m`) and parameter that select one thread's messages. */
function threadFilter(thread: ParsedThreadKey, param: number): { sql: string; value: string } {
    return thread.kind === "campaign"
        ? { sql: `m.campaign_id = $${param}::uuid`, value: thread.campaignId }
        : { sql: `m.dm_key = $${param}`, value: thread.dmKey };
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

export const HISTORY_DEFAULT_LIMIT = 50;
export const HISTORY_MAX_LIMIT = 200;

export type HistoryResult =
    | { ok: true; rows: MessageRow[]; hasMore: boolean }
    | { ok: false; reason: "invalid-thread" | "forbidden" | "invalid-before" };

/** A page size from a query-string value: a positive whole number, capped; anything else is the default. */
function pageSize(limit: unknown): number {
    const n = Math.floor(Number(limit));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, HISTORY_MAX_LIMIT) : HISTORY_DEFAULT_LIMIT;
}

/**
 * One page of a thread's history, newest first. `before` is a message id in
 * this thread (the page ends just before it) or a timestamp (strictly older).
 *
 * Messages are ordered by (created_at, id) and compared inside Postgres, so a
 * page boundary between messages that share a millisecond, or a microsecond,
 * never skips or repeats one.
 */
export async function threadHistory(
    person: ThreadPerson,
    threadKey: unknown,
    opts: { limit?: unknown; before?: unknown } = {},
): Promise<HistoryResult> {
    const thread = parseThreadKey(threadKey);
    if (!thread) return { ok: false, reason: "invalid-thread" };
    if (!(await canAccessThread(person, threadKey as ThreadKey))) return { ok: false, reason: "forbidden" };

    const limit = pageSize(opts.limit);
    const inThread = threadFilter(thread, 1);
    const params: unknown[] = [inThread.value];
    let cursor = "";

    if (opts.before !== undefined && opts.before !== "") {
        const before = String(opts.before);
        if (isUuid(before)) {
            const { rows: [anchor] } = await query(`SELECT 1 FROM messages m WHERE ${inThread.sql} AND m.id = $2`,
                [inThread.value, before]);
            if (!anchor) return { ok: false, reason: "invalid-before" };
            params.push(before);
            cursor = `AND (m.created_at, m.id) < (SELECT created_at, id FROM messages WHERE id = $2)`;
        } else {
            const at = Date.parse(before);
            if (Number.isNaN(at)) return { ok: false, reason: "invalid-before" };
            params.push(new Date(at).toISOString());
            cursor = `AND m.created_at < $2::timestamptz`;
        }
    }

    params.push(limit + 1); // one extra says whether there's another page
    const { rows } = await query<MessageRow>(
        `SELECT m.* FROM messages m
          WHERE ${inThread.sql} ${cursor}
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT $${params.length}`,
        params);
    return { ok: true, rows: rows.slice(0, limit), hasMore: rows.length > limit };
}

/* ------------------------------------------------------------------ */
/* Send                                                                */
/* ------------------------------------------------------------------ */

export const MAX_BODY_LENGTH = 4000;
const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

export type SendInput = {
    body?: unknown;
    /** Campaign threads only: the session the message is about. */
    eventId?: unknown;
    /** The sender's own id for this message; a resend with the same one is stored once. */
    clientId?: unknown;
};

export type SendResult =
    | { ok: true; row: MessageRow; created: boolean }
    | {
        ok: false;
        reason: "invalid-thread" | "empty-body" | "body-too-long" | "invalid-client-id" | "forbidden" | "client-id-conflict";
    };

/**
 * Stores a message in the thread, publishes it on the bus for live delivery and
 * rings the other people's bells. `created` is false when this was a resend of
 * a message already stored (same sender and clientId): nothing is published or
 * notified again.
 */
export async function sendThreadMessage(
    person: ThreadPerson & { email?: string },
    threadKey: unknown,
    input: SendInput,
): Promise<SendResult> {
    const thread = parseThreadKey(threadKey);
    if (!thread) return { ok: false, reason: "invalid-thread" };
    const key = threadKey as ThreadKey;

    const body = typeof input.body === "string" ? input.body.trim() : "";
    if (!body) return { ok: false, reason: "empty-body" };
    if (body.length > MAX_BODY_LENGTH) return { ok: false, reason: "body-too-long" };

    const clientId = input.clientId === undefined || input.clientId === null ? null : input.clientId;
    if (clientId !== null && (typeof clientId !== "string" || !CLIENT_ID.test(clientId))) {
        return { ok: false, reason: "invalid-client-id" };
    }

    if (!(await canAccessThread(person, key))) return { ok: false, reason: "forbidden" };

    // Senders may be Users, Leads, Contacts, or Accounts — always display the
    // handle (or name), never the email address.
    const sender = await findPersonById(person.id, "name firstName lastName handle email");
    const email = String(person.email ?? sender?.doc?.email ?? "");
    const senderName = sender ? personDisplayName(sender.doc) : email.split("@")[0];

    const isCampaign = thread.kind === "campaign";
    const recipient = isCampaign ? null : thread.people.find((p) => p !== String(person.id))!;
    const eventId = isCampaign && typeof input.eventId === "string" && isUuid(input.eventId) ? input.eventId : null;

    // Store, publish, and on a failed publish take the row back, all under the
    // (sender, clientId) lock: a resend that arrives meanwhile waits for the
    // outcome instead of reporting a row that may yet be deleted.
    return withSendLock(String(person.id), clientId, async (db): Promise<SendResult> => {
        const { rows: [inserted] } = await db.query<MessageRow>(
            `INSERT INTO messages (campaign_id, event_id, dm_key, recipient, sender_id, sender_name, sender_email, body, client_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (sender_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
             RETURNING *`,
            [isCampaign ? thread.campaignId : null, eventId, isCampaign ? null : thread.dmKey, recipient,
                String(person.id), senderName, email, body, clientId]);

        if (!inserted) {
            // A resend of a send that has finished (it held the lock until it
            // did): hand back what's stored, if it's this thread's.
            const { rows: [stored] } = await db.query<MessageRow>(
                `SELECT m.* FROM messages m WHERE m.sender_id = $1 AND m.client_id = $2`, [String(person.id), clientId]);
            const sameThread = stored && (isCampaign
                ? String(stored.campaign_id) === thread.campaignId
                : stored.dm_key === thread.dmKey);
            if (!sameThread) return { ok: false, reason: "client-id-conflict" };
            return { ok: true, row: stored, created: false };
        }

        try {
            await publishAndNotify(inserted, thread, person, senderName, email);
        } catch (err) {
            // Not delivered, so not stored: a resend with this clientId must
            // publish afresh, not find this row and report it sent.
            await db.query(`DELETE FROM messages WHERE id = $1`, [inserted.id]).catch(() => { /* the throw below reports it */ });
            throw err;
        }
        return { ok: true, row: inserted, created: true };
    });
}

/** What a send runs its queries on: the pool, or the one connection holding its lock. */
type Queryable = { query: typeof query };

/**
 * Runs a send while holding a Postgres advisory lock on (sender, clientId), on
 * one pooled connection that the send also runs its own queries on.
 *
 * A send stores its row before it publishes and deletes the row again if the
 * publish fails. Without the lock, a resend with the same clientId that
 * arrives while the first send is still publishing finds the row and answers
 * 200 ("already sent"), and then the first send deletes it: the person sees a
 * message as sent that nobody received and that no longer exists. With it,
 * the resend waits for the first send to finish. If that one published, the
 * resend gets the stored message (200); if it failed and took the row back,
 * the resend stores and publishes it afresh (201). Advisory locks are
 * database-wide, so this holds across backend tasks too.
 *
 * It is a session lock on this connection, so a connection that dies mid-send
 * gives it up. The send's queries run on the same connection, so a waiting
 * resend holds one pooled connection and never needs a second one. Sends
 * without a clientId can't be resent; they skip the lock and use the pool.
 */
async function withSendLock<T>(senderId: string, clientId: string | null, fn: (db: Queryable) => Promise<T>): Promise<T> {
    if (clientId === null) return fn({ query });
    const db = await pool.connect();
    const key = `thread-send:${senderId}:${clientId}`;
    let broken: Error | undefined;
    try {
        await db.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [key]);
        return await fn(db as unknown as Queryable);
    } finally {
        try {
            await db.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [key]);
        } catch (err) {
            // Discarding the connection ends its session, and the lock with it.
            broken = err instanceof Error ? err : new Error(String(err));
        }
        db.release(broken);
    }
}

/** Live delivery (the bus event the live channel forwards) and the bell. Throws if the publish fails. */
async function publishAndNotify(
    inserted: MessageRow,
    thread: ParsedThreadKey,
    person: ThreadPerson,
    senderName: string,
    email: string,
) {
    const body = inserted.body;
    const recipient = inserted.recipient;
    const createdAt = new Date(inserted.created_at).toISOString();
    const senderRef = { id: String(person.id), name: senderName, email };
    if (thread.kind === "campaign") {
        await bus.publish("gamenight.message", {
            messageId: String(inserted.id),
            campaignId: thread.campaignId,
            eventId: inserted.event_id ? String(inserted.event_id) : undefined,
            sender: senderRef,
            body,
            createdAt,
        });
        // Best-effort, off the request path so chat latency stays flat.
        notifyCampaignMembers(thread.campaignId, String(person.id), senderName, body).catch(() => { /* logged inside */ });
    } else {
        await bus.publish("social.dm", {
            messageId: String(inserted.id),
            dmKey: thread.dmKey,
            recipientId: recipient!,
            sender: senderRef,
            body,
            createdAt,
        });
        notify(recipient!, {
            type: "message",
            title: `New message from @${senderName}`,
            body: preview(body),
            // Collapses per thread key, the same key the Letters list uses.
            sourceKey: dmThreadKey(person.id, recipient!),
            meta: { fromUserId: person.id },
        }).catch(() => { /* logged inside */ });
    }
}

const preview = (body: string) => (body.length > 80 ? `${body.slice(0, 77)}...` : body);

/** One bell entry per campaign per member, collapsing while unread. */
async function notifyCampaignMembers(campaignId: string, senderId: string, senderName: string, body: string) {
    try {
        const [campaign, peopleIds] = await Promise.all([
            Campaign.findById(campaignId).select("title"),
            findCampaignPeopleIds(campaignId),
        ]);
        await Promise.all(
            peopleIds
                .filter((id) => id !== String(senderId))
                .map((id) => notify(id, {
                    type: "message",
                    title: `New message in "${campaign?.title || "a campaign"}"`,
                    body: `${senderName}: ${preview(body)}`,
                    link: `/game-night/campaigns/${campaignId}`,
                    sourceKey: campaignThreadKey(campaignId),
                    meta: { campaignId },
                })),
        );
    } catch (err: any) {
        console.error("[messages] campaign notify failed:", err.message);
    }
}
