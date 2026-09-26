import { defineModel } from "../db/model.js";
import Account from "./Account.js";

export interface IMessage {
  role: "user" | "assistant";
  content: string;
}

// Staff-only integration; see ApiKeyVault. Repointed at accounts by #35.
const CloudClawSession = defineModel({
  table: "cloud_claw_sessions",
  fields: {
    userId: { col: "user_id", type: "uuid" },
    messages: { col: "messages", type: "jsonb" },
    createdAt: { col: "created_at", type: "date" }, updatedAt: { col: "updated_at", type: "date" },
  },
  refs: { userId: () => Account },
});
export default CloudClawSession;
