import express from "express";
const router = express.Router();
import Account from "../models/Account.js";
import Lead from "../models/Lead.js";
import jwt from "jsonwebtoken";

// JWT Authentication Middleware
const authenticateJWT = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "Unauthorized: Missing or invalid token" });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    const jwtSecret = process.env.JWT_SECRET || "your-secret-key-change-this";

    try {
        jwt.verify(token, jwtSecret);
        next();
    } catch (error) {
        return res.status(403).json({ error: "Forbidden: Invalid token" });
    }
};

// Allow either JWT or API Key for server-to-server syncs
const authenticateSync = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const apiKey = req.headers['x-api-key'];
    const validApiKey = process.env.SYNC_API_KEY;

    if (apiKey && validApiKey && apiKey === validApiKey) {
        return next();
    }

    // Fallback to JWT authentication
    return authenticateJWT(req, res, next);
};

// Bulk sync endpoint for Salesforce batch job
router.post("/sync", authenticateSync, async (req, res) => {
    try {
        const accounts = req.body.accounts;

        if (!Array.isArray(accounts)) {
            return res.status(400).json({ error: "Invalid request: 'accounts' must be an array" });
        }

        const results = {
            success: 0,
            failed: 0,
            errors: [] as any[]
        };

        for (const accountData of accounts) {
            try {
                // Determine identifiers
                const sfID = accountData.sfID;
                const email = accountData.email || "";
                const name = accountData.name || "";

                // 1. Check if Account already exists (by Salesforce ID OR Email)
                let existingAccount = null;
                if (sfID) {
                    existingAccount = await Account.findOne({ sfID: sfID });
                }
                if (!existingAccount && email) {
                    existingAccount = await Account.findOne({ email: email });
                }

                if (existingAccount) {
                    // Update existing account with latest Salesforce info (don't create new record)
                    existingAccount.name = name;
                    existingAccount.industry = accountData.industry;
                    existingAccount.website = accountData.website;
                    existingAccount.phone = accountData.phone;
                    existingAccount.address = accountData.address;
                    existingAccount.sfID = sfID;
                    existingAccount.sfRecordTypeID = accountData.sfRecordTypeID;
                    existingAccount.sfRecordTypeName = accountData.sfRecordTypeName;
                    
                    if (email && !existingAccount.email) {
                        existingAccount.email = email;
                    }

                    await existingAccount.save();
                    results.success++;
                    continue;
                }

                // 2. If NO account exists, check for a matching Lead by first/last name and email
                let parsedFirstName = accountData.firstName || "";
                let parsedLastName = accountData.lastName || "";
                
                if (!parsedFirstName && !parsedLastName && name) {
                    const nameParts = name.trim().split(/\s+/);
                    parsedFirstName = nameParts[0] || "";
                    parsedLastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "";
                }

                const leadMatch = await Lead.findOne({
                    email: email,
                    firstName: parsedFirstName,
                    lastName: parsedLastName
                });

                let migratedPassword = null;
                if (leadMatch) {
                    console.info(`Found matching Lead for ${email} (${parsedFirstName} ${parsedLastName}). Migrating password...`);
                    migratedPassword = leadMatch.password;
                    // Delete the old lead as it's now being converted
                    await Lead.deleteOne({ _id: leadMatch._id });
                }

                // 3. Create the new Account
                const newAccount = new Account({
                    name: name,
                    email: email,
                    password: migratedPassword, // Inherits existing hashed password if Lead was found
                    industry: accountData.industry,
                    website: accountData.website,
                    phone: accountData.phone,
                    address: accountData.address,
                    sfID: sfID,
                    sfRecordTypeID: accountData.sfRecordTypeID,
                    sfRecordTypeName: accountData.sfRecordTypeName
                });

                await newAccount.save();
                results.success++;
            } catch (error: any) {
                results.failed++;
                results.errors.push({
                    sfID: accountData.sfID,
                    error: error.message
                });
            }
        }

        res.status(200).json({
            message: "Sync completed",
            results
        });
    } catch (error: any) {
        console.error("Error syncing accounts:", error);
        res.status(500).json({ error: "Failed to sync accounts", details: error.message });
    }
});

// Get all accounts
router.get("/", async (req, res) => {
    try {
        const accounts = await Account.find().sort({ createdAt: -1 });
        res.json(accounts);
    } catch (error: any) {
        console.error("Error fetching accounts:", error);
        res.status(500).json({ error: "Failed to fetch accounts", details: error.message });
    }
});

// Get a specific account
router.get("/:id", async (req, res) => {
    try {
        const account = await Account.findById(req.params.id);
        if (!account) {
            return res.status(404).json({ error: "Account not found" });
        }
        res.json(account);
    } catch (error: any) {
        console.error("Error fetching account:", error);
        res.status(500).json({ error: "Failed to fetch account", details: error.message });
    }
});

export default router;
