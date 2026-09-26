import { defineModel } from "../db/model.js";

/**
 * Salesforce Contact landing table (see models/SfUser.ts).
 * `accountId` is Salesforce's own Contact -> Account relationship and keeps
 * pointing at sf_accounts.
 */
const SfContact = defineModel({
  table: "sf_contacts",
  fields: {
    name: "name", email: "email", password: "password",
    isVerified: "is_verified", emailVerificationToken: "email_verification_token",
    resetPasswordToken: "reset_password_token", resetPasswordExpires: { col: "reset_password_expires", type: "date" },
    phone: "phone", handle: "handle", role: "role",
    accountId: { col: "account_id", type: "uuid" },
    userNumber: "user_number", userDigit: "user_digit", notes: "notes", sfID: "sf_id",
    profilePicture: "profile_picture",
    favoriteGames: { col: "favorite_games", type: "text[]" },
    friends: { col: "friends", type: "uuid[]" },
    createdAt: { col: "created_at", type: "date" },
  },
});
export default SfContact;
