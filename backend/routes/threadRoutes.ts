import express from "express";
import { auth } from "../middleware/auth.js";
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

export default router;
