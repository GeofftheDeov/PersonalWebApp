import mongoose from "mongoose";

const sessionSchema = new mongoose.Schema({
    title: { type: String, required: true },
    campaign: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", required: true },
    date: { type: Date, default: Date.now },
    // End time — required when creating Discord (external) or Google Calendar events.
    endDate: Date,
    location: String,
    isOnline: { type: Boolean, default: false },
    agenda: String,
    summary: String,
    vodUrl: String,
    // External event integrations
    discordEventId: String,
    googleEventId: String,
    googleCalendarLink: String,
    sfID: String,
    // Ready-up check: sent ~30 minutes before the session starts. Players
    // respond via POST /api/tabletop/sessions/:id/ready.
    readyCheck: {
        sentAt: Date,
        responses: [{
            playerId: { type: String, required: true }, // person id (User/Lead/Contact/Account)
            name: String,
            ready: { type: Boolean, default: false },
            respondedAt: Date,
        }],
    },
    createdAt: { type: Date, default: Date.now },
});

const Session = mongoose.model("Session", sessionSchema);
export default Session;
