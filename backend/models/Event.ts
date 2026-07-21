import { defineModel } from "../db/model.js";

const Event = defineModel({
  table: "events",
  fields: {
    title: "title", description: "description", status: "status",
    startDate: "start_date", endDate: "end_date", createdAt: "created_at",
  },
});
export default Event;
