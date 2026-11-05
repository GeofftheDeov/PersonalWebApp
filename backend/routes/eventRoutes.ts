import express from "express";
const router = express.Router();
import Event from "../models/Event.js";
import { auth } from "../middleware/auth.js";
import { isAdmin } from "../utils/gameNightPlannerUtils.js";
import { isUuid } from "../db/model.js";

// Apply authentication middleware to all routes
router.use(auth);

// An event is its creator's (#238): every signed-in account used to list every
// event, and "prepare session" ones carried the GM's agenda. Admins see all;
// events made before owners existed (owner NULL) are theirs alone.
const visibleTo = async (user: any) => (await isAdmin(user)) ? {} : { owner: user.id };

// Create a new event
router.post("/", async (req: any, res) => {
    try {
        const { title, description, status, startDate, endDate } = req.body;
        
        // Validation
        if (!title || !status || !startDate || !endDate) {
            return res.status(400).json({ 
                error: "Missing required fields: title, description, status, startDate, endDate" 
            });
        }
        
        
        const event = new Event({ 
            title, 
            description, 
            status, 
            startDate, 
            endDate,
            owner: req.user.id,
        });
        
        await event.save();
        
        res.status(201).json({ 
            message: "Event created successfully!",
            event: {
                id: event._id,
                title: event.title,
                description: event.description,
                status: event.status,
                startDate: event.startDate,
                endDate: event.endDate
            }
        });
    } catch (error: any) {
        console.error("Error creating event:", error);
        res.status(500).json({ error: "Failed to create event", details: error.message });
    }
});

// Get all events
router.get("/", async (req: any, res) => {
    try {
        const events = await Event.find(await visibleTo(req.user)).sort({ startDate: -1 });
        res.json(events);
    } catch (error: any) {
        console.error("Error fetching events:", error);
        res.status(500).json({ error: "Failed to fetch events", details: error.message });
    }
});

// Get a specific event
router.get("/:id", async (req: any, res) => {
    try {
        // Someone else's event reads as missing, not forbidden: no probing ids.
        const event = isUuid(req.params.id)
            ? await Event.findOne({ ...(await visibleTo(req.user)), _id: req.params.id })
            : null;
        if (!event) {
            return res.status(404).json({ error: "Event not found" });
        }
        res.json(event);
    } catch (error: any) {
        console.error("Error fetching event:", error);
        res.status(500).json({ error: "Failed to fetch event", details: error.message });
    }
});

export default router;
