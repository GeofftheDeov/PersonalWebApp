import { defineModel } from "../db/model.js";

const Event = defineModel({
  table: "events",
  fields: {
    title: "title", description: "description", status: "status",
    startDate: { col: "start_date", type: "date" }, endDate: { col: "end_date", type: "date" }, createdAt: { col: "created_at", type: "date" },
    owner: { col: "owner_id", type: "uuid" },
  },
});
export default Event;
