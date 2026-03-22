import express from "express";
const router = express.Router();
import Lead from "../models/Lead.js";

import bcrypt from "bcryptjs";
import crypto from "crypto";
import { sendVerificationEmail } from "../services/emailService.js";

// Create a new lead
router.post("/", async (req, res) => {
    console.log("!!! [BACKEND/LEADS] RECEIVED REGISTRATION REQUEST:", JSON.stringify(req.body));
    try {
        const { firstName, lastName, email, password, company, phone } = req.body;
        
        // Validation
        if (!firstName || !lastName || !email || !password) {
            console.warn("!!! [BACKEND/LEADS] Validation failed: Missing required fields");
            return res.status(400).json({ 
                error: "Missing required fields: firstName, lastName, email, password" 
            });
        }
        
        const token = crypto.randomBytes(20).toString("hex");
        
        console.log(">>> [BACKEND/LEADS] Saving lead to MongoDB...");
        const lead = new Lead({ 
            firstName: firstName, 
            lastName: lastName, 
            email: email, 
            password: password,
            isVerified: false,
            emailVerificationToken: token,
            company, 
            phone,
            status: "New",
            source: "Web App"
        });
        
        await lead.save();
        console.log(">>> [BACKEND/LEADS] Lead saved. Sending verification email...");
        
        await sendVerificationEmail(email, token);
        console.log(">>> [BACKEND/LEADS] Success! Sending response to client.");
        
        res.status(201).json({ 
            message: "Lead created successfully! Please check your email to verify your account.",
            lead: {
                id: lead._id,
                email: lead.email,
                status: lead.status
            }
        });
    } catch (error: any) {
        console.error("!!! [BACKEND/LEADS] CRITICAL ERROR CREATING LEAD:", error);
        console.error("!!! Error stack:", error.stack);

        res.status(500).json({ 
            error: "Internal Server Error during account creation", 
            message: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
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
