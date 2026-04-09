import express from "express";
const router = express.Router();

import User from "../models/User.js";
import Lead from "../models/Lead.js";
import Contact from "../models/Contact.js";
import Account from "../models/Account.js";
import Campaign from "../models/Campaign.js";
import Session from "../models/Session.js";
import Character from "../models/Character.js";
import Dungeon from "../models/Dungeon.js";

// ─────────────────────────────────────────────
// API Key Auth Middleware (server-to-server only)
// ─────────────────────────────────────────────
const authenticateSync = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const apiKey = req.headers["x-api-key"];
    const validApiKey = process.env.SYNC_API_KEY;

    if (!validApiKey) {
        return res.status(500).json({ error: "SYNC_API_KEY is not configured on the server." });
    }
    if (!apiKey || apiKey !== validApiKey) {
        return res.status(401).json({ error: "Unauthorized: Invalid or missing X-API-Key header." });
    }
    return next();
};

// ─────────────────────────────────────────────
// Helper: standard sync result tracker
// ─────────────────────────────────────────────
const makeResults = () => ({ success: 0, updated: 0, failed: 0, errors: [] as any[] });

// ─────────────────────────────────────────────
// POST /api/sync/users
// Payload: { users: [{ sfID, name, email, phone, role, userNumber }] }
// ─────────────────────────────────────────────
router.post("/users", authenticateSync, async (req, res) => {
    try {
        const { users } = req.body;
        if (!Array.isArray(users)) return res.status(400).json({ error: "'users' must be an array" });

        const results = makeResults();

        for (const u of users) {
            try {
                const existing = await User.findOne({
                    $or: [
                        ...(u.sfID ? [{ sfID: u.sfID }] : []),
                        ...(u.email ? [{ email: u.email }] : []),
                    ]
                }) as any;

                if (existing) {
                    // Update non-auth fields only — never overwrite hashed password from SF
                    existing.name = u.name || existing.name;
                    existing.phone = u.phone || existing.phone;
                    existing.role = u.role || existing.role;
                    existing.userNumber = u.userNumber || existing.userNumber;
                    if (u.sfID) existing.sfID = u.sfID;
                    existing.updatedAt = new Date();
                    await existing.save();
                    results.updated++;
                } else {
                    // Create new user — password will be hashed by pre-save hook
                    const tempPassword = u.password || `SF_IMPORT_${u.sfID || Date.now()}`;
                    await User.create({
                        name: u.name,
                        email: u.email,
                        phone: u.phone,
                        role: u.role || "user",
                        userNumber: u.userNumber,
                        sfID: u.sfID,
                        isVerified: true, // SF accounts are considered verified
                        password: tempPassword,
                    });
                    results.success++;
                }
            } catch (err: any) {
                results.failed++;
                results.errors.push({ sfID: u.sfID, email: u.email, error: err.message });
            }
        }

        res.json({ message: "User sync completed", results });
    } catch (err: any) {
        res.status(500).json({ error: "User sync failed", details: err.message });
    }
});

// ─────────────────────────────────────────────
// POST /api/sync/leads
// Payload: { leads: [{ sfLeadId, firstName, lastName, email, phone, company, status, source }] }
// ─────────────────────────────────────────────
router.post("/leads", authenticateSync, async (req, res) => {
    try {
        const { leads } = req.body;
        if (!Array.isArray(leads)) return res.status(400).json({ error: "'leads' must be an array" });

        const results = makeResults();

        for (const l of leads) {
            try {
                const existing = await Lead.findOne({
                    $or: [
                        ...(l.sfLeadId ? [{ sfLeadId: l.sfLeadId }] : []),
                        ...(l.email ? [{ email: l.email }] : []),
                    ]
                }) as any;

                if (existing) {
                    existing.firstName = l.firstName || existing.firstName;
                    existing.lastName = l.lastName || existing.lastName;
                    existing.phone = l.phone || existing.phone;
                    existing.company = l.company || existing.company;
                    existing.status = l.status || existing.status;
                    existing.source = l.source || existing.source;
                    if (l.sfLeadId) existing.sfLeadId = l.sfLeadId;
                    if (l.sfRecordTypeId) existing.sfRecordTypeId = l.sfRecordTypeId;
                    if (l.sfRecordTypeName) existing.sfRecordTypeName = l.sfRecordTypeName;
                    await existing.save();
                    results.updated++;
                } else {
                    const tempPassword = l.password || `SF_IMPORT_${l.sfLeadId || Date.now()}`;
                    await Lead.create({
                        firstName: l.firstName,
                        lastName: l.lastName,
                        email: l.email,
                        phone: l.phone,
                        company: l.company,
                        status: l.status || "New",
                        source: l.source || "Salesforce",
                        sfLeadId: l.sfLeadId,
                        sfRecordTypeId: l.sfRecordTypeId,
                        sfRecordTypeName: l.sfRecordTypeName,
                        isVerified: true,
                        password: tempPassword,
                    });
                    results.success++;
                }
            } catch (err: any) {
                results.failed++;
                results.errors.push({ sfLeadId: l.sfLeadId, email: l.email, error: err.message });
            }
        }

        res.json({ message: "Lead sync completed", results });
    } catch (err: any) {
        res.status(500).json({ error: "Lead sync failed", details: err.message });
    }
});

// ─────────────────────────────────────────────
// POST /api/sync/contacts
// Payload: { contacts: [{ sfID, name, email, phone, role, accountSfID, notes }] }
// ─────────────────────────────────────────────
router.post("/contacts", authenticateSync, async (req, res) => {
    try {
        const { contacts } = req.body;
        if (!Array.isArray(contacts)) return res.status(400).json({ error: "'contacts' must be an array" });

        const results = makeResults();

        for (const c of contacts) {
            try {
                // Resolve account reference from sfID if provided
                let accountId = null;
                if (c.accountSfID) {
                    const account = await Account.findOne({ sfID: c.accountSfID }) as any;
                    if (account) accountId = account._id;
                }

                const existing = await Contact.findOne({
                    $or: [
                        ...(c.sfID ? [{ sfID: c.sfID }] : []),
                        ...(c.email ? [{ email: c.email }] : []),
                    ]
                }) as any;

                if (existing) {
                    existing.name = c.name || existing.name;
                    existing.phone = c.phone || existing.phone;
                    existing.role = c.role || existing.role;
                    existing.notes = c.notes || existing.notes;
                    if (accountId) existing.accountId = accountId;
                    if (c.sfID) existing.sfID = c.sfID;
                    await existing.save();
                    results.updated++;
                } else {
                    await Contact.create({
                        name: c.name,
                        email: c.email,
                        phone: c.phone,
                        role: c.role,
                        notes: c.notes,
                        accountId: accountId,
                        sfID: c.sfID,
                        isVerified: true,
                        password: c.password || `SF_IMPORT_${c.sfID || Date.now()}`,
                    });
                    results.success++;
                }
            } catch (err: any) {
                results.failed++;
                results.errors.push({ sfID: c.sfID, email: c.email, error: err.message });
            }
        }

        res.json({ message: "Contact sync completed", results });
    } catch (err: any) {
        res.status(500).json({ error: "Contact sync failed", details: err.message });
    }
});

// ─────────────────────────────────────────────
// POST /api/sync/sessions
// Payload: { sessions: [{ sfID, title, date, location, agenda, summary, vodUrl, campaignSfID }] }
// ─────────────────────────────────────────────
router.post("/sessions", authenticateSync, async (req, res) => {
    try {
        const { sessions } = req.body;
        if (!Array.isArray(sessions)) return res.status(400).json({ error: "'sessions' must be an array" });

        const results = makeResults();

        for (const s of sessions) {
            try {
                // Resolve campaign reference
                let campaignId = null;
                if (s.campaignSfID) {
                    const campaign = await Campaign.findOne({ sfID: s.campaignSfID }) as any;
                    if (campaign) campaignId = campaign._id;
                }
                if (!campaignId && s.campaignId) campaignId = s.campaignId;

                if (!campaignId) {
                    results.failed++;
                    results.errors.push({ sfID: s.sfID, error: "Could not resolve campaign reference" });
                    continue;
                }

                const existing = await Session.findOne({ sfID: s.sfID }) as any;

                if (existing) {
                    existing.title = s.title || existing.title;
                    existing.date = s.date || existing.date;
                    existing.location = s.location || existing.location;
                    existing.agenda = s.agenda || existing.agenda;
                    existing.summary = s.summary || existing.summary;
                    existing.vodUrl = s.vodUrl || existing.vodUrl;
                    await existing.save();
                    results.updated++;
                } else {
                    await Session.create({
                        title: s.title,
                        campaign: campaignId,
                        date: s.date,
                        location: s.location,
                        agenda: s.agenda,
                        summary: s.summary,
                        vodUrl: s.vodUrl,
                        sfID: s.sfID,
                    });
                    results.success++;
                }
            } catch (err: any) {
                results.failed++;
                results.errors.push({ sfID: s.sfID, error: err.message });
            }
        }

        res.json({ message: "Session sync completed", results });
    } catch (err: any) {
        res.status(500).json({ error: "Session sync failed", details: err.message });
    }
});

// ─────────────────────────────────────────────
// POST /api/sync/characters
// Payload: { characters: [{ sfID, name, gameType, class, level, isDead, playerSfID, campaignSfID, dungeonSfID }] }
// ─────────────────────────────────────────────
router.post("/characters", authenticateSync, async (req, res) => {
    try {
        const { characters } = req.body;
        if (!Array.isArray(characters)) return res.status(400).json({ error: "'characters' must be an array" });

        const results = makeResults();

        for (const c of characters) {
            try {
                // Resolve player Account reference
                let playerId = null;
                if (c.playerSfID) {
                    const account = await Account.findOne({ sfID: c.playerSfID }) as any;
                    if (account) playerId = account._id;
                }

                let campaignId = null;
                if (c.campaignSfID) {
                    const campaign = await Campaign.findOne({ sfID: c.campaignSfID }) as any;
                    if (campaign) campaignId = campaign._id;
                }

                let dungeonId = null;
                if (c.dungeonSfID) {
                    const dungeon = await Dungeon.findOne({ sfID: c.dungeonSfID }) as any;
                    if (dungeon) dungeonId = dungeon._id;
                }

                const existing = await Character.findOne({ sfID: c.sfID }) as any;

                if (existing) {
                    existing.name = c.name || existing.name;
                    existing.gameType = c.gameType || existing.gameType;
                    existing.class = c.class || existing.class;
                    existing.level = c.level ?? existing.level;
                    existing.isDead = c.isDead ?? existing.isDead;
                    if (playerId) existing.player = playerId;
                    if (campaignId) existing.campaign = campaignId;
                    if (dungeonId) existing.dungeon = dungeonId;
                    await existing.save();
                    results.updated++;
                } else {
                    if (!playerId) {
                        results.failed++;
                        results.errors.push({ sfID: c.sfID, error: "Could not resolve player Account reference" });
                        continue;
                    }
                    await Character.create({
                        name: c.name,
                        player: playerId,
                        campaign: campaignId,
                        dungeon: dungeonId,
                        gameType: c.gameType,
                        class: c.class,
                        level: c.level || 1,
                        isDead: c.isDead || false,
                        sfID: c.sfID,
                    });
                    results.success++;
                }
            } catch (err: any) {
                results.failed++;
                results.errors.push({ sfID: c.sfID, error: err.message });
            }
        }

        res.json({ message: "Character sync completed", results });
    } catch (err: any) {
        res.status(500).json({ error: "Character sync failed", details: err.message });
    }
});

// ─────────────────────────────────────────────
// POST /api/sync/dungeons
// Payload: { dungeons: [{ sfID, name, description }] }
// ─────────────────────────────────────────────
router.post("/dungeons", authenticateSync, async (req, res) => {
    try {
        const { dungeons } = req.body;
        if (!Array.isArray(dungeons)) return res.status(400).json({ error: "'dungeons' must be an array" });

        const results = makeResults();

        for (const d of dungeons) {
            try {
                const existing = await Dungeon.findOne({ sfID: d.sfID }) as any;

                if (existing) {
                    existing.name = d.name || existing.name;
                    existing.description = d.description || existing.description;
                    await existing.save();
                    results.updated++;
                } else {
                    await Dungeon.create({
                        name: d.name,
                        description: d.description,
                        sfID: d.sfID,
                    });
                    results.success++;
                }
            } catch (err: any) {
                results.failed++;
                results.errors.push({ sfID: d.sfID, error: err.message });
            }
        }

        res.json({ message: "Dungeon sync completed", results });
    } catch (err: any) {
        res.status(500).json({ error: "Dungeon sync failed", details: err.message });
    }
});

// ─────────────────────────────────────────────
// GET /api/sync/status
// Health check for sync endpoint
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// POST /api/sync/salesforce
// Payload: { object: "Account", records: [{ Id: "001...", Name: "...", ... }] }
// Let the Web App handle Salesforce API field names mappings!
// ─────────────────────────────────────────────
import PlayerSession from "../models/PlayerSession.js";

router.post("/salesforce", authenticateSync, async (req, res) => {
    try {
        const { object, records } = req.body;
        if (!object || !Array.isArray(records)) {
            return res.status(400).json({ error: "'object' must be provided and 'records' must be an array" });
        }

        const results = makeResults();

        // Object routers
        if (object === "Account") {
            for (const r of records) {
                try {
                    const sfID = r.Id;
                    const email = r.PersonEmail || r.Email;
                    
                    const existing = await Account.findOne({
                        $or: [
                            ...(sfID ? [{ sfID }] : []),
                            ...(email ? [{ email }] : []),
                        ]
                    }) as any;

                    if (existing) {
                        existing.name = r.Name || existing.name;
                        existing.phone = r.Phone || existing.phone;
                        existing.email = email || existing.email;
                        existing.industry = r.Industry || existing.industry;
                        existing.website = r.Website || existing.website;
                        if (sfID) existing.sfID = sfID;
                        existing.updatedAt = new Date();
                        await existing.save();
                        results.updated++;
                    } else {
                        const tempPassword = `SF_IMPORT_${sfID || Date.now()}`;
                        await Account.create({
                            name: r.Name,
                            email: email,
                            phone: r.Phone,
                            industry: r.Industry,
                            website: r.Website,
                            sfID: sfID,
                            isVerified: true,
                            password: tempPassword,
                        });
                        results.success++;
                    }
                } catch (err: any) {
                    results.failed++;
                    results.errors.push({ sfID: r.Id, error: err.message });
                }
            }
        } else if (object === "Lead") {
            for (const r of records) {
                try {
                    const sfID = r.Id;
                    const email = r.Email;
                    
                    const existing = await Lead.findOne({
                        $or: [
                            ...(sfID ? [{ sfLeadId: sfID }] : []),
                            ...(email ? [{ email }] : []),
                        ]
                    }) as any;

                    if (existing) {
                        existing.firstName = r.FirstName || existing.firstName;
                        existing.lastName = r.LastName || existing.lastName;
                        existing.phone = r.Phone || existing.phone;
                        existing.company = r.Company || existing.company;
                        existing.status = r.Status || existing.status;
                        existing.email = email || existing.email;
                        if (sfID) existing.sfLeadId = sfID;
                        await existing.save();
                        results.updated++;
                    } else {
                        const tempPassword = `SF_IMPORT_${sfID || Date.now()}`;
                        await Lead.create({
                            firstName: r.FirstName,
                            lastName: r.LastName,
                            email: email,
                            phone: r.Phone,
                            company: r.Company,
                            status: r.Status || "New",
                            source: "Salesforce",
                            sfLeadId: sfID,
                            isVerified: true,
                            password: tempPassword,
                        });
                        results.success++;
                    }
                } catch (err: any) {
                    results.failed++;
                    results.errors.push({ sfID: r.Id, error: err.message });
                }
            }
        } else if (object === "Contact") {
            for (const r of records) {
                try {
                    const sfID = r.Id;
                    const email = r.Email;
                    let accountId = null;
                    if (r.AccountId) {
                        const account = await Account.findOne({ sfID: r.AccountId }) as any;
                        if (account) accountId = account._id;
                    }

                    const existing = await Contact.findOne({
                        $or: [
                            ...(sfID ? [{ sfID }] : []),
                            ...(email ? [{ email }] : []),
                        ]
                    }) as any;

                    if (existing) {
                        existing.name = r.Name || existing.name;
                        existing.phone = r.Phone || existing.phone;
                        existing.email = email || existing.email;
                        if (accountId) existing.accountId = accountId;
                        if (sfID) existing.sfID = sfID;
                        await existing.save();
                        results.updated++;
                    } else {
                        const tempPassword = `SF_IMPORT_${sfID || Date.now()}`;
                        await Contact.create({
                            name: r.Name,
                            email: email,
                            phone: r.Phone,
                            accountId: accountId,
                            sfID: sfID,
                            isVerified: true,
                            password: tempPassword,
                        });
                        results.success++;
                    }
                } catch (err: any) {
                    results.failed++;
                    results.errors.push({ sfID: r.Id, error: err.message });
                }
            }
        } else if (object === "Campaign") {
            for (const r of records) {
                try {
                    const sfID = r.Id;
                    
                    const existing = await Campaign.findOne({ sfID }) as any;

                    if (existing) {
                        existing.title = r.Name || existing.title;
                        existing.description = r.Description || existing.description;
                        existing.status = r.Status || existing.status;
                        if (r.StartDate) existing.startDate = new Date(r.StartDate);
                        if (r.EndDate) existing.endDate = new Date(r.EndDate);
                        await existing.save();
                        results.updated++;
                    } else {
                        const payload: any = {
                            title: r.Name,
                            description: r.Description,
                            status: r.Status || "Not Started",
                            sfID: sfID
                        };
                        if (r.StartDate) payload.startDate = new Date(r.StartDate);
                        if (r.EndDate) payload.endDate = new Date(r.EndDate);
                        
                        await Campaign.create(payload);
                        results.success++;
                    }
                } catch (err: any) {
                    results.failed++;
                    results.errors.push({ sfID: r.Id, error: err.message });
                }
            }
        } else if (object === "Session__c") {
            for (const r of records) {
                try {
                    const sfID = r.Id;
                    
                    let campaignId = null;
                    if (r.Campaign__c) {
                        const campaign = await Campaign.findOne({ sfID: r.Campaign__c }) as any;
                        if (campaign) campaignId = campaign._id;
                    }

                    const existing = await Session.findOne({ sfID }) as any;

                    if (existing) {
                        existing.title = r.Name || existing.title;
                        // Assuming Date__c is the date field in Salesforce session
                        if (r.Date__c) existing.date = new Date(r.Date__c);
                        if (r.Location__c) existing.location = r.Location__c;
                        if (r.Agenda__c) existing.agenda = r.Agenda__c;
                        if (r.Summary__c) existing.summary = r.Summary__c;
                        if (r.VOD_URL__c) existing.vodUrl = r.VOD_URL__c;
                        if (campaignId) existing.campaign = campaignId;
                        await existing.save();
                        results.updated++;
                    } else {
                        const payload: any = {
                            title: r.Name,
                            campaign: campaignId,
                            location: r.Location__c,
                            agenda: r.Agenda__c,
                            summary: r.Summary__c,
                            vodUrl: r.VOD_URL__c,
                            sfID: sfID
                        };
                        if (r.Date__c) payload.date = new Date(r.Date__c);
                        
                        await Session.create(payload);
                        results.success++;
                    }
                } catch (err: any) {
                    results.failed++;
                    results.errors.push({ sfID: r.Id, error: err.message });
                }
            }
        } else if (object === "Player_Session__c") {
            for (const r of records) {
                try {
                    const sfID = r.Id;
                    
                    let sessionId = null;
                    if (r.Session__c) {
                        const session = await Session.findOne({ sfID: r.Session__c }) as any;
                        if (session) sessionId = session._id;
                    }
                    
                    let playerId = null;
                    if (r.Player__c) { // Note: Player__c is Account
                        const account = await User.findOne({ sfID: r.Player__c }) as any;
                        if (account) playerId = account._id;
                    }
                    
                    let campaignId = null;
                    if (r.Campaign__c) {
                        const campaign = await Campaign.findOne({ sfID: r.Campaign__c }) as any;
                        if (campaign) campaignId = campaign._id;
                    }

                    const existing = await PlayerSession.findOne({ sfID }) as any;

                    if (existing) {
                        existing.name = r.Name || existing.name;
                        if (sessionId) existing.session = sessionId;
                        if (playerId) existing.player = playerId;
                        if (campaignId) existing.campaign = campaignId;
                        await existing.save();
                        results.updated++;
                    } else {
                        await PlayerSession.create({
                            name: r.Name,
                            session: sessionId,
                            player: playerId,
                            campaign: campaignId,
                            sfID: sfID
                        });
                        results.success++;
                    }
                } catch (err: any) {
                    results.failed++;
                    results.errors.push({ sfID: r.Id, error: err.message });
                }
            }
        } else {
            return res.status(400).json({ error: `Unsupported object type: ${object}` });
        }

        res.json({ message: `${object} sync completed`, results });
    } catch (err: any) {
        res.status(500).json({ error: `Sync failed for ${req.body.object}`, details: err.message });
    }
});

export default router;
