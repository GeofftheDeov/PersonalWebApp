import { defineModel } from "../db/model.js";
import User from "./User.js";

export interface IMessage {
  role: "user" | "assistant";
  content: string;
}

const CloudClawSession = defineModel({
  table: "cloud_claw_sessions",
  fields: {
    userId: { col: "user_id", type: "uuid" },
    messages: { col: "messages", type: "jsonb" },
    createdAt: { col: "created_at", type: "date" }, updatedAt: { col: "updated_at", type: "date" },
  },
  refs: { userId: () => User },
});
export default CloudClawSession;
