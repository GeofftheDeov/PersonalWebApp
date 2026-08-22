import { defineModel } from "../db/model.js";

const Task = defineModel({
  table: "tasks",
  fields: {
    title: "title", description: "description", status: "status", dueDate: { col: "due_date", type: "date" },
    sfID: "sf_id", sfRecordTypeID: "sf_record_type_id", sfRecordTypeName: "sf_record_type_name",
    sfLastSynced: { col: "sf_last_synced", type: "date" }, notionPageId: "notion_page_id", notionLastSynced: { col: "notion_last_synced", type: "date" },
    ownerId: "owner_id", ownerName: "owner_name", createdAt: { col: "created_at", type: "date" },
  },
});
export default Task;
