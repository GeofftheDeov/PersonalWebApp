import express from "express";
import Notification from "../models/Notification.js";
import { auth } from "../middleware/auth.js";
import { hearthsideSite } from "../utils/frontendSites.js";
import { FRIEND_ANSWER_FILTER } from "../utils/friendAnswerNotice.js";

const router = express.Router();

/* ------------------------------------------------------------------ */
/* ?site=hearthside: the bell on Hearthside (#220, spec #69)           */
/* ------------------------------------------------------------------ */
/**
 * Which of a person's notifications a site's bell shows. The portfolio's (no
 * `site`, or `site=portfolio`) shows everything, as always. Hearthside's shows
 * only Hearthside's: campaign invites, friend requests, the answers to your
 * friend requests (#251, `friendAnswerNotice`), and anything whose link is a
 * Game Night page, either a relative `/game-night/...` path (rows made without
 * HEARTHSIDE_URL, #214) or an absolute link on this environment's Hearthside
 * host.
 *
 * The list, the unread count and "mark all read" all take the same filter, so
 * the badge and the button never count what the bell doesn't show. Returns
 * null for a site it doesn't know, which the routes answer with a 400.
 */
const GAME_NIGHT_PATH = "^/game-night([/?#]|$)";
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function notificationSiteFilter(site: unknown): Record<string, unknown> | null {
    if (site === undefined || site === "portfolio") return {};
    if (site !== "hearthside") return null;
    const gameNight: Record<string, unknown>[] = [{ link: { $regex: GAME_NIGHT_PATH } }];
    const hearthside = hearthsideSite();
    if (hearthside) gameNight.push({ link: { $regex: `^${escapeRegex(hearthside.origin)}([/?#]|$)`, $options: "i" } });
    return { $or: [{ type: { $in: ["campaign_invite", "friend_request"] } }, FRIEND_ANSWER_FILTER, ...gameNight] };
}

const UNKNOWN_SITE = { error: "Unknown site: use site=hearthside, or leave it out for every notification" };

/* ------------------------------------------------------------------ */
/* GET /api/notifications?limit=30[&site=hearthside]: newest first,    */
/* plus the unread count, both for that site's bell                    */
/* ------------------------------------------------------------------ */
router.get("/", auth, async (req: any, res) => {
    const forSite = notificationSiteFilter(req.query.site);
    if (!forSite) return res.status(400).json(UNKNOWN_SITE);
    try {
        const limit = Math.min(Number(req.query.limit) || 30, 100);
        const [notifications, unreadCount] = await Promise.all([
            Notification.find({ user: req.user.id, ...forSite }).sort({ createdAt: -1 }).limit(limit),
            Notification.countDocuments({ user: req.user.id, read: false, ...forSite }),
        ]);
        res.json({ notifications, unreadCount });
    } catch (err: any) {
        console.error("[notifications] list error:", err);
        res.status(500).json({ error: "Failed to fetch notifications", details: err.message });
    }
});

/* ------------------------------------------------------------------ */
/* PUT /api/notifications/read-all[?site=hearthside]: mark read what   */
/* that site's bell shows (everything, without `site`)                 */
/* (registered before /:id/read so "read-all" isn't matched as an id)  */
/* ------------------------------------------------------------------ */
router.put("/read-all", auth, async (req: any, res) => {
    const forSite = notificationSiteFilter(req.query.site);
    if (!forSite) return res.status(400).json(UNKNOWN_SITE);
    try {
        await Notification.updateMany({ user: req.user.id, read: false, ...forSite }, { $set: { read: true } });
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
