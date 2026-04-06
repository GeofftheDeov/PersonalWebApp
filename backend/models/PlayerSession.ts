import mongoose from "mongoose";

const playerSessionSchema = new mongoose.Schema({
    name: { type: String, required: true },
    session: { type: mongoose.Schema.Types.ObjectId, ref: "Session", required: true },
    player: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true },
    campaign: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", required: true },
    sfID: String,
    createdAt: { type: Date, default: Date.now },
});

const PlayerSession = mongoose.model("PlayerSession", playerSessionSchema);
export default PlayerSession;
