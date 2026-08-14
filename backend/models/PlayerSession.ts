import { defineModel } from "../db/model.js";
import Session from "./Session.js";
import Account from "./Account.js";
import Campaign from "./Campaign.js";

const PlayerSession = defineModel({
  table: "player_sessions",
  fields: {
    name: "name",
    session: { col: "session_id", type: "uuid" },
    player: { col: "player_id", type: "uuid" },
    campaign: { col: "campaign_id", type: "uuid" },
    sfID: "sf_id", createdAt: "created_at",
  },
  refs: { session: () => Session, player: () => Account, campaign: () => Campaign },
});
export default PlayerSession;
