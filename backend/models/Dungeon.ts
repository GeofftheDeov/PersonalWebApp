import { defineModel } from "../db/model.js";

const Dungeon = defineModel({
  table: "dungeons",
  fields: {
    name: "name", description: "description", level: "level",
    isCompleted: "is_completed", sfID: "sf_id", createdAt: "created_at",
  },
});
export default Dungeon;
