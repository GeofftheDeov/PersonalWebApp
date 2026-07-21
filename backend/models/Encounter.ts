import { defineModel } from "../db/model.js";
import Session from "./Session.js";
import Dungeon from "./Dungeon.js";

const Encounter = defineModel({
  table: "encounters",
  fields: {
    name: "name", description: "description", difficulty: "difficulty", type: "type",
    session: { col: "session_id", type: "uuid" },
    dungeon: { col: "dungeon_id", type: "uuid" },
    sfID: "sf_id", createdAt: "created_at",
  },
  refs: { session: () => Session, dungeon: () => Dungeon },
});
export default Encounter;
