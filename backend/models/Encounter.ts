import mongoose from "mongoose";

const encounterSchema = new mongoose.Schema({
    name: { type: String, required: true },
    description: String,
    difficulty: {
        type: String,
        enum: ["Easy", "Medium", "Hard", "Deadly"],
        default: "Medium"
    },
    type: {
        type: String,
        enum: ["Combat", "Social", "Exploration", "Other"],
        default: "Combat"
    },
    session: { type: mongoose.Schema.Types.ObjectId, ref: "Session" },
    dungeon: { type: mongoose.Schema.Types.ObjectId, ref: "Dungeon" },
    sfID: String,
    createdAt: { type: Date, default: Date.now },
});

const Encounter = mongoose.model("Encounter", encounterSchema);
export default Encounter;
