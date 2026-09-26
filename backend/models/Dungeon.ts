import { defineModel } from "../db/model.js";

const Dungeon = defineModel({
  table: "dungeons",
  fields: {
    name: "name", description: "description", level: "level",
    isCompleted: "is_completed", sfID: "sf_id", createdAt: { col: "created_at", type: "date" },
  },
});
export default Dungeon;
