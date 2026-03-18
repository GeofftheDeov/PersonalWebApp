import express from "express";
const router = express.Router();
import Task from "../models/Task.js";

// Create a new task
router.post("/", async (req, res) => {
    try {
        const { title, description, status, dueDate, sfID, sfRecordTypeID, sfRecordTypeName, ownerId, ownerName } = req.body;
        
        // Validation
        if (!title || !dueDate || !ownerId || !ownerName) {
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
                _id: task._id,
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
        console.error("Error creating task:", error);
        res.status(500).json({ error: "Failed to create task", details: error.message });
    }
});

// Get all tasks
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

// Update a task
router.put("/:id", async (req, res) => {
    try {
        const { title, description, status, dueDate, ownerId, ownerName } = req.body;
        const task = await Task.findByIdAndUpdate(req.params.id, { title, description, status, dueDate, ownerId, ownerName }, { new: true });
        if (!task) {
            return res.status(404).json({ error: "Task not found" });
        }
        res.json(task);
    } catch (error: any) {
        console.error("Error updating task:", error);
        res.status(500).json({ error: "Failed to update task", details: error.message });
    }
});

// Delete a task
router.delete("/:id", async (req, res) => {
    try {
        const task = await Task.findByIdAndDelete(req.params.id);
        if (!task) {
            return res.status(404).json({ error: "Task not found" });
        }
        res.json(task);
    } catch (error: any) {
        console.error("Error deleting task:", error);
        res.status(500).json({ error: "Failed to delete task", details: error.message });
    }
});

export default router;
