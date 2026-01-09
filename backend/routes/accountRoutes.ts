import express from "express";
const router = express.Router();
import Account from "../models/Account.js";
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

// Bulk sync endpoint for Salesforce batch job
router.post("/sync", authenticateJWT, async (req, res) => {
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
                // Upsert based on Salesforce ID
                await Account.findOneAndUpdate(
                    { sfID: accountData.sfID },
                    {
                        name: accountData.name,
                        industry: accountData.industry,
                        website: accountData.website,
                        phone: accountData.phone,
                        address: accountData.address,
                        sfID: accountData.sfID,
                        sfRecordTypeID: accountData.sfRecordTypeID,
                        sfRecordTypeName: accountData.sfRecordTypeName
                    },
                    { upsert: true, new: true }
                );
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
