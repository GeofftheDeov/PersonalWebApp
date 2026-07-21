import { defineModel } from "../db/model.js";
import User from "./User.js";

const Notification = defineModel({
  table: "notifications",
  fields: {
    user: { col: "user_id", type: "uuid" },
    type: "type", title: "title", body: "body", link: "link", sourceKey: "source_key",
    meta: { col: "meta", type: "jsonb" },
    count: "count", read: "read", createdAt: "created_at",
  },
  refs: { user: () => User },
});
export default Notification;
