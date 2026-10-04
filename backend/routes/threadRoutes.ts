import express from "express";
import { auth } from "../middleware/auth.js";
import { markThreadRead } from "../services/readState.js";
import { listThreads, THREAD_FILTERS, type ThreadFilter } from "../services/threads.js";

/**
 * Letters threads (#100, spec #58). Every route here authorizes through the
 * Threads module (services/threads.ts).
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

export default router;
