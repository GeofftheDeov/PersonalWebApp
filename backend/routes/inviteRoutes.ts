import express from "express";
import mongoose from "mongoose";
import Campaign from "../models/Campaign.js";
import CampaignInvite from "../models/CampaignInvite.js";
import CampaignMember from "../models/CampaignMember.js";
import User from "../models/User.js";
import { auth } from "../middleware/auth.js";
import { getAuthorizedCampaignIds } from "../utils/gameNightPlannerUtils.js";
import { notify, resolveNotifications } from "../utils/notify.js";

const router = express.Router();

/* ------------------------------------------------------------------ */
/* POST /api/campaign-invites — invite a friend to a campaign          */
/* Body: { campaignId, toUserId }                                      */
/* ------------------------------------------------------------------ */
router.post("/", auth, async (req: any, res) => {
    try {
        const { campaignId, toUserId } = req.body;
        if (!mongoose.Types.ObjectId.isValid(campaignId) || !mongoose.Types.ObjectId.isValid(toUserId)) {
            return res.status(400).json({ error: "campaignId and toUserId are required" });
        }

        // Inviter must be a member of (or admin over) the campaign.
        const authorized = await getAuthorizedCampaignIds(req.user);
        if (authorized && !authorized.some((id: any) => String(id) === String(campaignId))) {
            return res.status(403).json({ error: "Not a member of this campaign" });
        }

        const campaign = await Campaign.findById(campaignId);
        if (!campaign) return res.status(404).json({ error: "Campaign not found" });

        // Invites go friend-to-friend (the UI offers your friends list).
        const me = await User.findById(req.user.id).select("name handle friends");
        if (!me?.friends?.some((f: any) => String(f) === String(toUserId))) {
            return res.status(400).json({ error: "You can only invite friends" });
        }

        const invitee = await User.findById(toUserId).select("email");
        if (!invitee) return res.status(404).json({ error: "User not found" });

        if (invitee.email) {
            const existingMember = await CampaignMember.findOne({ campaign: campaignId, email: invitee.email });
            if (existingMember) return res.status(409).json({ error: "Already a member of this campaign" });
        }

        const existingInvite = await CampaignInvite.findOne({ campaign: campaignId, to: toUserId, status: "pending" });
        if (existingInvite) return res.status(409).json({ error: "Invite already pending" });

        const invite = await CampaignInvite.create({ campaign: campaignId, from: req.user.id, to: toUserId });

        const inviterName = me.handle || me.name || req.user.email;
        await notify(toUserId, {
            type: "campaign_invite",
            title: `@${inviterName} invited you to "${campaign.title}"`,
            body: campaign.description || undefined,
            sourceKey: `invite:${invite._id}`,
            meta: { inviteId: String(invite._id), campaignId: String(campaignId) },
        });

        res.status(201).json({ message: "Invite sent", invite });
    } catch (err: any) {
        console.error("[invites] create error:", err);
        res.status(500).json({ error: "Failed to send invite", details: err.message });
    }
});

/* ------------------------------------------------------------------ */
/* GET /api/campaign-invites/mine — my pending invites                 */
/* ------------------------------------------------------------------ */
router.get("/mine", auth, async (req: any, res) => {
    try {
        const invites = await CampaignInvite.find({ to: req.user.id, status: "pending" })
            .populate("campaign", "title description status")
            .populate("from", "name handle userNumber")
            .sort({ createdAt: -1 });
        res.json(invites);
    } catch (err: any) {
        console.error("[invites] mine error:", err);
        res.status(500).json({ error: "Failed to fetch invites", details: err.message });
    }
});

/* ------------------------------------------------------------------ */
/* PUT /api/campaign-invites/:id/respond — accept or decline           */
/* Body: { action: "accept" | "decline" }                              */
/* ------------------------------------------------------------------ */
router.put("/:id/respond", auth, async (req: any, res) => {
    try {
        const { action } = req.body as { action?: string };
        if (action !== "accept" && action !== "decline") {
            return res.status(400).json({ error: "action must be 'accept' or 'decline'" });
        }

        const invite = await CampaignInvite.findById(req.params.id).populate("campaign", "title");
        if (!invite || String(invite.to) !== String(req.user.id)) {
            return res.status(404).json({ error: "Invite not found or unauthorized" });
        }
        if (invite.status !== "pending") {
            return res.status(409).json({ error: `Invite already ${invite.status}` });
        }

        const campaignDoc = invite.campaign as any;
        const campaignId = String(campaignDoc?._id ?? campaignDoc);
        const campaignTitle = campaignDoc?.title || "a campaign";
        const me = await User.findById(req.user.id).select("name handle email");
        const myName = me?.handle || me?.name || req.user.email;

        if (action === "accept") {
            // Same membership shape as the join-link flow (User branch).
            const existing = await CampaignMember.findOne({ campaign: campaignId, email: req.user.email });
            if (!existing) {
                await new CampaignMember({
                    campaign: campaignId,
                    email: req.user.email,
                    status: "Player",
                    joinedAt: new Date(),
                    firstName: me?.name || undefined,
                }).save();
            }
            invite.status = "accepted";
        } else {
            invite.status = "declined";
        }
        await invite.save();

        // Clear the invitee's bell entry and tell the inviter what happened.
        await resolveNotifications(req.user.id, `invite:${invite._id}`);
        await notify(invite.from, {
            type: "system",
            title: `@${myName} ${invite.status} your invite to "${campaignTitle}"`,
            link: invite.status === "accepted" ? `/game-night/campaigns/${campaignId}` : undefined,
        });

        res.json({ message: `Invite ${invite.status}`, invite });
    } catch (err: any) {
        console.error("[invites] respond error:", err);
        res.status(500).json({ error: "Failed to respond to invite", details: err.message });
    }
});

export default router;
