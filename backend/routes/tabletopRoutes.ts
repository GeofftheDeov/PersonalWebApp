import express from "express";
const router = express.Router();
import Session from "../models/Session.js";
import Character from "../models/Character.js";
import Dungeon from "../models/Dungeon.js";
import Encounter from "../models/Encounter.js";
import PlayerSession from "../models/PlayerSession.js";
import Task from "../models/Task.js";
import Event from "../models/Event.js";
import { auth } from "../middleware/auth.js";
import { getAuthorizedCampaignIds } from "../utils/gameNightPlannerUtils.js";

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

router.post("/sessions", async (req, res) => {
    try {
        const session = new Session(req.body);
        await session.save();
        res.status(201).json(session);
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
        const { title, date, location, agenda, summary, vodUrl } = req.body;
        const session = await Session.findByIdAndUpdate(
            req.params.id,
            { title, date, location, agenda, summary, vodUrl },
            { new: true }
        ).populate("campaign");
        if (!session) return res.status(404).json({ error: "Session not found" });
        res.json(session);
    } catch (error: any) {
        res.status(500).json({ error: "Failed to update session", details: error.message });
    }
});

// --- Tabletop Lifecycle: Prepare Session ---
router.post("/prepare-session", async (req, res) => {
    try {
        const { title, campaignId, date, location, agenda, ownerId, ownerName } = req.body;
        
        // 1. Create Session
        const session = new Session({
            title,
            campaign: campaignId,
            date,
            location,
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
