import mongoose from "mongoose";

/**
 * Direct campaign invite (friend-to-friend), distinct from the shareable join
 * link. Accepting creates a CampaignMember; both paths coexist.
 */
const CampaignInviteSchema = new mongoose.Schema({
    campaign: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", required: true, index: true },
    from: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    to: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    status: {
        type: String,
        enum: ["pending", "accepted", "declined"],
        default: "pending",
    },
    createdAt: { type: Date, default: Date.now },
});

CampaignInviteSchema.index({ campaign: 1, to: 1, status: 1 });

const CampaignInvite = mongoose.model("CampaignInvite", CampaignInviteSchema);
export default CampaignInvite;
