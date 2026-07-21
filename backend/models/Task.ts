import { defineModel } from "../db/model.js";

const Task = defineModel({
  table: "tasks",
  fields: {
    title: "title", description: "description", status: "status", dueDate: "due_date",
    sfID: "sf_id", sfRecordTypeID: "sf_record_type_id", sfRecordTypeName: "sf_record_type_name",
    sfLastSynced: "sf_last_synced", notionPageId: "notion_page_id", notionLastSynced: "notion_last_synced",
    ownerId: "owner_id", ownerName: "owner_name", createdAt: "created_at",
  },
});
export default Task;
