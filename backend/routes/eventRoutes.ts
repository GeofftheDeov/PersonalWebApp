import express from "express";
const router = express.Router();
import Event from "../models/Event.js";

import bcrypt from "bcryptjs";
import Lead from "../models/Lead.js";

// Create a new lead
router.post("/", async (req, res) => {
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
        console.error("Error creating lead:", error);
        res.status(500).json({ error: "Failed to create lead", details: error.message });
    }
});

// Get all leads
router.get("/", async (req, res) => {
    try {
        const events = await Event.find().sort({ startDate: -1 });
        res.json(events);
    } catch (error: any) {
        console.error("Error fetching events:", error);
        res.status(500).json({ error: "Failed to fetch events", details: error.message });
    }
});

// Get a specific lead
router.get("/:id", async (req, res) => {
    try {
        const event = await Event.findById(req.params.id);
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
