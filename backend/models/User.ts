import { defineModel } from "../db/model.js";
import { hashPasswordHook, fourDigit, digitTag } from "./_shared.js";

const User = defineModel({
  table: "users",
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
