import { defineModel } from "../db/model.js";
import Campaign from "./Campaign.js";
import Account from "./Account.js";

/**
 * Membership always points at a real person (#35, plan §3.5).
 *
 * `lead` / `contact` / `account` are the pre-Phase-3 columns, one per source
 * table, plus an `email` fallback for members who had no account at all. That
 * shape is why getAuthorizedCampaignIds had to OR over four things including an
 * unindexed email match. `person` replaces all of it; the old columns stay in
 * the schema until the cutover has soaked and are deliberately not mapped here,
 * so nothing new can start writing them.
 *
 * The "invited but has no account yet" state lives on campaign_invites.to_email.
 */
const CampaignMember = defineModel({
  table: "campaign_members",
  fields: {
    campaign: { col: "campaign_id", type: "uuid" },
    person: { col: "person_id", type: "uuid" },
    email: "email", phone: "phone", firstName: "first_name", lastName: "last_name",
    status: "status", joinedAt: { col: "joined_at", type: "date" }, sfID: "sf_id",
    createdAt: { col: "created_at", type: "date" },
  },
  refs: { campaign: () => Campaign, person: () => Account },
});
export default CampaignMember;
