import express from "express";
const router = express.Router();
import Session from "../models/Session.js";
import Character from "../models/Character.js";
import Dungeon from "../models/Dungeon.js";
import Encounter from "../models/Encounter.js";
import PlayerSession from "../models/PlayerSession.js";
import Task from "../models/Task.js";
import Event from "../models/Event.js";
import Campaign from "../models/Campaign.js";
import { auth } from "../middleware/auth.js";
import { getAuthorizedCampaignIds, isCampaignGameMaster } from "../utils/gameNightPlannerUtils.js";
import { findPersonById, personDisplayName } from "../utils/personUtils.js";
import { getDecryptedKeys } from "./apiKeyRoutes.js";
import { createDiscordScheduledEvent, buildGoogleCalendarLink, createGoogleCalendarEvent } from "../utils/integrations.js";
import mongoose from "mongoose";

// --- Sessions ---
router.get("/sessions", auth, async (req: any, res) => {
    try {
        const campaignIds = await getAuthorizedCampaignIds(req.user);
        const query = campaignIds ? { campaign: { $in: campaignIds } } : {};

        const sessions = await Session.find(query).populate("campaign").sort({ date: -1 });
        res.json(sessions);
    } catch (error: any) {
        res.status(500).json({ error: "Failed to fetch sessions", details: error.message });
    }
});

router.post("/sessions", auth, async (req: any, res) => {
    try {
        const campaignIds = await getAuthorizedCampaignIds(req.user);
        const targetCampaign = req.body.campaign?.toString();
        if (campaignIds && (!targetCampaign || !campaignIds.some((id: any) => id.toString() === targetCampaign))) {
            return res.status(403).json({ error: "Unauthorized" });
        }

        // Sessions are GM-only: only the campaign's Game Master may create them.
        if (!(await isCampaignGameMaster(req.user, targetCampaign))) {
            return res.status(403).json({ error: "Only the Game Master can create sessions for this campaign" });
        }

        const {
            title, campaign, date, endDate, location, isOnline, agenda, summary, vodUrl,
            createDiscordEvent, createGoogleEvent,
        } = req.body;

        // ── Validate external-event requirements up front ──────────────────────
        // Discord (external) and Google Calendar both require a start AND end time.
        // Discord external events additionally require a location string.
        if (createDiscordEvent || createGoogleEvent) {
            if (!date || !endDate) {
                return res.status(400).json({ error: "Start and end date/time are required to create Discord or Google Calendar events" });
            }
            if (new Date(endDate) <= new Date(date)) {
                return res.status(400).json({ error: "End time must be after the start time" });
            }
        }

        const campaignDoc = await Campaign.findById(targetCampaign);
        if (!campaignDoc) return res.status(404).json({ error: "Campaign not found" });

        // Effective location: physical location, or "Online" style fallback for remote sessions
        const effectiveLocation = location?.trim() || (isOnline ? "Online" : "");

        if (createDiscordEvent) {
            if (!campaignDoc.discordGuildId) {
                return res.status(400).json({ error: "This campaign has no Discord server linked. Add the server ID on the campaign page first." });
            }
            if (new Date(date) <= new Date()) {
                return res.status(400).json({ error: "Discord events must be scheduled in the future" });
            }
            // External events (no voice channel linked) require a location
            if (!campaignDoc.discordChannelId && !effectiveLocation) {
                return res.status(400).json({ error: "Discord events require a location (or mark the session as online)" });
            }
        }

        const session = new Session({ title, campaign, date, endDate, location, isOnline, agenda, summary, vodUrl });

        const warnings: string[] = [];

        // ── Discord scheduled event ────────────────────────────────────────────
        if (createDiscordEvent) {
            try {
                const keys = await getDecryptedKeys(new mongoose.Types.ObjectId(req.user.id), "discord");
                if (!keys) {
                    warnings.push("Discord event skipped: no 'discord' bot token in your API Key Vault.");
                } else {
                    const ev = await createDiscordScheduledEvent({
                        botToken: keys.secret,
                        guildId: campaignDoc.discordGuildId as string,
                        channelId: campaignDoc.discordChannelId || undefined,
                        name: `${campaignDoc.title}: ${title}`,
                        description: agenda || undefined,
                        location: effectiveLocation || undefined,
                        start: new Date(date),
                        end: endDate ? new Date(endDate) : undefined,
                    });
                    session.discordEventId = ev.id;
                }
            } catch (err: any) {
                console.error("[SESSIONS] Discord event creation failed:", err.message);
                warnings.push(`Discord event failed: ${err.message}`);
            }
        }

        // ── Google Calendar ────────────────────────────────────────────────────
        if (createGoogleEvent) {
            const eventInput = {
                title: `${campaignDoc.title}: ${title}`,
                description: agenda || undefined,
                location: effectiveLocation || undefined,
                start: new Date(date),
                end: new Date(endDate),
            };
            // Always build the shareable link — works for every player, no auth.
            session.googleCalendarLink = buildGoogleCalendarLink(eventInput);
            // If the creator connected their Google account, also insert the event directly.
            try {
                const keys = await getDecryptedKeys(new mongoose.Types.ObjectId(req.user.id), "google_calendar");
                if (keys) {
                    const ev = await createGoogleCalendarEvent(keys.secret, eventInput);
                    session.googleEventId = ev.id;
                } else {
                    warnings.push("Google Calendar not connected — shareable link created, but no event was added to your calendar.");
                }
            } catch (err: any) {
                console.error("[SESSIONS] Google Calendar event creation failed:", err.message);
                warnings.push(`Google Calendar event failed: ${err.message}`);
            }
        }

        await session.save();
        res.status(201).json({ ...session.toObject(), warnings });
    } catch (error: any) {
        res.status(500).json({ error: "Failed to create session", details: error.message });
    }
});

router.get("/sessions/:id", auth, async (req: any, res) => {
    try {
        const campaignIds = await getAuthorizedCampaignIds(req.user);
        const session = await Session.findById(req.params.id).populate("campaign");
        if (!session) return res.status(404).json({ error: "Session not found" });
        // Check access
        if (campaignIds && !campaignIds.some((id: any) => id.toString() === session.campaign?._id?.toString())) {
            return res.status(403).json({ error: "Unauthorized" });
        }
        res.json(session);
    } catch (error: any) {
        res.status(500).json({ error: "Failed to fetch session", details: error.message });
    }
});

router.put("/sessions/:id", auth, async (req: any, res) => {
    try {
        const existing = await Session.findById(req.params.id).select("campaign");
        if (!existing) return res.status(404).json({ error: "Session not found" });

        // Sessions are GM-only: only the campaign's Game Master may edit them.
        if (!(await isCampaignGameMaster(req.user, String(existing.campaign)))) {
            return res.status(403).json({ error: "Only the Game Master can edit sessions for this campaign" });
        }

        const { title, date, endDate, location, isOnline, agenda, summary, vodUrl } = req.body;
        const session = await Session.findByIdAndUpdate(
            req.params.id,
            { title, date, endDate, location, isOnline, agenda, summary, vodUrl },
            { new: true }
        ).populate("campaign");
        if (!session) return res.status(404).json({ error: "Session not found" });
        res.json(session);
    } catch (error: any) {
        res.status(500).json({ error: "Failed to update session", details: error.message });
    }
});

// --- Ready-up check ---------------------------------------------------------
// Players respond to the T-30min ready check. Any campaign member may respond;
// responses are keyed by person id and upserted (you can change your mind).
router.post("/sessions/:id/ready", auth, async (req: any, res) => {
    try {
        const { ready } = req.body as { ready?: boolean };
        if (typeof ready !== "boolean") return res.status(400).json({ error: "ready (boolean) is required" });

        const session = await Session.findById(req.params.id);
        if (!session) return res.status(404).json({ error: "Session not found" });

        const campaignIds = await getAuthorizedCampaignIds(req.user);
        if (campaignIds && !campaignIds.some((id: any) => String(id) === String(session.campaign))) {
            return res.status(403).json({ error: "Unauthorized" });
        }

        const person = await findPersonById(req.user.id, "name firstName lastName handle");
        const name = person ? personDisplayName(person.doc) : String(req.user.email).split("@")[0];

        if (!session.readyCheck) {
            session.readyCheck = { sentAt: undefined, responses: [] } as any;
        }
        const responses: any = session.readyCheck!.responses;
        const existing = responses.find((r: any) => r.playerId === String(req.user.id));
        if (existing) {
            existing.ready = ready;
            existing.name = name;
            existing.respondedAt = new Date();
        } else {
            responses.push({ playerId: String(req.user.id), name, ready, respondedAt: new Date() });
        }
        session.markModified("readyCheck");
        await session.save();

        res.json({ readyCheck: session.readyCheck });
    } catch (error: any) {
        res.status(500).json({ error: "Failed to record ready status", details: error.message });
    }
});

// --- Tabletop Lifecycle: Prepare Session ---
router.post("/prepare-session", auth, async (req: any, res) => {
    try {
        const { title, campaignId, date, location, isOnline, agenda, ownerId, ownerName } = req.body;

        // GM-only, same as direct session creation (this endpoint was previously unauthenticated).
        if (!(await isCampaignGameMaster(req.user, campaignId?.toString()))) {
            return res.status(403).json({ error: "Only the Game Master can create sessions for this campaign" });
        }

        // 1. Create Session
        const session = new Session({
            title,
            campaign: campaignId,
            date,
            location,
            isOnline: !!isOnline,
            agenda,
        });
        await session.save();

        // 2. Create Task (Prepare for Session)
        const dueDate = new Date(date);
        dueDate.setDate(dueDate.getDate() - 1); // 1 day before session

        const task = new Task({
            title: `Prepare for ${title}`,
            description: `Session Agenda: ${agenda}`,
            dueDate,
            ownerId,
            ownerName,
            status: "Not Started",
        });
        await task.save();

        // 3. Create Event
        const event = new Event({
            title: `Tabletop Session: ${title}`,
            description: agenda,
            startDate: date,
            endDate: new Date(new Date(date).getTime() + 4 * 60 * 60 * 1000), // Default 4 hours session
            status: "Not Started",
        });
        await event.save();

        res.status(201).json({
            message: "Session prepared successfully. Session, Task, and Event created.",
            session,
            task,
            event
        });
    } catch (error: any) {
        console.error("Error preparing session:", error);
        res.status(500).json({ error: "Failed to prepare session", details: error.message });
    }
});

// --- Characters ---
router.get("/characters", auth, async (req: any, res) => {
    try {
        const campaignIds = await getAuthorizedCampaignIds(req.user);
        const query = campaignIds ? { campaign: { $in: campaignIds } } : {};

        const characters = await Character.find(query).populate("player campaign dungeon");
        res.json(characters);
    } catch (error: any) {
        res.status(500).json({ error: "Failed to fetch characters", details: error.message });
    }
});

router.post("/characters", async (req, res) => {
    try {
        const character = new Character(req.body);
        await character.save();
        res.status(201).json(character);
    } catch (error: any) {
        res.status(500).json({ error: "Failed to create character", details: error.message });
    }
});

router.get("/characters/:id", auth, async (req: any, res) => {
    try {
        const character = await Character.findById(req.params.id).populate("player campaign dungeon");
        if (!character) return res.status(404).json({ error: "Character not found" });
        res.json(character);
    } catch (error: any) {
        res.status(500).json({ error: "Failed to fetch character", details: error.message });
    }
});

router.put("/characters/:id", auth, async (req: any, res) => {
    try {
        const { name, class: charClass, level, gameType, campaign, isDead } = req.body;
        const character = await Character.findByIdAndUpdate(
            req.params.id,
            { name, class: charClass, level, gameType, campaign, isDead },
            { new: true }
        ).populate("player campaign dungeon");
        if (!character) return res.status(404).json({ error: "Character not found" });
        res.json(character);
    } catch (error: any) {
        res.status(500).json({ error: "Failed to update character", details: error.message });
    }
});

// --- Dungeons ---
router.get("/dungeons", async (req, res) => {
    try {
        const dungeons = await Dungeon.find();
        res.json(dungeons);
    } catch (error: any) {
        res.status(500).json({ error: "Failed to fetch dungeons", details: error.message });
    }
});

// --- Encounters ---
router.get("/encounters", async (req, res) => {
    try {
        const encounters = await Encounter.find().populate("session dungeon");
        res.json(encounters);
    } catch (error: any) {
        res.status(500).json({ error: "Failed to fetch encounters", details: error.message });
    }
});

export default router;
