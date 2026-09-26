import { defineModel } from "../db/model.js";
import Account from "./Account.js";
import Campaign from "./Campaign.js";
import Dungeon from "./Dungeon.js";

const Character = defineModel({
  table: "characters",
  fields: {
    name: "name",
    player: { col: "player_id", type: "uuid" },
    campaign: { col: "campaign_id", type: "uuid" },
    dungeon: { col: "dungeon_id", type: "uuid" },
    gameType: "game_type", class: "class", level: "level", isDead: "is_dead",
    sfID: "sf_id", createdAt: { col: "created_at", type: "date" },
  },
  refs: { player: () => Account, campaign: () => Campaign, dungeon: () => Dungeon },
});
export default Character;
