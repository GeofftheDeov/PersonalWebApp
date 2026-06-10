import mongoose from "mongoose";

/**
 * Chat message. Two channel kinds:
 *  - Campaign ("Table Talk"): `campaign` is set; optionally pinned to an event.
 *  - Direct message: `dmKey` is set — the two participant user ids, sorted and
 *    joined with ":" — plus `recipient` for notification fan-out.
 * History lives here; real-time fan-out happens via the event bus
 * (`gamenight.message` for campaigns, `social.dm` for DMs).
 */
const MessageSchema = new mongoose.Schema({
    campaign: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", index: true },
    event: { type: mongoose.Schema.Types.ObjectId, ref: "Event" },
    dmKey: { type: String, index: true },
    recipient: { type: String }, // user id (DMs only)
    sender: {
        id: { type: String, required: true },
        name: { type: String, required: true },
        email: { type: String, required: true },
    },
    body: { type: String, required: true, trim: true, maxlength: 4000 },
    createdAt: { type: Date, default: Date.now, index: true },
});

MessageSchema.pre("validate", function () {
    if (!this.campaign && !this.dmKey) {
        throw new Error("Message requires either a campaign or a dmKey");
    }
});

MessageSchema.index({ campaign: 1, createdAt: -1 });
MessageSchema.index({ dmKey: 1, createdAt: -1 });

const Message = mongoose.model("Message", MessageSchema);
export default Message;
