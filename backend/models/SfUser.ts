import { defineModel } from "../db/model.js";

/**
 * Salesforce User landing table. Read-only from the app's point of view: the
 * nightly pull writes here and the merge reads it. `sf_users` is pull-only in
 * both directions of ownership (§2.6) — creating a Salesforce User needs a
 * Platform Event and a spare User licence, and the org has neither.
 *
 * The app's person table is `models/Account.ts`. Nothing outside syncRoutes and
 * the admin table browser should import this.
 */
const SfUser = defineModel({
  table: "sf_users",
  fields: {
    name: "name", email: "email", phone: "phone", handle: "handle", password: "password",
    resetPasswordToken: "reset_password_token", resetPasswordExpires: { col: "reset_password_expires", type: "date" },
    isVerified: "is_verified", emailVerificationToken: "email_verification_token",
    role: "role", userNumber: "user_number", userDigit: "user_digit",
    sfID: "sf_id", discordId: "discord_id", discordHandle: "discord_handle",
    profilePicture: "profile_picture",
    favoriteGames: { col: "favorite_games", type: "text[]" },
    friends: { col: "friends", type: "uuid[]" },
    createdAt: { col: "created_at", type: "date" }, updatedAt: { col: "updated_at", type: "date" },
  },
});
export default SfUser;
