import mongoose from "mongoose";
const campaignMemberSchema = new mongoose.Schema({
    campaign: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", required: true },
    lead: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", required: false },
    contact: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: false },
    account: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: false },
    email: { type: String, required: false },
    phone: { type: String, required: false },
    firstName: { type: String, required: false },
    lastName: { type: String, required: false },
    status: { type: String, required: false },
    joinedAt: { type: Date, default: Date.now, required: false },
    sfID: String,
    createdAt: { type: Date, default: Date.now },
});
const CampaignMember = mongoose.model("CampaignMember", campaignMemberSchema);
export default CampaignMember;
