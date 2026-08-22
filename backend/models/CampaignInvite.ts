import { defineModel } from "../db/model.js";
import Campaign from "./Campaign.js";

const CampaignInvite = defineModel({
  table: "campaign_invites",
  fields: {
    campaign: { col: "campaign_id", type: "uuid" },
    // Polymorphic person refs: an invite can go to (or come from) a User, Lead,
    // Contact or Account. They are deliberately NOT in `refs` — populate()
    // resolves exactly one declared model, so declaring User here would quietly
    // return null for the other three. inviteRoutes resolves both sides with
    // personUtils.findPersonById instead, the way friendRoutes does.
    from: { col: "from_user", type: "uuid" },
    to: { col: "to_user", type: "uuid" },
    status: "status", createdAt: { col: "created_at", type: "date" },
  },
  refs: { campaign: () => Campaign },
});
export default CampaignInvite;
