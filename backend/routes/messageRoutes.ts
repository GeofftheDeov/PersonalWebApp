import express, { Response } from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import Message from "../models/Message.js";
import User from "../models/User.js";
import { auth } from "../middleware/auth.js";
import { getAuthorizedCampaignIds } from "../utils/gameNightPlannerUtils.js";
import { bus } from "../events/index.js";

const router = express.Router();

/* ------------------------------------------------------------------ */
/* SSE hub: campaignId → set of open SSE responses.                    */
/* Fed by the event bus, so it works identically whether the message   */
/* was posted by this process or (later) another service on the bus.   */
/* ------------------------------------------------------------------ */
const sseClients = new Map<string, Set<Response>>();

bus.subscribe("gamenight.message", (payload) => {
    const clients = sseClients.get(payload.campaignId);
    if (!clients?.size) return;
    const frame = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) {
        try {
            res.write(frame);
        } catch {
            clients.delete(res);
        }
    }
});

/** Auth check on the campaign, shared by all three endpoints. */
async function assertCampaignAccess(user: any, campaignId: string): Promise<boolean> {
    if (!mongoose.Types.ObjectId.isValid(campaignId)) return false;
    const authorized = await getAuthorizedCampaignIds(user);
    if (authorized === null) return true; // admin
    return authorized.some((id: any) => String(id) === String(campaignId));
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
                $lt: mongoose.Types.ObjectId.isValid(before)
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

        const dbUser = await User.findById(req.user.id).select("name handle email");
        const senderName = dbUser?.handle || dbUser?.name || req.user.email;

        const message = await Message.create({
            campaign: campaignId,
            event: eventId && mongoose.Types.ObjectId.isValid(eventId) ? eventId : undefined,
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

        res.status(201).json(message);
    } catch (err: any) {
        console.error("[messages] send error:", err);
        res.status(500).json({ error: "Failed to send message", details: err.message });
    }
});

/* ------------------------------------------------------------------ */
/* GET /api/messages/campaign/:campaignId/stream — SSE live feed       */
/* EventSource can't set headers, so this endpoint also accepts        */
/* ?token=<jwt> (same pattern as the admin UI's query-param token).    */
/* ------------------------------------------------------------------ */
router.get("/campaign/:campaignId/stream", async (req: any, res) => {
    // Manual auth: Authorization header OR ?token= query param.
    const headerToken = req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.split(" ")[1]
        : undefined;
    const token = headerToken || (req.query.token as string | undefined);
    if (!token) return res.status(401).json({ error: "Unauthorized: No token provided" });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || "your-secret-key-change-this") as any;
        req.user = { id: decoded.id, email: decoded.email, type: decoded.type };
    } catch {
        return res.status(401).json({ error: "Unauthorized: Invalid token" });
    }

    const { campaignId } = req.params;
    if (!(await assertCampaignAccess(req.user, campaignId))) {
        return res.status(403).json({ error: "Not a member of this campaign" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    (res as any).flushHeaders?.();

    res.write(`event: connected\ndata: ${JSON.stringify({ campaignId })}\n\n`);

    if (!sseClients.has(campaignId)) sseClients.set(campaignId, new Set());
    sseClients.get(campaignId)!.add(res);
    console.log(`[messages] SSE open — campaign=${campaignId} clients=${sseClients.get(campaignId)!.size}`);

    const heartbeat = setInterval(() => {
        try {
            res.write(": ping\n\n");
        } catch {
            /* socket closed; cleanup below */
        }
    }, 15_000);

    res.on("close", () => {
        clearInterval(heartbeat);
        const clients = sseClients.get(campaignId);
        clients?.delete(res);
        if (clients && clients.size === 0) sseClients.delete(campaignId);
        console.log(`[messages] SSE closed — campaign=${campaignId}`);
    });
});

export default router;
