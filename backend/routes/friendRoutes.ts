import express from "express";
const router = express.Router();
import FriendRequest from "../models/FriendRequest.js";
import { auth } from "../middleware/auth.js";
import { startSession } from "../db/model.js";
import { notify, resolveNotifications } from "../utils/notify.js";
import { publishFriendshipChanged } from "../services/accessEvents.js";
import Account from "../models/Account.js";
import { query } from "../db/index.js";
import { findPersonById, personDisplayName, toPublicPerson } from "../utils/personUtils.js";

/** Shortest query the typeahead answers: one letter matches half the site. */
export const SEARCH_MIN_CHARS = 2;
export const SEARCH_LIMIT = 10;

/**
 * Typeahead for adding friends (#36, plan §4.1): up to ten people whose handle
 * starts with the query, then the closest trigram matches. `handle#1234` is an
 * exact lookup, as it always was. Never yourself, anyone you're already
 * friends with, or a deactivated account, and only people with a handle: a
 * CRM record that never signed up has nobody to accept the request.
 *
 * Always an array. It used to be one person or a 404, and anything without a
 * `#` was a 400, which is why the box only worked for people who already knew
 * each other's number.
 */
router.get("/search", auth, async (req: any, res) => {
    try {
        const raw = String(req.query.query ?? "").trim().replace(/^@/, "");
        const [handle, userNumber] = raw.split("#").map((s) => s.trim());
        if (handle.length < SEARCH_MIN_CHARS) {
            return res.status(400).json({ error: `Type at least ${SEARCH_MIN_CHARS} characters` });
        }

        // Everyone this person mustn't be offered, in one array parameter.
        const me = await findPersonById(req.user.id, "friends");
        const exclude = [req.user.id, ...(me?.doc.friends ?? []).map(String)];

        let rows: any[];
        if (userNumber !== undefined) {
            ({ rows } = await query(
                `SELECT ${PUBLIC_COLUMNS} FROM accounts
                  WHERE lower(handle) = lower($1) AND user_number = $2
                    AND is_active AND id <> ALL($3::uuid[])`,
                [handle, userNumber, exclude]));
        } else {
            // idx_accounts_handle_trgm serves both the LIKE and the % operator.
            ({ rows } = await query(
                `SELECT ${PUBLIC_COLUMNS}, lower(handle) LIKE $2 AS prefix
                   FROM accounts
                  WHERE handle IS NOT NULL AND is_active AND id <> ALL($3::uuid[])
                    AND (lower(handle) LIKE $2 OR lower(handle) % lower($1))
                  ORDER BY prefix DESC, similarity(lower(handle), lower($1)) DESC, lower(handle), user_number
                  LIMIT ${SEARCH_LIMIT}`,
                [handle, `${escapeLike(handle.toLowerCase())}%`, exclude]));
        }

        res.json(rows.map((row) => toPublicPerson({ doc: row })));
    } catch (error) {
        console.error("Search error:", error);
        res.status(500).json({ error: "Failed to search for user" });
    }
});

/** What toPublicPerson reads, under the model's field names. */
const PUBLIC_COLUMNS = `id AS "_id", sf_object AS "sfObject", name, first_name AS "firstName", last_name AS "lastName", handle, user_number AS "userNumber", profile_picture AS "profilePicture", favorite_games AS "favoriteGames", discord_id AS "discordId", discord_handle AS "discordHandle", created_at AS "createdAt"`;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");

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
        if (!toPerson || toPerson.doc.isActive === false) return res.status(404).json({ error: "User not found" });

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

        const incoming = await Promise.all(incomingDocs.map(async (r: any) => ({
            _id: r._id, status: r.status, createdAt: r.createdAt, from: await resolveParty(r.from),
        })));
        const outgoing = await Promise.all(outgoingDocs.map(async (r: any) => ({
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
    const session = await startSession();
    await session.startTransaction();
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

            // Add to both parties' friends lists. This used to resolve each
            // person first only to learn which of four models to update; both
            // sides are accounts now, and the FKs on friend_requests mean the
            // database has already guaranteed they exist.
            await Account.findByIdAndUpdate(request.from, { $addToSet: { friends: request.to } }, { session });
            await Account.findByIdAndUpdate(request.to, { $addToSet: { friends: request.from } }, { session });
        } else if (action === "reject") {
            request.status = "rejected";
            await request.save({ session });
        } else {
            throw new Error("Invalid action. Must be 'accept' or 'reject'");
        }

        await session.commitTransaction();
        session.endSession();

        if (action === "accept") await publishFriendshipChanged(String(request.from), String(request.to), "added");

        // Clear the recipient's bell entry; notify the sender based on action.
        resolveNotifications(userId, `fr:${request._id}`).catch(() => { /* logged inside */ });

        const actor = await findPersonById(userId, "name firstName lastName handle");
        const actorName = actor ? personDisplayName(actor.doc) : "Someone";

        if (action === "accept") {
            notify(request.from, {
                type: "system",
                title: `@${actorName} accepted your friend request`,
            }).catch(() => { /* logged inside */ });
        } else if (action === "reject") {
            notify(request.from, {
                type: "system",
                title: `@${actorName} declined your friend request`,
            }).catch(() => { /* logged inside */ });
        }

        const actionDisplay = action === "accept" ? "accepted" : "declined";
        res.json({ message: `Request ${actionDisplay} successfully` });
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
            const person = await findPersonById(id, "name firstName lastName handle userNumber discordId discordHandle profilePicture isActive");
            // A deactivated account drops out of its friends' lists (#31) but
            // stays in the arrays, so reactivating it brings them all back.
            return person && person.doc.isActive !== false ? toPublicPerson(person) : null;
        }))).filter(Boolean);

        res.json(friends);
    } catch (error) {
        console.error("List friends error:", error);
        res.status(500).json({ error: "Failed to fetch friends list" });
    }
});

// Remove friend
router.delete("/:id", auth, async (req: any, res) => {
    const session = await startSession();
    await session.startTransaction();
    try {
        const friendId = req.params.id;
        const userId = req.user.id;

        await Account.findByIdAndUpdate(userId, { $pull: { friends: friendId } }, { session });
        await Account.findByIdAndUpdate(friendId, { $pull: { friends: userId } }, { session });

        await session.commitTransaction();
        session.endSession();

        await publishFriendshipChanged(String(userId), String(friendId), "removed");
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

        const updated = await Account.findByIdAndUpdate(userId, { discordId, discordHandle });
        if (!updated) return res.status(404).json({ error: "Account not found" });

        res.json({ message: "Discord account linked successfully" });
    } catch (error) {
        console.error("Link discord error:", error);
        res.status(500).json({ error: "Failed to link discord" });
    }
});

export default router;
