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
        if (!firstName || !lastName || (!email && !phone) || !password) {
            console.warn("!!! [BACKEND/LEADS] Validation failed: Missing required fields");
            return res.status(400).json({ 
                error: "Missing required fields: firstName, lastName, (email OR phone), password" 
            });
        }
        
        const isDev = process.env.NODE_ENV === "development" || req.headers.host?.includes("localhost");
        const token = isDev ? undefined : crypto.randomBytes(20).toString("hex");
        
        console.log(`>>> [BACKEND/LEADS] Saving lead to MongoDB (isDev=${isDev})...`);
        const lead = new Lead({ 
            firstName: firstName, 
            lastName: lastName, 
            email: email, 
            password: password,
            isVerified: isDev || !email, // Auto-verify if no email (phone verification skipped for now)
            emailVerificationToken: email ? token : undefined,
            company, 
            phone,
            status: "New",
            source: "Web App"
        });
        
        await lead.save();
        
        if (isDev) {
            console.log(">>> [BACKEND/LEADS] Dev mode: Skipping email verification.");
        } else if (email) {
            console.log(">>> [BACKEND/LEADS] Production: Sending verification email...");
            if (token) await sendVerificationEmail(email, token);
        } else {
            console.log(">>> [BACKEND/LEADS] Production: Phone-only registration, skipping verification for now.");
        }
        
        console.log(">>> [BACKEND/LEADS] Success! Sending response to client.");
        
        res.status(201).json({ 
            message: (isDev || !email) ? "Account created successfully!" : "Account created successfully! Please check your email to verify your account.",
            lead: {
                id: lead._id,
                email: lead.email,
                phone: lead.phone,
                status: lead.status,
                isVerified: lead.isVerified
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
