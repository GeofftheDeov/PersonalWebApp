import { randomUUID } from "node:crypto";
import { defineModel } from "../db/model.js";
import { hashPasswordHook, fourDigit, digitTag } from "./_shared.js";

/**
 * The app's single person table (#35, plan §2.2).
 *
 * Before Phase 3 this model pointed at the Salesforce Account landing table and
 * a person could live in any of four collections. Now everyone is an account:
 * `models/SfAccount.ts` is the landing table, and this is the app.
 *
 * There is no postSave Salesforce push any more. The old `setImmediate` hook
 * fired inside the signup request, had no retries, and left a half-created
 * person whenever Salesforce was unreachable. Writes now enqueue on
 * `person_outbox` and drain nightly with backoff (§2.7).
 *
 * Two axes, deliberately two columns (#28): `appRole` gates authorization,
 * `accountTier` gates supporter-only surface. Never collapse them — a tier
 * change must never move somebody's access.
 */
const Account = defineModel({
  table: "accounts",
  fields: {
    // accounts.id carries no database default on purpose: Phase 2 supplies it so
    // the winning source row donates its UUID and existing references need no
    // remap. That makes minting one the app's job for people it creates itself.
    _id: { col: "id", type: "uuid" },

    email: "email", password: "password",
    isVerified: "is_verified", emailVerificationToken: "email_verification_token",
    resetPasswordToken: "reset_password_token",
    resetPasswordExpires: { col: "reset_password_expires", type: "date" },

    appRole: "app_role", appRoleSource: "app_role_source",
    accountTier: "account_tier", accountTierSource: "account_tier_source",

    name: "name", firstName: "first_name", lastName: "last_name",
    handle: "handle", userNumber: "user_number", userDigit: "user_digit",
    profilePicture: "profile_picture",
    favoriteGames: { col: "favorite_games", type: "text[]" },
    discordId: "discord_id", discordHandle: "discord_handle",
    friends: { col: "friends", type: "uuid[]" },
    isActive: "is_active",

    phone: "phone", company: "company", industry: "industry",
    website: "website", address: "address", leadStatus: "lead_status",
    sfProfile: "sf_profile",

    sfObject: "sf_object", sfID: "sf_id",
    sfRecordTypeID: "sf_record_type_id", sfRecordTypeName: "sf_record_type_name",
    sfLastSyncedAt: { col: "sf_last_synced_at", type: "date" },
    sfLastPushedAt: { col: "sf_last_pushed_at", type: "date" },

    createdAt: { col: "created_at", type: "date" },
    updatedAt: { col: "updated_at", type: "date" },
  },
  defaults: {
    _id: randomUUID,
    userNumber: fourDigit,
    userDigit: digitTag("LD"),   // app signups enter the CRM as Leads (§2.8)
    sfObject: "Lead",
  },
  preSave: hashPasswordHook,
});
export default Account;
