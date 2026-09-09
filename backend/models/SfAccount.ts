import { defineModel } from "../db/model.js";

/**
 * Salesforce Account landing table (see models/SfUser.ts).
 *
 * Until Phase 3 this table was what `models/Account.ts` pointed at. It is now
 * the landing table only; `Account` is the app's unified person table. Pointing
 * either one at the other's table is the mistake this pair of files exists to
 * make hard.
 */
const SfAccount = defineModel({
  table: "sf_accounts",
  fields: {
    name: "name", email: "email", password: "password",
    resetPasswordToken: "reset_password_token", resetPasswordExpires: { col: "reset_password_expires", type: "date" },
    isVerified: "is_verified", emailVerificationToken: "email_verification_token",
    industry: "industry", company: "company", website: "website", handle: "handle",
    phone: "phone", address: "address", userNumber: "user_number", userDigit: "user_digit",
    sfID: "sf_id", sfRecordTypeID: "sf_record_type_id", sfRecordTypeName: "sf_record_type_name",
    profilePicture: "profile_picture",
    favoriteGames: { col: "favorite_games", type: "text[]" },
    friends: { col: "friends", type: "uuid[]" },
    createdAt: { col: "created_at", type: "date" },
  },
});
export default SfAccount;
