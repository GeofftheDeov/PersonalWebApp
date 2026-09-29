import { defineModel } from "../db/model.js";

/**
 * Salesforce Lead landing table (see models/SfUser.ts).
 *
 * The setImmediate postSave push that used to live here is gone: registration
 * writes an `accounts` row and the outbox drains to Salesforce nightly (§2.8),
 * so a signup no longer waits on a Salesforce round-trip inside the request.
 */
const SfLead = defineModel({
  table: "sf_leads",
  fields: {
    firstName: "first_name", lastName: "last_name", email: "email", password: "password",
    resetPasswordToken: "reset_password_token", resetPasswordExpires: { col: "reset_password_expires", type: "date" },
    isVerified: "is_verified", emailVerificationToken: "email_verification_token",
    company: "company", handle: "handle", phone: "phone",
    status: "status", source: "source",
    userNumber: "user_number", userDigit: "user_digit",
    sfLeadId: "sf_lead_id", sfRecordTypeId: "sf_record_type_id", sfRecordTypeName: "sf_record_type_name",
    profilePicture: "profile_picture",
    favoriteGames: { col: "favorite_games", type: "text[]" },
    friends: { col: "friends", type: "uuid[]" },
    createdAt: { col: "created_at", type: "date" },
  },
});
export default SfLead;
