import { defineModel } from "../db/model.js";
import { hashPasswordHook, fourDigit, digitTag } from "./_shared.js";
import { createLeadInSalesforce } from "../services/salesforceService.js";

const Lead = defineModel({
  table: "leads",
  fields: {
    firstName: "first_name", lastName: "last_name", email: "email", password: "password",
    resetPasswordToken: "reset_password_token", resetPasswordExpires: "reset_password_expires",
    isVerified: "is_verified", emailVerificationToken: "email_verification_token",
    company: "company", handle: "handle", phone: "phone",
    status: "status", source: "source",
    userNumber: "user_number", userDigit: "user_digit",
    sfLeadId: "sf_lead_id", sfRecordTypeId: "sf_record_type_id", sfRecordTypeName: "sf_record_type_name",
    profilePicture: "profile_picture",
    favoriteGames: { col: "favorite_games", type: "text[]" },
    friends: { col: "friends", type: "uuid[]" },
    createdAt: "created_at",
  },
  defaults: { userNumber: fourDigit, userDigit: digitTag("LD") },
  preSave: hashPasswordHook,
  postSave: (doc) => {
    if (doc.sfLeadId) return;
    setImmediate(async () => {
      try {
        console.log("[SALESFORCE] New Lead saved, starting background sync...");
        const sf = await createLeadInSalesforce(doc);
        if (sf?.id) {
          const update: any = { sfLeadId: sf.id };
          if ((sf as any).recordTypeId) update.sfRecordTypeId = (sf as any).recordTypeId;
          if ((sf as any).recordTypeName) update.sfRecordTypeName = (sf as any).recordTypeName;
          await Lead.updateOne({ _id: doc._id }, { $set: update });
          console.log(`[SALESFORCE] Result: Success (ID: ${sf.id})`);
        }
      } catch (err) { console.error("[SALESFORCE] Background Sync Error:", err); }
    });
  },
});
export default Lead;
