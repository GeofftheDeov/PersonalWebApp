import mongoose from "mongoose";

const sessionSchema = new mongoose.Schema({
    title: { type: String, required: true },
    campaign: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", required: true },
    date: { type: Date, default: Date.now },
    location: String,
    agenda: String,
    summary: String,
    vodUrl: String,
    sfID: String,
    createdAt: { type: Date, default: Date.now },
});

const Session = mongoose.model("Session", sessionSchema);
export default Session;
