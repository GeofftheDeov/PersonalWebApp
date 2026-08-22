import { defineModel } from "../db/model.js";
import { hashPasswordHook, fourDigit, digitTag } from "./_shared.js";

// Phase 1 of the unified account model (#33) renamed this table to sf_contacts.
// It is now a Salesforce landing table. account_id still points at sf_accounts,
// which is Salesforce's own Contact -> Account relationship and stays that way.
const Contact = defineModel({
  table: "sf_contacts",
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
