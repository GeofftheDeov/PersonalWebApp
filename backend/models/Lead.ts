import mongoose from "mongoose";

const leadSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: String,
    company: String,
    status: {
        type: String,
        enum: ["New", "Contacted", "Qualified", "Lost"],
        default: "New"
    },
    source: String,
    createdAt: { type: Date, default: Date.now },
});

const Lead = mongoose.model("Lead", leadSchema);
export default Lead;
