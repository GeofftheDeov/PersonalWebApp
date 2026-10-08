import express from "express";
import { auth } from "../middleware/auth.js";
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
        res.json({ messages: result.rows.map(toThreadMessage), hasMore: result.hasMore });
    } catch (err: any) {
        console.error("[threads] history error:", err);
        res.status(500).json({ error: "Failed to fetch messages" });
    }
});

const SEND_ERRORS = {
    "invalid-thread": [400, "Invalid thread key"],
    "empty-body": [400, "body is required"],
    "body-too-long": [400, "body is too long (4000 characters at most)"],
    "invalid-client-id": [400, "clientId must be 8-64 letters, digits, '-' or '_'"],
    "forbidden": [403, "You can't send to this thread"],
    "client-id-conflict": [409, "That clientId was already used for another message"],
} as const;

/* ------------------------------------------------------------------ */
/* POST /api/threads/:threadKey/messages — send                        */
/* Body: { body, clientId?, eventId? (campaigns) }                     */
/* → 201 { message } new, or 200 { message } for a resend of the same  */
/*   clientId (stored once, published once)                            */
/* ------------------------------------------------------------------ */
router.post("/:threadKey/messages", auth, async (req: any, res) => {
    try {
        const { body, clientId, eventId } = req.body ?? {};
        const result = await sendThreadMessage(req.user, req.params.threadKey, { body, clientId, eventId });
        if (!result.ok) {
            const [status, error] = SEND_ERRORS[result.reason];
            return res.status(status).json({ error });
        }
        res.status(result.created ? 201 : 200).json({ message: toThreadMessage(result.row) });
    } catch (err: any) {
        console.error("[threads] send error:", err);
        res.status(500).json({ error: "Failed to send message" });
    }
});

export default router;
