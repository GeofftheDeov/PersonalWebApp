import express from "express";
const router = express.Router();
import Campaign from "../models/Campaign.js";
import CampaignMember from "../models/CampaignMember.js";
import Session from "../models/Session.js";
import Account from "../models/Account.js";
import { auth } from "../middleware/auth.js";
import { getAuthorizedCampaignIds } from "../utils/gameNightPlannerUtils.js";
import { personDisplayName } from "../utils/personUtils.js";

/**
 * Phase 3 (#35, plan §3.4). Auto-enrolment used to branch on req.user.type to
 * choose which of lead_id / contact_id / account_id to write — and the `else`
 * branch, the one a Salesforce User fell into, wrote NO person column at all,
 * only an email. That is why getAuthorizedCampaignIds had to OR over four
 * things including an unindexed email match, and why a Game Master could be the
 * member row with the least to identify them by. One person_id replaces it.
 */

/** Membership fields for the signed-in person. No branch, no email fallback. */
async function memberFieldsFor(user: any, campaignId: string, status: string) {
    const person = await Account.findById(user.id).select("name firstName lastName handle email");
    return {
        campaign: campaignId,
        person: user.id,
        email: person?.email ?? user.email,
        firstName: person?.firstName ?? personDisplayName(person),
        lastName: person?.lastName ?? undefined,
        status,
        joinedAt: new Date(),
    };
}

// Create a new campaign
router.post("/", auth, async (req: any, res) => {
    try {
        const { title, description, status, startDate, endDate } = req.body;

        // Validation
        if (!title || !description || !status || !startDate) {
            return res.status(400).json({
                error: "Missing required fields: title, description, status, startDate"
            });
        }

        const campaign = new Campaign({
            title,
            description,
            status,
            startDate,
            endDate,
        });
        await campaign.save();

        // Auto-enroll creator as Game Master
        const memberFields = await memberFieldsFor(req.user, campaign._id, "Game Master");
        await new CampaignMember(memberFields).save();

        res.status(201).json({
            message: "Campaign created successfully!",
            campaign: {
                id: campaign._id,
                title: campaign.title,
                description: campaign.description,
                status: campaign.status,
                startDate: campaign.startDate,
                endDate: campaign.endDate
            }
        });
    } catch (error: any) {
        console.error("Error creating campaign:", error);
        res.status(500).json({ error: "Failed to create campaign", details: error.message });
    }
});

// Get all campaigns
router.get("/", auth, async (req: any, res) => {
    try {
        const campaignIds = await getAuthorizedCampaignIds(req.user);
        const query = campaignIds ? { _id: { $in: campaignIds } } : {};

        const campaigns = await Campaign.find(query).sort({ startDate: -1 });
        res.json(campaigns);
    } catch (error: any) {
        console.error("Error fetching campaigns:", error);
        res.status(500).json({ error: "Failed to fetch campaigns", details: error.message });
    }
});

// Get a specific campaign
router.get("/:id", auth, async (req: any, res) => {
    try {
        const campaign = await Campaign.findById(req.params.id);
        if (!campaign) {
            return res.status(404).json({ error: "Campaign not found" });
        }
        res.json(campaign);
    } catch (error: any) {
        console.error("Error fetching campaign:", error);
        res.status(500).json({ error: "Failed to fetch campaign", details: error.message });
    }
});

// Update a campaign
router.put("/:id", auth, async (req: any, res) => {
    try {
        const campaignIds = await getAuthorizedCampaignIds(req.user);
        if (campaignIds && !campaignIds.some((cid: any) => cid.toString() === req.params.id)) {
            return res.status(403).json({ error: "Unauthorized" });
        }
        const { title, description, status, startDate, endDate, discordGuildId, discordChannelId } = req.body;
        const campaign = await Campaign.findByIdAndUpdate(
            req.params.id,
            { title, description, status, startDate, endDate, discordGuildId, discordChannelId },
            { new: true }
        );
        if (!campaign) return res.status(404).json({ error: "Campaign not found" });
        res.json(campaign);
    } catch (error: any) {
        console.error("Error updating campaign:", error);
        res.status(500).json({ error: "Failed to update campaign", details: error.message });
    }
});

// Get sessions for a specific campaign
router.get("/:id/sessions", auth, async (req: any, res) => {
    try {
        const campaignIds = await getAuthorizedCampaignIds(req.user);
        // Verify the user has access to this campaign
        if (campaignIds && !campaignIds.some((cid: any) => cid.toString() === req.params.id)) {
            return res.status(403).json({ error: "Unauthorized" });
        }
        const sessions = await Session.find({ campaign: req.params.id }).sort({ date: -1 });
        res.json(sessions);
    } catch (error: any) {
        console.error("Error fetching campaign sessions:", error);
        res.status(500).json({ error: "Failed to fetch sessions", details: error.message });
    }
});

// Join a campaign via invite link
router.post("/:id/join", auth, async (req: any, res) => {
    try {
        const campaign = await Campaign.findById(req.params.id);
        if (!campaign) return res.status(404).json({ error: "Campaign not found" });

        // Membership is keyed on the person, not their email. Matching on email
        // let the same person join twice under two different records.
        const existing = await CampaignMember.findOne({ campaign: req.params.id, person: req.user.id });
        if (existing) return res.status(409).json({ error: "Already a member of this campaign" });

        const memberFields = await memberFieldsFor(req.user, req.params.id, "Player");
        const member = await new CampaignMember(memberFields).save();
        res.status(201).json({ message: "Joined campaign successfully!", member });
    } catch (error: any) {
        console.error("Error joining campaign:", error);
        res.status(500).json({ error: "Failed to join campaign", details: error.message });
    }
});

// Get members (players) for a specific campaign
router.get("/:id/members", auth, async (req: any, res) => {
    try {
        const campaignIds = await getAuthorizedCampaignIds(req.user);
        if (campaignIds && !campaignIds.some((cid: any) => cid.toString() === req.params.id)) {
            return res.status(403).json({ error: "Unauthorized" });
        }
        const members = await CampaignMember.find({ campaign: req.params.id })
            .populate("person")
            .sort({ joinedAt: 1 });

        // playerId used to be assembled from whichever of three refs was set,
        // with an email lookup across four collections for the rows that had
        // none. Every member now has one.
        const enriched = members.map((m: any) => {
            const obj = m.toObject();
            obj.playerId = m.person?._id?.toString() ?? null;
            return obj;
        });
        res.json(enriched);
    } catch (error: any) {
        console.error("Error fetching campaign members:", error);
        res.status(500).json({ error: "Failed to fetch members", details: error.message });
    }
});

export default router;
