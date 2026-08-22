import { defineModel } from "../db/model.js";
import Campaign from "./Campaign.js";
import Lead from "./Lead.js";
import Contact from "./Contact.js";
import Account from "./Account.js";

const CampaignMember = defineModel({
  table: "campaign_members",
  fields: {
    campaign: { col: "campaign_id", type: "uuid" },
    lead: { col: "lead_id", type: "uuid" },
    contact: { col: "contact_id", type: "uuid" },
    account: { col: "account_id", type: "uuid" },
    email: "email", phone: "phone", firstName: "first_name", lastName: "last_name",
    status: "status", joinedAt: { col: "joined_at", type: "date" }, sfID: "sf_id", createdAt: { col: "created_at", type: "date" },
  },
  refs: { campaign: () => Campaign, lead: () => Lead, contact: () => Contact, account: () => Account },
});
export default CampaignMember;
