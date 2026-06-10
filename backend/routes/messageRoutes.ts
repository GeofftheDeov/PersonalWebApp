import express, { Response } from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import Message from "../models/Message.js";
import User from "../models/User.js";
import CampaignMember from "../models/CampaignMember.js";
import Campaign from "../models/Campaign.js";
import { auth } from "../middleware/auth.js";
import { getAuthorizedCampaignIds } from "../utils/gameNightPlannerUtils.js";
import { bus } from "../events/index.js";
import { notify } from "../utils/notify.js";

const router = express.Router();

/* ------------------------------------------------------------------ */
/* SSE hubs: channel key → set of open SSE responses. Campaign chat    */
/* keys are campaign ids; DMs use the sorted-id dmKey. Fed by the      */
/* event bus, so it works identically whether the message was posted   */
/* by this process or (later) another service on the bus.              */
/* ------------------------------------------------------------------ */
const sseClients = new Map<string, Set<Response>>();
const dmClients = new Map<string, Set<Response>>();

function fanOut(map: Map<string, Set<Response>>, key: string, payload: unknown) {
    const clients = map.get(key);
    if (!clients?.size) return;
    const frame = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) {
        try {
            res.write(frame);
        } catch {
            clients.delete(res);
        }
    }
}

bus.subscribe("gamenight.message", (payload) => fanOut(sseClients, payload.campaignId, payload));
bus.subscribe("social.dm", (payload) => fanOut(dmClients, payload.dmKey, payload));

/** Canonical DM channel key: both participant ids, sorted. */
const dmKeyFor = (a: string, b: string) => [String(a), String(b)].sort().join(":");

/** Shared SSE plumbing: headers, registration, heartbeat, cleanup. */
function openSse(map: Map<string, Set<Response>>, key: string, res: Response, label: string) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    (res as any).flushHeaders?.();

    res.write(`event: connected\ndata: ${JSON.stringify({ channel: key })}\n\n`);

    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(res);
    console.log(`[messages] SSE open — ${label}=${key} clients=${map.get(key)!.size}`);

    const heartbeat = setInterval(() => {
        try {
            res.write(": ping\n\n");
        } catch {
            /* socket closed; cleanup below */
        }
    }, 15_000);

    res.on("close", () => {
        clearInterval(heartbeat);
        const clients = map.get(key);
        clients?.delete(res);
        if (clients && clients.size === 0) map.delete(key);
        console.log(`[messages] SSE closed — ${label}=${key}`);
    });
}

/** Manual auth for SSE endpoints (EventSource can't set headers): header OR ?token=. */
function sseAuth(req: any, res: Response): boolean {
    const headerToken = req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.split(" ")[1]
        : undefined;
    const token = headerToken || (req.query.token as string | undefined);
    if (!token) {
        res.status(401).json({ error: "Unauthorized: No token provided" });
        return false;
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || "your-secret-key-change-this") as any;
        req.user = { id: decoded.id, email: decoded.email, type: decoded.type };
        return true;
    } catch {
        res.status(401).json({ error: "Unauthorized: Invalid token" });
        return false;
    }
}

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
        const [campaign, members] = await Promise.all([
            Campaign.findById(campaignId).select("title"),
            CampaignMember.find({ campaign: campaignId }).select("email"),
        ]);
        const emails = [...new Set(members.map(m => m.email).filter((e): e is string => Boolean(e)))];
        if (!emails.length) return;
        const users = await User.find({ email: { $in: emails } }).select("_id");
        const preview = body.length > 80 ? `${body.slice(0, 77)}...` : body;
        await Promise.all(
            users
                .filter(u => String(u._id) !== String(senderId))
                .map(u => notify(u._id, {
                    type: "message",
                    title: `New message in "${campaign?.title || 'a campaign'}"`,
                    body: `${senderName}: ${preview}`,
                    link: `/game-night/campaigns/${campaignId}`,
                    sourceKey: `campaign:${campaignId}`,
                    meta: { campaignId },
                }))
        );
    } catch (err: any) {
        console.error("[messages] campaign notify failed:", err.message);
    }
}

/* ------------------------------------------------------------------ */
/* GET /api/messages/campaign/:campaignId/stream — SSE live feed       */
/* EventSource can't set headers, so this endpoint also accepts        */
/* ?token=<jwt> (same pattern as the admin UI's query-param token).    */
/* ------------------------------------------------------------------ */
router.get("/campaign/:campaignId/stream", async (req: any, res) => {
    if (!sseAuth(req, res)) return;

    const { campaignId } = req.params;
    if (!(await assertCampaignAccess(req.user, campaignId))) {
        return res.status(403).json({ error: "Not a member of this campaign" });
    }

    openSse(sseClients, campaignId, res, "campaign");
});

/* ================================================================== */
/* Direct messages                                                     */
/* ================================================================== */

/** DMs are friends-only; returns the canonical dmKey or null. */
async function assertDmAccess(userId: string, otherUserId: string): Promise<string | null> {
    if (!mongoose.Types.ObjectId.isValid(otherUserId) || String(otherUserId) === String(userId)) return null;
    const me = await User.findById(userId).select("friends");
    if (!me?.friends?.some((f: any) => String(f) === String(otherUserId))) return null;
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
                $lt: mongoose.Types.ObjectId.isValid(before)
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

        const dbUser = await User.findById(req.user.id).select("name handle email");
        const senderName = dbUser?.handle || dbUser?.name || req.user.email;

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
            sourceKey: `dm:${req.user.id}`,
            meta: { fromUserId: req.user.id },
        }).catch(() => { /* logged inside */ });

        res.status(201).json(message);
    } catch (err: any) {
        console.error("[messages] dm send error:", err);
        res.status(500).json({ error: "Failed to send message", details: err.message });
    }
});

/* ------------------------------------------------------------------ */
/* GET /api/messages/dm/:userId/stream — SSE live feed (?token= ok)    */
/* ------------------------------------------------------------------ */
router.get("/dm/:userId/stream", async (req: any, res) => {
    if (!sseAuth(req, res)) return;

    const key = await assertDmAccess(req.user.id, req.params.userId);
    if (!key) return res.status(403).json({ error: "You can only message friends" });

    openSse(dmClients, key, res, "dm");
});

export default router;
