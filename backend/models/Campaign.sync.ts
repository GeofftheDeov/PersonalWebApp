import mongoose from "mongoose";

const campaignSchema = new mongoose.Schema({
    title: { type: String, required: true },
    description: String,
    status: {
        type: String,
        enum: ["Not Started", "In Progress", "Completed"],
        default: "Not Started"
    },
    startDate: Date,
    endDate: Date,
    // Discord integration: the server (guild) where session events are created.
    // The session creator's bot (token stored in their API Key Vault under
    // provider 'discord') must be a member of this guild with Manage Events.
    discordGuildId: String,
    // Optional voice channel — if set, Discord events are created as VOICE
    // events in this channel; otherwise EXTERNAL events with a location.
    discordChannelId: String,
    sfID: String,
    // Polymorphic reference or just generic related fields?
    // For simplicity now, let's keep it unlinked or manual until specific requirements allow
    createdAt: { type: Date, default: Date.now },
});

const Campaign = mongoose.model("Campaign", campaignSchema);

export default Campaign;
