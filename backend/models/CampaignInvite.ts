import { defineModel } from "../db/model.js";
import Campaign from "./Campaign.js";
import Account from "./Account.js";

/**
 * Campaign invites (#35, plan §3.5).
 *
 * These refs were deliberately absent before Phase 3: an invite could go to a
 * User, Lead, Contact or Account, and populate() resolves exactly one declared
 * model, so declaring one would have quietly returned null for the other three.
 * One person table, so both sides can be declared now.
 *
 * `to` is nullable and pairs with `toEmail`: a GM can invite somebody who has
 * no account yet, and registration binds the pending invite to the new account.
 * The database CHECK requires exactly one of the two.
 */
const CampaignInvite = defineModel({
  table: "campaign_invites",
  fields: {
    campaign: { col: "campaign_id", type: "uuid" },
    from: { col: "from_account_id", type: "uuid" },
    to: { col: "to_account_id", type: "uuid" },
    toEmail: "to_email",
    status: "status", createdAt: { col: "created_at", type: "date" },
  },
  refs: { campaign: () => Campaign, from: () => Account, to: () => Account },
});
export default CampaignInvite;
