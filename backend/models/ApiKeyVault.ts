import { defineModel } from "../db/model.js";
import Account from "./Account.js";

// Staff-only integration: its owner genuinely was a Salesforce User. Phase 3
// (#35) repointed the column at accounts, so the ref follows.
const ApiKeyVault = defineModel({
  table: "api_key_vault",
  fields: {
    userId: { col: "user_id", type: "uuid" },
    provider: "provider", label: "label",
    encryptedKeyId: "encrypted_key_id", encryptedSecret: "encrypted_secret",
    createdAt: { col: "created_at", type: "date" }, updatedAt: { col: "updated_at", type: "date" },
  },
  refs: { userId: () => Account },
});
export default ApiKeyVault;
