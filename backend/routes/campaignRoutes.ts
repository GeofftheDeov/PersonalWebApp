import express from "express";
const router = express.Router();
import Campaign from "../models/Campaign.js";

import bcrypt from "bcryptjs";

// Create a new lead
router.post("/", async (req, res) => {
    try {
        const { title, description, status, startDate, endDate } = req.body;
        
        // Validation
        if (!title || !description || !status || !startDate || !endDate) {
            return res.status(400).json({ 
                error: "Missing required fields: title, description, status, startDate, endDate" 
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
        console.error("Error creating lead:", error);
        res.status(500).json({ error: "Failed to create lead", details: error.message });
    }
});

// Get all leads
router.get("/", async (req, res) => {
    try {
        const leads = await Campaign.find().sort({ startDate: -1 });
        res.json(leads);
    } catch (error: any) {
        console.error("Error fetching leads:", error);
        res.status(500).json({ error: "Failed to fetch leads", details: error.message });
    }
});

// Get a specific lead
router.get("/:id", async (req, res) => {
    try {
        const campaign = await Campaign.findById(req.params.id);
        if (!campaign) {
            return res.status(404).json({ error: "Campaign not found" });
        }
        res.json(campaign);
    } catch (error: any) {
        console.error("Error fetching lead:", error);
        res.status(500).json({ error: "Failed to fetch lead", details: error.message });
    }
});

export default router;
