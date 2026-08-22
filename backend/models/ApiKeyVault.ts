import { defineModel } from "../db/model.js";
import User from "./User.js";

const ApiKeyVault = defineModel({
  table: "api_key_vault",
  fields: {
    userId: { col: "user_id", type: "uuid" },
    provider: "provider", label: "label",
    encryptedKeyId: "encrypted_key_id", encryptedSecret: "encrypted_secret",
    createdAt: { col: "created_at", type: "date" }, updatedAt: { col: "updated_at", type: "date" },
  },
  refs: { userId: () => User },
});
export default ApiKeyVault;
