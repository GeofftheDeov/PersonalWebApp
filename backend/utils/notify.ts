import mongoose from "mongoose";
import Notification from "../models/Notification.js";
import { bus } from "../events/index.js";

interface NotifyInput {
    type: "friend_request" | "campaign_invite" | "message" | "system";
    title: string;
    body?: string;
    link?: string;
    /** When set, unread notifications with the same key collapse into one. */
    sourceKey?: string;
    meta?: Record<string, any>;
}

/**
 * Create (or refresh) a bell notification for a user, then announce it on the
 * event bus. Never throws — notifications are best-effort side effects and
 * must not fail the request that triggered them.
 */
export async function notify(userId: string | mongoose.Types.ObjectId, input: NotifyInput) {
    try {
        let doc;
        if (input.sourceKey) {
            // Collapse repeat alerts from the same source while unread; `count`
            // tracks how many piled up behind one bell entry. $inc yields 1 on
            // insert (missing field counts as 0), so no $setOnInsert needed.
            doc = await Notification.findOneAndUpdate(
                { user: userId, type: input.type, sourceKey: input.sourceKey, read: false },
                {
                    $set: {
                        title: input.title,
                        body: input.body,
                        link: input.link,
                        meta: input.meta,
                        read: false,
                        createdAt: new Date(), // bump to top of the bell
                    },
                    $inc: { count: 1 },
                },
                { upsert: true, new: true }
            );
        } else {
            doc = await Notification.create({
                user: userId,
                type: input.type,
                title: input.title,
                body: input.body,
                link: input.link,
                meta: input.meta,
            });
        }

        if (doc) {
            bus.publish("user.notification", {
                notificationId: String(doc._id),
                userId: String(userId),
                type: input.type,
                title: input.title,
                body: input.body,
                link: input.link,
                createdAt: doc.createdAt.toISOString(),
            }).catch(() => { /* bus down is non-fatal */ });
        }
        return doc;
    } catch (err: any) {
        console.error("[notify] failed:", err.message);
        return null;
    }
}

/** Mark notifications matching a sourceKey as read (e.g. request resolved elsewhere). */
export async function resolveNotifications(userId: string | mongoose.Types.ObjectId, sourceKey: string) {
    try {
        await Notification.updateMany({ user: userId, sourceKey, read: false }, { $set: { read: true } });
    } catch (err: any) {
        console.error("[notify] resolve failed:", err.message);
    }
}
