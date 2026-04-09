import mongoose from "mongoose";
const characterSchema = new mongoose.Schema({
    name: { type: String, required: true },
    player: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true },
    campaign: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign" },
    dungeon: { type: mongoose.Schema.Types.ObjectId, ref: "Dungeon" },
    gameType: String,
    class: String,
    level: { type: Number, default: 1 },
    isDead: { type: Boolean, default: false },
    sfID: String,
    createdAt: { type: Date, default: Date.now },
});
const Character = mongoose.model("Character", characterSchema);
export default Character;
