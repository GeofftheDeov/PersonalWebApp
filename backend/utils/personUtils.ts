import { isUuid } from "../db/model.js";
import Account from "../models/Account.js";

/**
 * Person lookups (#35, plan §3.1).
 *
 * These helpers used to fan out across four collections — User, Lead, Contact,
 * Account — because a person could live in any of them. Every call was four
 * round-trips, and `findPersonById` is called in a loop in friendRoutes, so
 * rendering a friends list cost O(4n) queries.
 *
 * Since the Phase 3 cutover everyone is a row in `accounts`, so each of these
 * is one indexed query. The exported names and signatures are unchanged, which
 * is what kept ~40 call sites from churning.
 *
 * `PersonType` and `modelForType` are gone deliberately, along with
 * `ResolvedPerson.type`. `type === "User"` was used across the app as a proxy
 * for "a real app user, not a CRM record"; after the merge everyone is an
 * account, so every one of those gates would have silently opened to everybody
 * or closed to everybody. Keeping a vestigial `type` would have let one survive
 * unnoticed. Capability now comes from an explicit column — `app_role` for
 * authorization, `account_tier` for supporter-only surface — and `sf_object`
 * remains as provenance only: where the record came from, never what it may do.
 */

export interface ResolvedPerson {
    doc: any;
}

/** Find a person by id. */
export async function findPersonById(id: string, select?: string): Promise<ResolvedPerson | null> {
    if (!isUuid(String(id))) return null;
    const q = Account.findById(id);
    const doc = await (select ? q.select(select) : q);
    return doc ? { doc } : null;
}

/** Find a person by handle#userNumber (case-insensitive handle). */
export async function findPersonByHandle(handle: string, userNumber: string): Promise<ResolvedPerson | null> {
    // ux_accounts_handle is on (lower(handle), user_number), so the regex form
    // the four-table version needed is both unnecessary and unindexable here.
    const doc = await Account.findOne({
        handle: { $regex: new RegExp(`^${escapeRegex(handle)}$`, "i") },
        userNumber,
    });
    return doc ? { doc } : null;
}

/** Find people by email. Returns every match (email is unique, so at most one). */
export async function findPeopleByEmail(emails: string[]): Promise<ResolvedPerson[]> {
    if (!emails.length) return [];
    const docs = await Account.find({ email: { $in: emails } });
    return docs.map((doc: any) => ({ doc }));
}

/** Human display name: prefers handle, then name fields, never the email. */
export function personDisplayName(doc: any): string {
    if (doc?.handle) return doc.handle;
    if (doc?.name) return doc.name;
    const fullName = [doc?.firstName, doc?.lastName].filter(Boolean).join(" ");
    if (fullName) return fullName;
    // Last resort: local part of the email, never the full address.
    if (doc?.email) return String(doc.email).split("@")[0];
    return "Unknown Player";
}

/** Safe, public subset of a person record for profile viewing / search results. */
export function toPublicPerson(person: ResolvedPerson) {
    const { doc } = person;
    return {
        _id: doc._id,
        // Provenance, not capability: which Salesforce object this person came
        // from. Nothing may gate on it except the Paperclip check in
        // paperclipRoutes, which is documented there.
        recordType: doc.sfObject ?? null,
        name: personDisplayName(doc),
        handle: doc.handle ?? null,
        userNumber: doc.userNumber ?? null,
        profilePicture: doc.profilePicture ?? null,
        favoriteGames: doc.favoriteGames ?? [],
        discordId: doc.discordId ?? null,
        discordHandle: doc.discordHandle ?? null,
        createdAt: doc.createdAt ?? null,
    };
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
