import express from "express";
const router = express.Router();
import SfAccount from "../models/SfAccount.js";
import jwt from "jsonwebtoken";
import { recordPull } from "../jobs/personSync.js";

/**
 * Salesforce-facing routes over the sf_accounts LANDING table (#35).
 *
 * Until Phase 3 `models/SfAccount.ts` was this landing table; it is now the app's
 * unified person table, so these handlers use SfAccount/SfLead explicitly. The
 * app's own account data is never served from here.
 *
 * NOTE (not in #35): the two GET handlers below had no authentication at all —
 * `GET /api/accounts` returned every landing row, names, emails and phones
 * included, to anyone who asked. Same species as the campaignMemberRoutes leak
 * in plan §3.6, found while repointing the imports. They now require the same
 * credential the sync endpoint does.
 */

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
        const startedAt = new Date();
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

                // A landing row is found by its Salesforce Id, with an email
                // fallback only for a legacy row that never received one — see
                // routes/syncRoutes.ts for why matching mirrors on email is wrong.
                let existingAccount: any = sfID ? await SfAccount.findOne({ sfID }) : null;
                if (!existingAccount && email) {
                    existingAccount = await SfAccount.findOne({ email, sfID: null });
                }

                const fields = {
                    name,
                    industry: accountData.industry,
                    website: accountData.website,
                    phone: accountData.phone,
                    address: accountData.address,
                    sfID,
                    sfRecordTypeID: accountData.sfRecordTypeID,
                    sfRecordTypeName: accountData.sfRecordTypeName,
                };

                if (existingAccount) {
                    Object.assign(existingAccount, fields);
                    if (email && !existingAccount.email) existingAccount.email = email;
                    await existingAccount.save();
                } else {
                    // This used to look for a Lead with the same name and email, DELETE
                    // its landing row as "converted", and carry its password across.
                    // That is identity logic running inside a mirror: it destroyed a
                    // row the merge links to, and moved a credential through a table
                    // that no longer holds credentials. Conversion is now the merge's
                    // job — it links the new Account by email and promotes the person.
                    await SfAccount.create({ ...fields, email: email || undefined });
                }
                results.success++;
            } catch (error: any) {
                results.failed++;
                results.errors.push({
                    sfID: accountData.sfID,
                    error: error.message
                });
            }
        }

        // The merge reads the latest pull per object to know whether a change the
        // app pushed can have come back yet (jobs/personSync.ts).
        try {
            await recordPull("Account", startedAt, results, results.failed === 0,
                results.failed ? `${results.failed} record(s) failed` : undefined);
        } catch (err: any) {
            console.error("[SYNC] could not record the Account pull:", err.message);
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
router.get("/", authenticateSync, async (req, res) => {
    try {
        const accounts = await SfAccount.find().sort({ createdAt: -1 });
        res.json(accounts);
    } catch (error: any) {
        console.error("Error fetching accounts:", error);
        res.status(500).json({ error: "Failed to fetch accounts", details: error.message });
    }
});

// Get a specific account
router.get("/:id", authenticateSync, async (req, res) => {
    try {
        const account = await SfAccount.findById(req.params.id);
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
