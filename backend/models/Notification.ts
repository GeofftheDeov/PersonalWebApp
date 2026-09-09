import { defineModel } from "../db/model.js";
import Account from "./Account.js";

// user_id could hold any of the four person tables while this ref named User,
// so populate() silently returned null for most people. Correct since #35.
const Notification = defineModel({
  table: "notifications",
  fields: {
    user: { col: "user_id", type: "uuid" },
    type: "type", title: "title", body: "body", link: "link", sourceKey: "source_key",
    meta: { col: "meta", type: "jsonb" },
    count: "count", read: "read", createdAt: { col: "created_at", type: "date" },
  },
  refs: { user: () => Account },
});
export default Notification;
