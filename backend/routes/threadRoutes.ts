import express from "express";
import { auth } from "../middleware/auth.js";
import { requestAttachmentUpload } from "../services/attachments.js";
import { markThreadRead } from "../services/readState.js";
import { listThreads, THREAD_FILTERS, type ThreadFilter } from "../services/threads.js";
import { sendThreadMessage, threadHistory, toThreadMessage } from "../services/threadMessages.js";

/**
 * Letters threads (#100, #101, spec #58). Every route here authorizes through
 * the Threads module (services/threads.ts). A thread key in a path is
 * URL-encoded (`campaign%3A<id>`, `dm%3A<a>%3A<b>`).
 */
const router = express.Router();

/* ------------------------------------------------------------------ */
/* GET /api/threads?filter=all|campaigns|friends — the thread list     */
/* Newest activity first, with unread counts. Never message bodies.    */
/* ------------------------------------------------------------------ */
router.get("/", auth, async (req: any, res) => {
    try {
        const filter = (req.query.filter ?? "all") as ThreadFilter;
        if (!THREAD_FILTERS.includes(filter)) {
            return res.status(400).json({ error: `filter must be one of ${THREAD_FILTERS.join(", ")}` });
        }
        res.json({ threads: await listThreads(req.user, filter) });
    } catch (err: any) {
        console.error("[threads] list error:", err);
        res.status(500).json({ error: "Failed to list threads" });
    }
});

const MARK_READ_ERRORS = {
    "invalid-thread": [400, "Invalid thread key"],
    "forbidden": [403, "You can't see this thread"],
    "invalid-message": [400, "messageId is required"],
    "no-such-message": [404, "No such message in this thread"],
} as const;

/* ------------------------------------------------------------------ */
/* POST /api/threads/:threadKey/read — mark read up to a message       */
/* Body: { messageId }. The position only moves forward.               */
/* ------------------------------------------------------------------ */
router.post("/:threadKey/read", auth, async (req: any, res) => {
    try {
        const result = await markThreadRead(req.user, req.params.threadKey, req.body?.messageId);
        if (!result.ok) {
            const [status, error] = MARK_READ_ERRORS[result.reason];
            return res.status(status).json({ error });
        }
        res.json(result.position);
    } catch (err: any) {
        console.error("[threads] mark-read error:", err);
        res.status(500).json({ error: "Failed to mark thread read" });
    }
});

const HISTORY_ERRORS = {
    "invalid-thread": [400, "Invalid thread key"],
    "forbidden": [403, "You can't see this thread"],
    "invalid-before": [400, "before must be a message id in this thread or a timestamp"],
} as const;

/* ------------------------------------------------------------------ */
/* GET /api/threads/:threadKey/messages — history, newest first        */
/* Query: ?limit=50 (max 200)&before=<message id or ISO timestamp>     */
/* → { messages: ThreadMessage[], hasMore }                            */
/* ------------------------------------------------------------------ */
router.get("/:threadKey/messages", auth, async (req: any, res) => {
    try {
        const result = await threadHistory(req.user, req.params.threadKey, req.query);
        if (!result.ok) {
            const [status, error] = HISTORY_ERRORS[result.reason];
            return res.status(status).json({ error });
        }
        res.json({ messages: await Promise.all(result.rows.map(toThreadMessage)), hasMore: result.hasMore });
    } catch (err: any) {
        console.error("[threads] history error:", err);
        res.status(500).json({ error: "Failed to fetch messages" });
    }
});

const SEND_ERRORS = {
    "invalid-thread": [400, "Invalid thread key"],
    "empty-body": [400, "A message needs a body, an attachment, or both"],
    "body-too-long": [400, "body is too long (4000 characters at most)"],
    "invalid-client-id": [400, "clientId must be 8-64 letters, digits, '-' or '_'"],
    "forbidden": [403, "You can't send to this thread"],
    "client-id-conflict": [409, "That clientId was already used for another message"],
    "invalid-attachments": [400, "attachments must be a list of upload keys"],
    "too-many-attachments": [400, "A message can have at most 10 attachments"],
    "unknown-attachment": [400, "An attachment wasn't uploaded by you for this thread. Request an upload URL first."],
} as const;

/* ------------------------------------------------------------------ */
/* POST /api/threads/:threadKey/messages — send                        */
/* Body: { body?, attachments?: key[], clientId?, eventId? (campaigns) }*/
/* A body, at least one attachment, or both.                           */
/* → 201 { message } new, or 200 { message } for a resend of the same  */
/*   clientId (stored once, published once)                            */
/* ------------------------------------------------------------------ */
router.post("/:threadKey/messages", auth, async (req: any, res) => {
    try {
        const { body, clientId, eventId, attachments } = req.body ?? {};
        const result = await sendThreadMessage(req.user, req.params.threadKey, { body, clientId, eventId, attachments });
        if (!result.ok) {
            const [status, error] = SEND_ERRORS[result.reason];
            return res.status(status).json({ error });
        }
        res.status(result.created ? 201 : 200).json({ message: await toThreadMessage(result.row) });
    } catch (err: any) {
        console.error("[threads] send error:", err);
        res.status(500).json({ error: "Failed to send message" });
    }
});

/* ------------------------------------------------------------------ */
/* POST /api/threads/:threadKey/attachments — an upload URL (#104)     */
/* Body: { name, contentType, size, width?, height? }                  */
/* → 201 { url, method: "PUT", headers, key, expiresAt, maxBytes }.    */
/* PUT the file to `url` with `headers`, then send the message with    */
/* `attachments: [key]`. JPEG, PNG, WebP, GIF or PDF; 10 MB at most.   */
/* ------------------------------------------------------------------ */
router.post("/:threadKey/attachments", auth, async (req: any, res) => {
    try {
        const result = await requestAttachmentUpload(req.user, req.params.threadKey, req.body);
        if (!result.ok) return res.status(result.status).json({ error: result.error });
        res.status(201).json(result.upload);
    } catch (err: any) {
        console.error("[threads] attachment upload error:", err);
        res.status(500).json({ error: "Failed to prepare the upload" });
    }
});

export default router;
