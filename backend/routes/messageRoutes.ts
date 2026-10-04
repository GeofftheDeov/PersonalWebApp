import express from "express";
import { isUuid } from "../db/model.js";
import Message from "../models/Message.js";
import Campaign from "../models/Campaign.js";
import { auth } from "../middleware/auth.js";
import { canAccessThread, campaignThreadKey, dmKeyFor, dmThreadKey } from "../services/threads.js";
import { bus } from "../events/index.js";
import { notify } from "../utils/notify.js";
import { findPersonById, findCampaignPeopleIds, personDisplayName } from "../utils/personUtils.js";

/*
 * Campaign chat (Table Talk) and friend DMs: history and send over REST. Live
 * delivery is the live channel's job (backend/live/liveChannel.ts): sending
 * publishes gamenight.message / social.dm on the bus, and the channel forwards
 * each one to the sockets subscribed to its thread. The SSE streams that used
 * to live here were retired with #99.
 */
const router = express.Router();

/** Auth check on the campaign, shared by both campaign endpoints. Threads owns the rule. */
async function assertCampaignAccess(user: any, campaignId: string): Promise<boolean> {
    return canAccessThread(user, campaignThreadKey(campaignId));
}

/* ------------------------------------------------------------------ */
/* GET /api/messages/campaign/:campaignId — history (newest first)     */
/* Query: ?limit=50&before=<ISO date or message id>                    */
/* ------------------------------------------------------------------ */
router.get("/campaign/:campaignId", auth, async (req: any, res) => {
    try {
        const { campaignId } = req.params;
        if (!(await assertCampaignAccess(req.user, campaignId))) {
            return res.status(403).json({ error: "Not a member of this campaign" });
        }

        const limit = Math.min(Number(req.query.limit) || 50, 200);
        const query: any = { campaign: campaignId };
        if (req.query.before) {
            const before = String(req.query.before);
            query.createdAt = {
                $lt: isUuid(before)
                    ? (await Message.findById(before).select("createdAt"))?.createdAt ?? new Date()
                    : new Date(before),
            };
        }

        const messages = await Message.find(query).sort({ createdAt: -1 }).limit(limit);
        res.json(messages);
    } catch (err: any) {
        console.error("[messages] history error:", err);
        res.status(500).json({ error: "Failed to fetch messages", details: err.message });
    }
});

/* ------------------------------------------------------------------ */
/* POST /api/messages/campaign/:campaignId — send a message            */
/* Body: { body: string, eventId?: string }                            */
/* ------------------------------------------------------------------ */
router.post("/campaign/:campaignId", auth, async (req: any, res) => {
    try {
        const { campaignId } = req.params;
        const { body, eventId } = req.body as { body?: string; eventId?: string };

        if (!body?.trim()) return res.status(400).json({ error: "body is required" });
        if (!(await assertCampaignAccess(req.user, campaignId))) {
            return res.status(403).json({ error: "Not a member of this campaign" });
        }

        // Senders may be Users, Leads, Contacts, or Accounts — always display
        // the handle (or name), never the email address.
        const sender = await findPersonById(req.user.id, "name firstName lastName handle email");
        const senderName = sender ? personDisplayName(sender.doc) : String(req.user.email).split("@")[0];

        const message = await Message.create({
            campaign: campaignId,
            event: eventId && isUuid(eventId) ? eventId : undefined,
            sender: { id: req.user.id, name: senderName, email: req.user.email },
            body: body.trim(),
        });

        await bus.publish("gamenight.message", {
            messageId: String(message._id),
            campaignId,
            eventId: message.event ? String(message.event) : undefined,
            sender: message.sender as any,
            body: message.body,
            createdAt: message.createdAt.toISOString(),
        });

        // Bell notifications for the other party members — best-effort, off
        // the request path so chat latency stays flat.
        notifyCampaignMembers(campaignId, req.user.id, senderName, body.trim()).catch(() => { /* logged inside */ });

        res.status(201).json(message);
    } catch (err: any) {
        console.error("[messages] send error:", err);
        res.status(500).json({ error: "Failed to send message", details: err.message });
    }
});

/** One bell entry per campaign per member, collapsing while unread. */
async function notifyCampaignMembers(campaignId: string, senderId: string, senderName: string, body: string) {
    try {
        const [campaign, peopleIds] = await Promise.all([
            Campaign.findById(campaignId).select("title"),
            findCampaignPeopleIds(campaignId),
        ]);
        const preview = body.length > 80 ? `${body.slice(0, 77)}...` : body;
        await Promise.all(
            peopleIds
                .filter(id => id !== String(senderId))
                .map(id => notify(id, {
                    type: "message",
                    title: `New message in "${campaign?.title || 'a campaign'}"`,
                    body: `${senderName}: ${preview}`,
                    link: `/game-night/campaigns/${campaignId}`,
                    sourceKey: campaignThreadKey(campaignId),
                    meta: { campaignId },
                }))
        );
    } catch (err: any) {
        console.error("[messages] campaign notify failed:", err.message);
    }
}

/* ================================================================== */
/* Direct messages                                                     */
/* ================================================================== */

/** DMs are friends-only (Threads owns the rule); returns the canonical dmKey or null. */
async function assertDmAccess(userId: string, otherUserId: string): Promise<string | null> {
    if (!(await canAccessThread({ id: userId }, dmThreadKey(userId, otherUserId)))) return null;
    return dmKeyFor(userId, otherUserId);
}

/* ------------------------------------------------------------------ */
/* GET /api/messages/dm/:userId — history (newest first)               */
/* Query: ?limit=50&before=<ISO date or message id>                    */
/* ------------------------------------------------------------------ */
router.get("/dm/:userId", auth, async (req: any, res) => {
    try {
        const key = await assertDmAccess(req.user.id, req.params.userId);
        if (!key) return res.status(403).json({ error: "You can only message friends" });

        const limit = Math.min(Number(req.query.limit) || 50, 200);
        const query: any = { dmKey: key };
        if (req.query.before) {
            const before = String(req.query.before);
            query.createdAt = {
                $lt: isUuid(before)
                    ? (await Message.findById(before).select("createdAt"))?.createdAt ?? new Date()
                    : new Date(before),
            };
        }

        const messages = await Message.find(query).sort({ createdAt: -1 }).limit(limit);
        res.json(messages);
    } catch (err: any) {
        console.error("[messages] dm history error:", err);
        res.status(500).json({ error: "Failed to fetch messages", details: err.message });
    }
});

/* ------------------------------------------------------------------ */
/* POST /api/messages/dm/:userId — send a direct message               */
/* Body: { body: string }                                              */
/* ------------------------------------------------------------------ */
router.post("/dm/:userId", auth, async (req: any, res) => {
    try {
        const { body } = req.body as { body?: string };
        if (!body?.trim()) return res.status(400).json({ error: "body is required" });

        const otherUserId = req.params.userId;
        const key = await assertDmAccess(req.user.id, otherUserId);
        if (!key) return res.status(403).json({ error: "You can only message friends" });

        const sender = await findPersonById(req.user.id, "name firstName lastName handle email");
        const senderName = sender ? personDisplayName(sender.doc) : String(req.user.email).split("@")[0];

        const message = await Message.create({
            dmKey: key,
            recipient: String(otherUserId),
            sender: { id: req.user.id, name: senderName, email: req.user.email },
            body: body.trim(),
        });

        await bus.publish("social.dm", {
            messageId: String(message._id),
            dmKey: key,
            recipientId: String(otherUserId),
            sender: message.sender as any,
            body: message.body,
            createdAt: message.createdAt.toISOString(),
        });

        const preview = message.body.length > 80 ? `${message.body.slice(0, 77)}...` : message.body;
        notify(otherUserId, {
            type: "message",
            title: `New message from @${senderName}`,
            body: preview,
            // Collapses per thread key, the same key the Letters list uses.
            sourceKey: dmThreadKey(req.user.id, otherUserId),
            meta: { fromUserId: req.user.id },
        }).catch(() => { /* logged inside */ });

        res.status(201).json(message);
    } catch (err: any) {
        console.error("[messages] dm send error:", err);
        res.status(500).json({ error: "Failed to send message", details: err.message });
    }
});

export default router;
