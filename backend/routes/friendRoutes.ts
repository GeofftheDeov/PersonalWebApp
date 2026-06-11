import express from "express";
const router = express.Router();
import FriendRequest from "../models/FriendRequest.js";
import { auth } from "../middleware/auth.js";
import mongoose from "mongoose";
import { notify, resolveNotifications } from "../utils/notify.js";
import { findPersonById, findPersonByHandle, modelForType, personDisplayName, toPublicPerson } from "../utils/personUtils.js";

// Search for players by handle#number across Users, Leads, Contacts, and Accounts
router.get("/search", auth, async (req: any, res) => {
    try {
        const { query } = req.query;
        if (!query) return res.status(400).json({ error: "Search query is required" });

        const [handle, userNumber] = (query as string).replace("@", "").split("#");

        if (!handle || !userNumber) {
            return res.status(400).json({ error: "Invalid format. Use handle#number" });
        }

        const person = await findPersonByHandle(handle, userNumber);
        if (!person) return res.status(404).json({ error: "User not found" });

        res.json(toPublicPerson(person));
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

        // Sender can be a User, Lead, Contact, or Account
        const fromPerson = await findPersonById(fromUserId);
        if (!fromPerson) return res.status(404).json({ error: "Your account could not be found" });

        // Check if already friends
        if (fromPerson.doc.friends?.some((f: any) => String(f) === String(toUserId))) {
            return res.status(400).json({ error: "You are already friends with this user" });
        }

        // The recipient must exist somewhere
        const toPerson = await findPersonById(toUserId);
        if (!toPerson) return res.status(404).json({ error: "User not found" });

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

        const senderName = personDisplayName(fromPerson.doc);
        notify(toUserId, {
            type: "friend_request",
            title: `@${senderName} sent you a friend request`,
            sourceKey: `fr:${request._id}`,
            meta: { requestId: String(request._id) },
        }).catch(() => { /* logged inside */ });

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

        const [incomingDocs, outgoingDocs] = await Promise.all([
            FriendRequest.find({ to: userId, status: "pending" }),
            FriendRequest.find({ from: userId, status: "pending" }),
        ]);

        // Resolve counterparties across all person collections (refs may not be Users)
        const resolveParty = async (id: any) => {
            const person = await findPersonById(id, "name firstName lastName handle userNumber email");
            return person ? toPublicPerson(person) : null;
        };

        const incoming = await Promise.all(incomingDocs.map(async r => ({
            _id: r._id, status: r.status, createdAt: r.createdAt, from: await resolveParty(r.from),
        })));
        const outgoing = await Promise.all(outgoingDocs.map(async r => ({
            _id: r._id, status: r.status, createdAt: r.createdAt, to: await resolveParty(r.to),
        })));

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

            // Add to both parties' friends lists, whatever collection they live in
            const [fromPerson, toPerson] = await Promise.all([
                findPersonById(request.from),
                findPersonById(request.to),
            ]);
            if (!fromPerson || !toPerson) {
                throw new Error("Could not resolve both parties of the friend request");
            }
            await modelForType(fromPerson.type).findByIdAndUpdate(request.from, { $addToSet: { friends: request.to } }, { session });
            await modelForType(toPerson.type).findByIdAndUpdate(request.to, { $addToSet: { friends: request.from } }, { session });
        } else {
            request.status = "rejected";
            await request.save({ session });
        }

        await session.commitTransaction();
        session.endSession();

        // Clear the recipient's bell entry; tell the sender if accepted.
        resolveNotifications(userId, `fr:${request._id}`).catch(() => { /* logged inside */ });
        if (action === "accept") {
            const accepter = await findPersonById(userId, "name firstName lastName handle");
            const accepterName = accepter ? personDisplayName(accepter.doc) : "Someone";
            notify(request.from, {
                type: "system",
                title: `@${accepterName} accepted your friend request`,
            }).catch(() => { /* logged inside */ });
        }

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
        const me = await findPersonById(req.user.id, "friends");
        if (!me) return res.json([]);

        const friendIds: any[] = me.doc.friends || [];
        const friends = (await Promise.all(friendIds.map(async (id) => {
            const person = await findPersonById(id, "name firstName lastName handle userNumber discordId discordHandle profilePicture");
            return person ? toPublicPerson(person) : null;
        }))).filter(Boolean);

        res.json(friends);
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

        const [me, friend] = await Promise.all([
            findPersonById(userId),
            findPersonById(friendId),
        ]);

        if (me) await modelForType(me.type).findByIdAndUpdate(userId, { $pull: { friends: friendId } }, { session });
        if (friend) await modelForType(friend.type).findByIdAndUpdate(friendId, { $pull: { friends: userId } }, { session });

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

        const me = await findPersonById(userId);
        if (!me) return res.status(404).json({ error: "Account not found" });
        await modelForType(me.type).findByIdAndUpdate(userId, { discordId, discordHandle });

        res.json({ message: "Discord account linked successfully" });
    } catch (error) {
        console.error("Link discord error:", error);
        res.status(500).json({ error: "Failed to link discord" });
    }
});

export default router;
