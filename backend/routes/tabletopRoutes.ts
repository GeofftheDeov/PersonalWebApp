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
import { gmTitleOf } from "../planning/campaignSettings.js";
import { auth } from "../middleware/auth.js";
import { getAuthorizedCampaignIds, isCampaignGameMaster, isSessionGameMaster } from "../utils/gameNightPlannerUtils.js";
import { findPersonById, personDisplayName } from "../utils/personUtils.js";
import { getDecryptedKeys } from "./apiKeyRoutes.js";
import { buildGoogleCalendarLink, integrations } from "../utils/integrations.js";
import pool from "../db/index.js";
import { isUuid } from "../db/model.js";
import CampaignMember from "../models/CampaignMember.js";
import { followSessionStarts } from "../planning/questReminders.js";
import { AttendanceError, confirmAttendance, getAttendance } from "../planning/attendance.js";

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
            return res.status(403).json({ error: `Only the ${await gmTitleOf(targetCampaign)} can create sessions for this campaign` });
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
                const keys = await getDecryptedKeys(String(req.user.id), "discord");
                if (!keys) {
                    warnings.push("Discord event skipped: no 'discord' bot token in your API Key Vault.");
                } else {
                    const ev = await integrations().discord.createScheduledEvent({
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
                const keys = await getDecryptedKeys(String(req.user.id), "google_calendar");
                if (keys) {
                    const ev = await integrations().google.createCalendarEvent(keys.secret, eventInput);
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
        const existing = await Session.findById(req.params.id).select("campaign gmOverride");
        if (!existing) return res.status(404).json({ error: "Session not found" });

        // Sessions are GM-only: the campaign's Game Master, or this session's stand-in (#89).
        if (!(await isSessionGameMaster(req.user, existing))) {
            return res.status(403).json({ error: `Only the ${await gmTitleOf(existing.campaign)} can edit sessions for this campaign` });
        }

        const { title, date, endDate, location, isOnline, agenda, summary, vodUrl } = req.body;
        const session = await Session.findByIdAndUpdate(
            req.params.id,
            { title, date, endDate, location, isOnline, agenda, summary, vodUrl },
            { new: true }
        ).populate("campaign");
        if (!session) return res.status(404).json({ error: "Session not found" });
        // Its quests' due times follow a new start (#91). The reminder job catches up anyway.
        if (date !== undefined) {
            await followSessionStarts(pool, String(session._id)).catch((err) =>
                console.error("[tabletop] moving quest due times failed:", err.message));
        }
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

// --- Attendance (#37) ---------------------------------------------------------
// GET: who was there (the GM also gets the party checklist, pre-filled from the
// ready check). PUT { playerIds }: the GM confirms exactly who came.
const attendanceRoute = (fn: (actor: any, sessionId: string, body: any) => Promise<unknown>) =>
    async (req: any, res: any) => {
        try {
            res.json(await fn(req.user, req.params.id, req.body));
        } catch (error: any) {
            if (error instanceof AttendanceError) return res.status(error.status).json({ error: error.message });
            console.error("[tabletop] attendance failed:", error);
            res.status(500).json({ error: "Failed to load or save attendance" });
        }
    };
router.get("/sessions/:id/attendance", auth, attendanceRoute((actor, id) => getAttendance(actor, id)));
router.put("/sessions/:id/attendance", auth, attendanceRoute((actor, id, body) => confirmAttendance(actor, id, body?.playerIds)));

// --- Tabletop Lifecycle: Prepare Session ---
router.post("/prepare-session", auth, async (req: any, res) => {
    try {
        const { title, campaignId, date, location, isOnline, agenda, ownerId, ownerName } = req.body;

        // GM-only, same as direct session creation (this endpoint was previously unauthenticated).
        if (!(await isCampaignGameMaster(req.user, campaignId?.toString()))) {
            return res.status(403).json({ error: `Only the ${await gmTitleOf(campaignId)} can create sessions for this campaign` });
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
        const campaign = req.query.campaign === undefined ? undefined : String(req.query.campaign);

        // ?campaign=<id> (#36): one party's characters for the campaign's
        // Characters tab, each with who plays it and whether they're still in
        // the party. A deactivated player's character stays on the roster as
        // history (#31), flagged so the page can set it apart.
        if (campaign !== undefined) {
            if (!isUuid(campaign)) return res.status(400).json({ error: "campaign must be a campaign id" });
            if (campaignIds && !campaignIds.includes(campaign)) return res.status(403).json({ error: "Unauthorized" });
            const [characters, members] = await Promise.all([
                Character.find({ campaign })
                    .populate({ path: "player", select: "handle name firstName lastName" })
                    .sort({ name: 1 }),
                CampaignMember.find({ campaign }).select("person isActive"),
            ]);
            const active = new Map(members.map((m: any) => [String(m.person), m.isActive !== false]));
            return res.json(characters.map((c: any) => {
                const obj = c.toObject();
                const playerId = String(c.player?._id ?? c.player ?? "");
                obj.player = c.player?._id
                    ? { _id: playerId, name: personDisplayName(c.player), handle: c.player.handle ?? null }
                    : null;
                obj.playerActive = active.get(playerId) ?? false;
                return obj;
            }));
        }

        const query = campaignIds ? { campaign: { $in: campaignIds } } : {};
        const characters = await Character.find(query).populate("campaign dungeon");
        res.json(characters);
    } catch (error: any) {
        res.status(500).json({ error: "Failed to fetch characters", details: error.message });
    }
});

// Who may do what with a character (#198's access gaps): the player edits it,
// and reading follows a player's profile (GET /api/users/players/:id): the
// player, their friends and campaign-mates, plus anyone in the character's own
// campaign (its roster keeps a departed player's characters, #31). Admins may
// do anything. campaignIds is getAuthorizedCampaignIds(user): null = admin.

/** The fields a character's form sets. Anything else in the body is ignored. */
function characterFields(body: any) {
    const fields: Record<string, unknown> = {};
    for (const [key, field] of [["name", "name"], ["class", "class"], ["level", "level"], ["gameType", "gameType"], ["isDead", "isDead"]] as const) {
        if (body?.[key] !== undefined) fields[field] = body[key];
    }
    // The forms send "" for "no campaign".
    if (body?.campaign !== undefined) fields.campaign = body.campaign || null;
    return fields;
}

const idOf = (ref: any) => (ref == null ? null : String(ref._id ?? ref));

async function canSeeCharacter(user: any, campaignIds: string[] | null, character: any): Promise<boolean> {
    if (campaignIds === null) return true;
    const playerId = idOf(character.player);
    if (playerId === String(user.id)) return true;
    const campaignId = idOf(character.campaign);
    if (campaignId && campaignIds.includes(campaignId)) return true;
    if (!playerId) return false;

    const [viewer, player] = await Promise.all([findPersonById(user.id, "friends"), findPersonById(playerId, "friends")]);
    const friends = (doc: any, id: string) => doc?.friends?.some((f: any) => String(f) === id);
    if (friends(viewer?.doc, playerId) || friends(player?.doc, String(user.id))) return true;

    // A player deactivated in a campaign is no longer a campaign-mate there (#31).
    const memberships = await CampaignMember.find({ person: playerId, isActive: true }).select("campaign");
    return memberships.some((m: any) => campaignIds.includes(String(m.campaign)));
}

router.post("/characters", auth, async (req: any, res) => {
    try {
        const fields = characterFields(req.body);
        if (typeof fields.name !== "string" || !fields.name.trim()) return res.status(400).json({ error: "A character needs a name" });
        const campaignIds = await getAuthorizedCampaignIds(req.user);
        if (fields.campaign != null) {
            if (!isUuid(String(fields.campaign))) return res.status(400).json({ error: "campaign must be a campaign id" });
            if (campaignIds && !campaignIds.includes(String(fields.campaign))) return res.status(403).json({ error: "Unauthorized" });
        }
        // You play what you create. An admin may make one for someone else.
        const player = campaignIds === null && req.body?.player ? req.body.player : req.user.id;
        const character = new Character({ ...fields, player });
        await character.save();
        res.status(201).json(character);
    } catch (error: any) {
        res.status(500).json({ error: "Failed to create character", details: error.message });
    }
});

router.get("/characters/:id", auth, async (req: any, res) => {
    try {
        if (!isUuid(req.params.id)) return res.status(404).json({ error: "Character not found" });
        const character = await Character.findById(req.params.id).populate("campaign dungeon");
        if (!character) return res.status(404).json({ error: "Character not found" });
        const campaignIds = await getAuthorizedCampaignIds(req.user);
        if (!(await canSeeCharacter(req.user, campaignIds, character))) return res.status(403).json({ error: "Unauthorized" });
        res.json(character);
    } catch (error: any) {
        res.status(500).json({ error: "Failed to fetch character", details: error.message });
    }
});

router.put("/characters/:id", auth, async (req: any, res) => {
    try {
        if (!isUuid(req.params.id)) return res.status(404).json({ error: "Character not found" });
        const existing = await Character.findById(req.params.id);
        if (!existing) return res.status(404).json({ error: "Character not found" });
        const campaignIds = await getAuthorizedCampaignIds(req.user);
        if (campaignIds !== null && idOf(existing.player) !== String(req.user.id)) {
            return res.status(403).json({ error: "Only the character's player can change it" });
        }
        const fields = characterFields(req.body);
        // Moving it needs a seat in the new campaign; leaving it where it is doesn't.
        if (fields.campaign != null && String(fields.campaign) !== idOf(existing.campaign)) {
            if (!isUuid(String(fields.campaign))) return res.status(400).json({ error: "campaign must be a campaign id" });
            if (campaignIds && !campaignIds.includes(String(fields.campaign))) return res.status(403).json({ error: "Unauthorized" });
        }
        const character = await Character.findByIdAndUpdate(req.params.id, fields, { new: true }).populate("campaign dungeon");
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
