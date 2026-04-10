import express from "express";
const router = express.Router();
import Campaign from "../models/Campaign.js";
import CampaignMember from "../models/CampaignMember.js";
import Session from "../models/Session.js";
import { auth } from "../middleware/auth.js";
import { getAuthorizedCampaignIds } from "../utils/gameNightPlannerUtils.js";

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
        const memberFields: any = {
            campaign: campaign._id,
            email: req.user.email,
            status: "Game Master",
            joinedAt: new Date(),
        };
        if (req.user.type === "Lead") memberFields.lead = req.user.id;
        else if (req.user.type === "Contact") memberFields.contact = req.user.id;
        else if (req.user.type === "Account") memberFields.account = req.user.id;
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
        const { title, description, status, startDate, endDate } = req.body;
        const campaign = await Campaign.findByIdAndUpdate(
            req.params.id,
            { title, description, status, startDate, endDate },
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

// Get members (players) for a specific campaign
router.get("/:id/members", auth, async (req: any, res) => {
    try {
        const campaignIds = await getAuthorizedCampaignIds(req.user);
        if (campaignIds && !campaignIds.some((cid: any) => cid.toString() === req.params.id)) {
            return res.status(403).json({ error: "Unauthorized" });
        }
        const members = await CampaignMember.find({ campaign: req.params.id }).sort({ joinedAt: 1 });
        res.json(members);
    } catch (error: any) {
        console.error("Error fetching campaign members:", error);
        res.status(500).json({ error: "Failed to fetch members", details: error.message });
    }
});

export default router;
