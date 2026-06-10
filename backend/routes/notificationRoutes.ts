import express from "express";
import Notification from "../models/Notification.js";
import { auth } from "../middleware/auth.js";

const router = express.Router();

/* ------------------------------------------------------------------ */
/* GET /api/notifications?limit=30 — newest first, plus unread count   */
/* ------------------------------------------------------------------ */
router.get("/", auth, async (req: any, res) => {
    try {
        const limit = Math.min(Number(req.query.limit) || 30, 100);
        const [notifications, unreadCount] = await Promise.all([
            Notification.find({ user: req.user.id }).sort({ createdAt: -1 }).limit(limit),
            Notification.countDocuments({ user: req.user.id, read: false }),
        ]);
        res.json({ notifications, unreadCount });
    } catch (err: any) {
        console.error("[notifications] list error:", err);
        res.status(500).json({ error: "Failed to fetch notifications", details: err.message });
    }
});

/* ------------------------------------------------------------------ */
/* PUT /api/notifications/read-all — mark everything read              */
/* (registered before /:id/read so "read-all" isn't matched as an id)  */
/* ------------------------------------------------------------------ */
router.put("/read-all", auth, async (req: any, res) => {
    try {
        await Notification.updateMany({ user: req.user.id, read: false }, { $set: { read: true } });
        res.json({ message: "All notifications marked read" });
    } catch (err: any) {
        console.error("[notifications] read-all error:", err);
        res.status(500).json({ error: "Failed to mark notifications read", details: err.message });
    }
});

/* ------------------------------------------------------------------ */
/* PUT /api/notifications/:id/read — mark one read                     */
/* ------------------------------------------------------------------ */
router.put("/:id/read", auth, async (req: any, res) => {
    try {
        const updated = await Notification.findOneAndUpdate(
            { _id: req.params.id, user: req.user.id },
            { $set: { read: true } },
            { new: true }
        );
        if (!updated) return res.status(404).json({ error: "Notification not found" });
        res.json(updated);
    } catch (err: any) {
        console.error("[notifications] read error:", err);
        res.status(500).json({ error: "Failed to mark notification read", details: err.message });
    }
});

export default router;
