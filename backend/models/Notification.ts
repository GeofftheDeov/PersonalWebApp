import mongoose from "mongoose";

/**
 * Bell notification. One document per alert; "message" notifications are
 * deduped per source (campaign or DM partner) via `sourceKey` while unread —
 * `count` tracks how many messages piled up behind a single bell entry.
 */
const NotificationSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: {
        type: String,
        enum: ["friend_request", "campaign_invite", "message", "system"],
        required: true,
    },
    title: { type: String, required: true },
    body: { type: String },
    /** Frontend route to open when clicked (optional). */
    link: { type: String },
    /** Dedupe key while unread, e.g. "campaign:<id>", "dm:<userId>", "fr:<requestId>". */
    sourceKey: { type: String },
    /** Extra context the bell needs (requestId, inviteId, campaignId, ...). */
    meta: { type: mongoose.Schema.Types.Mixed },
    count: { type: Number, default: 1 },
    read: { type: Boolean, default: false, index: true },
    createdAt: { type: Date, default: Date.now, index: true },
});

NotificationSchema.index({ user: 1, read: 1, createdAt: -1 });
NotificationSchema.index({ user: 1, type: 1, sourceKey: 1, read: 1 });

const Notification = mongoose.model("Notification", NotificationSchema);
export default Notification;
