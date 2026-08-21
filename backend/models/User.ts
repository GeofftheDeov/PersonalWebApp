import { defineModel } from "../db/model.js";
import { hashPasswordHook, fourDigit, digitTag } from "./_shared.js";

// Phase 1 of the unified account model (#33) renamed this table to sf_users.
// It is now a Salesforce landing table: the nightly pull writes into it and the
// app reads it. App writes move to the `accounts` table in Phase 3 (#35).
const User = defineModel({
  table: "sf_users",
  fields: {
    name: "name", email: "email", phone: "phone", handle: "handle", password: "password",
    resetPasswordToken: "reset_password_token", resetPasswordExpires: "reset_password_expires",
    isVerified: "is_verified", emailVerificationToken: "email_verification_token",
    role: "role", userNumber: "user_number", userDigit: "user_digit",
    sfID: "sf_id", discordId: "discord_id", discordHandle: "discord_handle",
    profilePicture: "profile_picture",
    favoriteGames: { col: "favorite_games", type: "text[]" },
    friends: { col: "friends", type: "uuid[]" },
    createdAt: "created_at", updatedAt: "updated_at",
  },
  defaults: { userNumber: fourDigit, userDigit: digitTag("ADM") },
  preSave: hashPasswordHook,
});
export default User;
