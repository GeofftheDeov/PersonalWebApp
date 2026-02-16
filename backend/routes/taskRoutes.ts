import express from "express";
const router = express.Router();
import Task from "../models/Task.js";

import bcrypt from "bcryptjs";
import Lead from "../models/Lead.js";

// Create a new lead
router.post("/", async (req, res) => {
    try {
        const { title, description, status, dueDate, sfID, sfRecordTypeID, sfRecordTypeName, ownerId, ownerName } = req.body;
        
        // Validation
        if (!title || !status || !dueDate || !ownerId || !ownerName) {
            return res.status(400).json({ 
                error: "Missing required fields: title, status, dueDate, ownerId, ownerName" 
            });
        }        
        const task = new Task({ 
            title, 
            description, 
            status, 
            dueDate, 
            sfID, 
            sfRecordTypeID, 
            sfRecordTypeName, 
            ownerId, 
            ownerName
        });
        
        await task.save();
        
        res.status(201).json({ 
            message: "Task created successfully!",
            task: {
                id: task._id,
                title: task.title,
                description: task.description,
                status: task.status,
                dueDate: task.dueDate,
                sfID: task.sfID,
                sfRecordTypeID: task.sfRecordTypeID,
                sfRecordTypeName: task.sfRecordTypeName,
                ownerId: task.ownerId,
                ownerName: task.ownerName
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
        const tasks = await Task.find().sort({ createdAt: -1 });
        res.json(tasks);
    } catch (error: any) {
        console.error("Error fetching tasks:", error);
        res.status(500).json({ error: "Failed to fetch tasks", details: error.message });
    }
});

// Get a specific lead
router.get("/:id", async (req, res) => {
    try {
        const task = await Task.findById(req.params.id);
        if (!task) {
            return res.status(404).json({ error: "Task not found" });
        }
        res.json(task);
    } catch (error: any) {
        console.error("Error fetching lead:", error);
        res.status(500).json({ error: "Failed to fetch lead", details: error.message });
    }
});

export default router;
