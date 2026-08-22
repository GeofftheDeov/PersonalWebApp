import { defineModel } from "../db/model.js";
import { hashPasswordHook, fourDigit, digitTag } from "./_shared.js";
import { createLeadFromAccount } from "../services/salesforceService.js";

// Phase 1 of the unified account model (#33) renamed this table to sf_accounts.
// NOTE: `accounts` is now a DIFFERENT, currently empty table — the app's single
// person table, filled by the Phase 2 backfill (#34). This model is the
// Salesforce Account landing table and must never be pointed back at
// "accounts".
const Account = defineModel({
  table: "sf_accounts",
  fields: {
    name: "name", email: "email", password: "password",
    resetPasswordToken: "reset_password_token", resetPasswordExpires: "reset_password_expires",
    isVerified: "is_verified", emailVerificationToken: "email_verification_token",
    industry: "industry", company: "company", website: "website", handle: "handle",
    phone: "phone", address: "address", userNumber: "user_number", userDigit: "user_digit",
    sfID: "sf_id", sfRecordTypeID: "sf_record_type_id", sfRecordTypeName: "sf_record_type_name",
    profilePicture: "profile_picture",
    favoriteGames: { col: "favorite_games", type: "text[]" },
    friends: { col: "friends", type: "uuid[]" },
    createdAt: "created_at",
  },
  defaults: { userNumber: fourDigit, userDigit: digitTag("ACC") },
  preSave: hashPasswordHook,
  postSave: (doc) => {
    if (doc.sfID) return;
    setImmediate(async () => {
      try {
        console.log("New Account saved, syncing to Salesforce...");
        const sf = await createLeadFromAccount(doc);
        if (sf?.id) {
          const update: any = { sfID: sf.id };
          if ((sf as any).recordTypeId) update.sfRecordTypeID = (sf as any).recordTypeId;
          if ((sf as any).recordTypeName) update.sfRecordTypeName = (sf as any).recordTypeName;
          await Account.updateOne({ _id: doc._id }, { $set: update });
          console.log(`Salesforce Account created with ID: ${sf.id}`);
        }
      } catch (err) { console.error("[SALESFORCE] Account sync error:", err); }
    });
  },
});
export default Account;
