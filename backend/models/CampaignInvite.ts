import { defineModel } from "../db/model.js";
import Campaign from "./Campaign.js";
import User from "./User.js";

const CampaignInvite = defineModel({
  table: "campaign_invites",
  fields: {
    campaign: { col: "campaign_id", type: "uuid" },
    from: { col: "from_user", type: "uuid" },
    to: { col: "to_user", type: "uuid" },
    status: "status", createdAt: { col: "created_at", type: "date" },
  },
  refs: { campaign: () => Campaign, from: () => User, to: () => User },
});
export default CampaignInvite;
