import { defineModel } from "../db/model.js";
import User from "./User.js";

const ApiKeyVault = defineModel({
  table: "api_key_vault",
  fields: {
    userId: { col: "user_id", type: "uuid" },
    provider: "provider", label: "label",
    encryptedKeyId: "encrypted_key_id", encryptedSecret: "encrypted_secret",
    createdAt: "created_at", updatedAt: "updated_at",
  },
  refs: { userId: () => User },
});
export default ApiKeyVault;
