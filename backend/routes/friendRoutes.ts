import express from "express";
const router = express.Router();
import User from "../models/User.js";
import FriendRequest from "../models/FriendRequest.js";
import { auth } from "../middleware/auth.js";
import mongoose from "mongoose";

// Search for users by handle#number
router.get("/search", auth, async (req: any, res) => {
    try {
        const { query } = req.query;
        if (!query) return res.status(400).json({ error: "Search query is required" });

        const [handle, userNumber] = (query as string).replace("@", "").split("#");

        if (!handle || !userNumber) {
            return res.status(400).json({ error: "Invalid format. Use handle#number" });
        }

        const user = await User.findOne({ 
            handle: { $regex: new RegExp(`^${handle}$`, 'i') }, 
            userNumber 
        }).select("name handle userNumber discordId discordHandle");

        if (!user) return res.status(404).json({ error: "User not found" });

        res.json(user);
    } catch (error) {
        console.error("Search error:", error);
        res.status(500).json({ error: "Failed to search for user" });
    }
});

// Send friend request
router.post("/request", auth, async (req: any, res) => {
    try {
        const { toUserId } = req.body;
        const fromUserId = req.user.id;

        if (toUserId === fromUserId) {
            return res.status(400).json({ error: "You cannot send a friend request to yourself" });
        }

        // Check if already friends
        const fromUser = await User.findById(fromUserId);
        if (fromUser?.friends.includes(toUserId)) {
            return res.status(400).json({ error: "You are already friends with this user" });
        }

        // Check if request already exists
        const existingRequest = await FriendRequest.findOne({
            from: fromUserId,
            to: toUserId,
            status: "pending"
        });

        if (existingRequest) {
            return res.status(400).json({ error: "Friend request already pending" });
        }

        const request = new FriendRequest({ from: fromUserId, to: toUserId });
        await request.save();

        res.status(201).json({ message: "Friend request sent successfully" });
    } catch (error) {
        console.error("Request error:", error);
        res.status(500).json({ error: "Failed to send friend request" });
    }
});

// Get pending requests (both incoming and outgoing)
router.get("/requests", auth, async (req: any, res) => {
    try {
        const userId = req.user.id;
        
        const incoming = await FriendRequest.find({ to: userId, status: "pending" })
            .populate("from", "name handle userNumber");
        
        const outgoing = await FriendRequest.find({ from: userId, status: "pending" })
            .populate("to", "name handle userNumber");

        res.json({ incoming, outgoing });
    } catch (error) {
        console.error("Fetch requests error:", error);
        res.status(500).json({ error: "Failed to fetch friend requests" });
    }
});

// Respond to friend request (Accept/Reject)
router.put("/request/:id", auth, async (req: any, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { action } = req.body; // 'accept' or 'reject'
        const requestId = req.params.id;
        const userId = req.user.id;

        const request = await FriendRequest.findById(requestId);
        if (!request || request.to.toString() !== userId) {
            return res.status(404).json({ error: "Request not found or unauthorized" });
        }

        if (action === "accept") {
            request.status = "accepted";
            await request.save({ session });

            // Add to both users' friends lists
            await User.findByIdAndUpdate(request.from, { $addToSet: { friends: request.to } }, { session });
            await User.findByIdAndUpdate(request.to, { $addToSet: { friends: request.from } }, { session });
        } else {
            request.status = "rejected";
            await request.save({ session });
        }

        await session.commitTransaction();
        session.endSession();

        res.json({ message: `Request ${action}ed successfully` });
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error("Respond to request error:", error);
        res.status(500).json({ error: "Failed to process friend request" });
    }
});

// Get friends list
router.get("/list", auth, async (req: any, res) => {
    try {
        const userId = req.user.id;
        const user = await User.findById(userId).populate("friends", "name handle userNumber discordId discordHandle");
        res.json(user?.friends || []);
    } catch (error) {
        console.error("List friends error:", error);
        res.status(500).json({ error: "Failed to fetch friends list" });
    }
});

// Remove friend
router.delete("/:id", auth, async (req: any, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const friendId = req.params.id;
        const userId = req.user.id;

        await User.findByIdAndUpdate(userId, { $pull: { friends: friendId } }, { session });
        await User.findByIdAndUpdate(friendId, { $pull: { friends: userId } }, { session });

        await session.commitTransaction();
        session.endSession();

        res.json({ message: "Friend removed successfully" });
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error("Remove friend error:", error);
        res.status(500).json({ error: "Failed to remove friend" });
    }
});

// Link Discord info
router.post("/link-discord", auth, async (req: any, res) => {
    try {
        const { discordId, discordHandle } = req.body;
        const userId = req.user.id;

        await User.findByIdAndUpdate(userId, { discordId, discordHandle });

        res.json({ message: "Discord account linked successfully" });
    } catch (error) {
        console.error("Link discord error:", error);
        res.status(500).json({ error: "Failed to link discord" });
    }
});

export default router;
