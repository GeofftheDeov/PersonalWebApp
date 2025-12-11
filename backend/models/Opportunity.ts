import mongoose from "mongoose";

const opportunitySchema = new mongoose.Schema({
    name: { type: String, required: true },
    amount: Number,
    stage: {
        type: String,
        enum: ["Probe", "Negotiate", "Closed Won", "Closed Lost"],
        default: "Probe"
    },
    closeDate: Date,
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account" },
    createdAt: { type: Date, default: Date.now },
});

const Opportunity = mongoose.model("Opportunity", opportunitySchema);
export default Opportunity;
