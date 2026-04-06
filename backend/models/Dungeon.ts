import mongoose from "mongoose";

const dungeonSchema = new mongoose.Schema({
    name: { type: String, required: true },
    description: String,
    level: Number,
    isCompleted: { type: Boolean, default: false },
    sfID: String,
    createdAt: { type: Date, default: Date.now },
});

const Dungeon = mongoose.model("Dungeon", dungeonSchema);
export default Dungeon;
