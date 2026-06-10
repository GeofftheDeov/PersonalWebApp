import mongoose from "mongoose";

/**
 * Game Night Planner chat message. Channel = campaign; optionally pinned to a
 * specific event (game night). History lives here; real-time fan-out happens
 * via the event bus (`gamenight.message`).
 */
const MessageSchema = new mongoose.Schema({
    campaign: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", required: true, index: true },
    event: { type: mongoose.Schema.Types.ObjectId, ref: "Event" },
    sender: {
        id: { type: String, required: true },
        name: { type: String, required: true },
        email: { type: String, required: true },
    },
    body: { type: String, required: true, trim: true, maxlength: 4000 },
    createdAt: { type: Date, default: Date.now, index: true },
});

MessageSchema.index({ campaign: 1, createdAt: -1 });

const Message = mongoose.model("Message", MessageSchema);
export default Message;
