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
    // Polymorphic reference or just generic related fields? 
    // For simplicity now, let's keep it unlinked or manual until specific requirements allow
    createdAt: { type: Date, default: Date.now },
});

const Campaign = mongoose.model("Campaign", campaignSchema);
export default Campaign;
