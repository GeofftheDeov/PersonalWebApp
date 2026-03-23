import express from "express";
const router = express.Router();
import Task from "../models/Task.js";
import { auth } from "../middleware/auth.js";
// Apply authentication middleware to all routes
router.use(auth);
// Create a new task
router.post("/", async (req, res) => {
    try {
        const { title, description, status, dueDate, sfID, sfRecordTypeID, sfRecordTypeName } = req.body;
        // Validation
        if (!title || !dueDate) {
            return res.status(400).json({
                error: "Missing required fields: title, dueDate"
            });
        }
        // Use authenticated user's ID and Email/Name if not provided
        const ownerId = req.user.id;
        const ownerName = req.body.ownerName || req.user.email;
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
    }
    catch (error) {
        console.error("Error creating task:", error);
        res.status(500).json({ error: "Failed to create task", details: error.message });
    }
});
// Get tasks for the authenticated user
router.get("/", async (req, res) => {
    try {
        // Filter by ownerId to only return tasks for the current user
        const tasks = await Task.find({ ownerId: req.user.id }).sort({ createdAt: -1 });
        res.json(tasks);
    }
    catch (error) {
        console.error("Error fetching tasks:", error);
        res.status(500).json({ error: "Failed to fetch tasks", details: error.message });
    }
});
// Get a specific task (ensuring ownership)
router.get("/:id", async (req, res) => {
    try {
        const task = await Task.findOne({ _id: req.params.id, ownerId: req.user.id });
        if (!task) {
            return res.status(404).json({ error: "Task not found or unauthorized" });
        }
        res.json(task);
    }
    catch (error) {
        console.error("Error fetching task:", error);
        res.status(500).json({ error: "Failed to fetch task", details: error.message });
    }
});
// Update a task (ensuring ownership)
router.put("/:id", async (req, res) => {
    try {
        const { title, description, status, dueDate } = req.body;
        const task = await Task.findOneAndUpdate({ _id: req.params.id, ownerId: req.user.id }, { title, description, status, dueDate }, { new: true });
        if (!task) {
            return res.status(404).json({ error: "Task not found or unauthorized" });
        }
        res.json(task);
    }
    catch (error) {
        console.error("Error updating task:", error);
        res.status(500).json({ error: "Failed to update task", details: error.message });
    }
});
// Delete a task (ensuring ownership)
router.delete("/:id", async (req, res) => {
    try {
        const task = await Task.findOneAndDelete({ _id: req.params.id, ownerId: req.user.id });
        if (!task) {
            return res.status(404).json({ error: "Task not found or unauthorized" });
        }
        res.json(task);
    }
    catch (error) {
        console.error("Error deleting task:", error);
        res.status(500).json({ error: "Failed to delete task", details: error.message });
    }
});
export default router;
