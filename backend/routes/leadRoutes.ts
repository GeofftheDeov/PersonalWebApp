import express from "express";
const router = express.Router();
import Account from "../models/Account.js";
import SfLead from "../models/SfLead.js";
import CampaignInvite from "../models/CampaignInvite.js";

import bcrypt from "bcryptjs";
import crypto from "crypto";
import { sendVerificationEmail } from "../services/emailService.js";

/**
 * Registration lives here, not in userRoutes (#35 and plan §3.2 both file it
 * under userRoutes; the endpoint the signup form actually posts to is
 * POST /api/leads).
 *
 * It used to create an sf_leads row whose postSave hook fired a Salesforce
 * create inside the request. Since Phase 3 it creates an `accounts` row with
 * sf_object = 'Lead' and sf_id NULL — the marker for "app-native, not yet in
 * the CRM" (§2.8) — and the nightly outbox drain creates the Salesforce Lead and
 * writes the id back. Nobody's signup waits on Salesforce being reachable.
 *
 * The listing handlers below still read the sf_leads landing table, which is
 * what they were always for.
 */
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
        
        const lead = new Account({
            firstName,
            lastName,
            name: [firstName, lastName].filter(Boolean).join(" "),
            email,
            password,
            isVerified: isDev || !email, // Auto-verify if no email (phone verification skipped for now)
            emailVerificationToken: email ? token : undefined,
            company,
            phone,
            leadStatus: "New",
            sfObject: "Lead",
        });

        await lead.save();

        // A Game Master may have invited this person by email before they had an
        // account (plan §3.5). Bind those now so the invites are waiting.
        if (email) {
            try {
                await CampaignInvite.updateMany(
                    { toEmail: email, to: null, status: "pending" },
                    { $set: { to: lead._id } },
                );
            } catch (err: any) {
                console.error("[INVITES] binding pending invites failed:", err.message);
            }
        }
        
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
                status: lead.leadStatus,
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
        const leads = await SfLead.find().sort({ createdAt: -1 });
        res.json(leads);
    } catch (error: any) {
        console.error("Error fetching leads:", error);
        res.status(500).json({ error: "Failed to fetch leads", details: error.message });
    }
});

// Get a specific lead
router.get("/:id", async (req, res) => {
    try {
        const lead = await SfLead.findById(req.params.id);
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
