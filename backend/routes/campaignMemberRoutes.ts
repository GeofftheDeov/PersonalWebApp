import express from "express";
const router = express.Router();
import CampaignMember from "../models/CampaignMember.js";
import { auth } from "../middleware/auth.js";

// Get all campaign members
router.get("/", auth, async (req, res) => {
    try {
        const members = await CampaignMember.find()
            .populate("campaign")
            .populate("lead")
            .populate("contact")
            .populate("account")
            .sort({ createdAt: -1 });
        res.json(members);
    } catch (error: any) {
        console.error("Error fetching campaign members:", error);
        res.status(500).json({ error: "Failed to fetch campaign members", details: error.message });
    }
});

// Get a specific campaign member
router.get("/:id", auth, async (req, res) => {
    try {
        const member = await CampaignMember.findById(req.params.id)
            .populate("campaign")
            .populate("lead")
            .populate("contact")
            .populate("account");
        if (!member) {
            return res.status(404).json({ error: "Campaign member not found" });
        }
        res.json(member);
    } catch (error: any) {
        console.error("Error fetching campaign member:", error);
        res.status(500).json({ error: "Failed to fetch campaign member", details: error.message });
    }
});

// Create a new campaign member
router.post("/", auth, async (req, res) => {
    try {
        const { campaign, lead, contact, account, status, joinedAt, firstName, lastName, email, phone } = req.body;
        
        if (!campaign) {
            return res.status(400).json({ error: "Campaign reference is required" });
        }
        
        const member = new CampaignMember({ 
            campaign, 
            lead, 
            contact, 
            account, 
            status, 
            joinedAt: joinedAt || new Date(),
            firstName,
            lastName,
            email,
            phone
        });
        
        await member.save();
        res.status(201).json({ message: "Campaign member created successfully!", member });
    } catch (error: any) {
        console.error("Error creating campaign member:", error);
        res.status(500).json({ error: "Failed to create campaign member", details: error.message });
    }
});

// Update a campaign member
router.put("/:id", auth, async (req, res) => {
    try {
        const updatedMember = await CampaignMember.findByIdAndUpdate(
            req.params.id,
            { $set: req.body },
            { new: true }
        );
        if (!updatedMember) {
            return res.status(404).json({ error: "Campaign member not found" });
        }
        res.json({ message: "Campaign member updated successfully", member: updatedMember });
    } catch (error: any) {
        console.error("Error updating campaign member:", error);
        res.status(500).json({ error: "Failed to update campaign member", details: error.message });
    }
});

// Delete a campaign member
router.delete("/:id", auth, async (req, res) => {
    try {
        const deletedMember = await CampaignMember.findByIdAndDelete(req.params.id);
        if (!deletedMember) {
            return res.status(404).json({ error: "Campaign member not found" });
        }
        res.json({ message: "Campaign member deleted successfully" });
    } catch (error: any) {
        console.error("Error deleting campaign member:", error);
        res.status(500).json({ error: "Failed to delete campaign member", details: error.message });
    }
});

export default router;
