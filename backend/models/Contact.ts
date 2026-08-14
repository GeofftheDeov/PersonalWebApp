import { defineModel } from "../db/model.js";
import { hashPasswordHook, fourDigit, digitTag } from "./_shared.js";

const Contact = defineModel({
  table: "contacts",
  fields: {
    name: "name", email: "email", password: "password",
    isVerified: "is_verified", emailVerificationToken: "email_verification_token",
    resetPasswordToken: "reset_password_token", resetPasswordExpires: "reset_password_expires",
    phone: "phone", handle: "handle", role: "role",
    accountId: { col: "account_id", type: "uuid" },
    userNumber: "user_number", userDigit: "user_digit", notes: "notes", sfID: "sf_id",
    profilePicture: "profile_picture",
    favoriteGames: { col: "favorite_games", type: "text[]" },
    friends: { col: "friends", type: "uuid[]" },
    createdAt: "created_at",
  },
  defaults: { userNumber: fourDigit, userDigit: digitTag("CON") },
  preSave: hashPasswordHook,
});
export default Contact;
