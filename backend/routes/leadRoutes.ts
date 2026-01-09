import express from "express";
const router = express.Router();
import Lead from "../models/Lead.js";

import bcrypt from "bcryptjs";

// Create a new lead
router.post("/", async (req, res) => {
    try {
        const { firstName, lastName, email, password, company, phone } = req.body;
        
        // Validation
        if (!firstName || !lastName || !email || !password) {
            return res.status(400).json({ 
                error: "Missing required fields: firstName, lastName, email, password" 
            });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const lead = new Lead({ 
            firstName, 
            lastName, 
            email, 
            password: hashedPassword,
            company, 
            phone,
            status: "New",
            source: "Web App"
        });
        
        await lead.save();
        
        res.status(201).json({ 
            message: "Lead created successfully!",
            lead: {
                id: lead._id,
                firstName: lead.firstName,
                lastName: lead.lastName,
                email: lead.email,
                company: lead.company,
                phone: lead.phone,
                status: lead.status
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
        const leads = await Lead.find().sort({ createdAt: -1 });
        res.json(leads);
    } catch (error: any) {
        console.error("Error fetching leads:", error);
        res.status(500).json({ error: "Failed to fetch leads", details: error.message });
    }
});

// Get a specific lead
router.get("/:id", async (req, res) => {
    try {
        const lead = await Lead.findById(req.params.id);
        if (!lead) {
            return res.status(404).json({ error: "Lead not found" });
        }
        res.json(lead);
    } catch (error: any) {
        console.error("Error fetching lead:", error);
        res.status(500).json({ error: "Failed to fetch lead", details: error.message });
    }
});

export default router;
