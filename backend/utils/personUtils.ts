import mongoose from "mongoose";
import User from "../models/User.js";
import Lead from "../models/Lead.js";
import Contact from "../models/Contact.js";
import Account from "../models/Account.js";

/**
 * People can live in any of four collections (mirroring Salesforce person
 * records): User, Lead, Contact, Account. Auth tokens carry `type`, but ids
 * arriving from the client (friend ids, sender ids) may belong to any
 * collection, so these helpers resolve a person wherever they live.
 */

export type PersonType = "User" | "Lead" | "Contact" | "Account";

export const PERSON_MODELS: Record<PersonType, mongoose.Model<any>> = {
    User,
    Lead,
    Contact,
    Account,
};

const PERSON_TYPES: PersonType[] = ["User", "Lead", "Contact", "Account"];

export function modelForType(type?: string): mongoose.Model<any> {
    return PERSON_MODELS[(type as PersonType)] || Lead;
}

export interface ResolvedPerson {
    doc: any;
    type: PersonType;
}

/** Find a person by id, whichever collection they live in. */
export async function findPersonById(id: string | mongoose.Types.ObjectId, select?: string): Promise<ResolvedPerson | null> {
    if (!mongoose.Types.ObjectId.isValid(String(id))) return null;
    const results = await Promise.all(
        PERSON_TYPES.map(async (type) => {
            const q = PERSON_MODELS[type].findById(id);
            const doc = await (select ? q.select(select) : q);
            return doc ? { doc, type } : null;
        })
    );
    return results.find(Boolean) ?? null;
}

/** Find a person by handle#userNumber across all collections (case-insensitive handle). */
export async function findPersonByHandle(handle: string, userNumber: string): Promise<ResolvedPerson | null> {
    const query = {
        handle: { $regex: new RegExp(`^${escapeRegex(handle)}$`, "i") },
        userNumber,
    };
    const results = await Promise.all(
        PERSON_TYPES.map(async (type) => {
            const doc = await PERSON_MODELS[type].findOne(query);
            return doc ? { doc, type } : null;
        })
    );
    return results.find(Boolean) ?? null;
}

/** Find people by email across all collections. Returns every match. */
export async function findPeopleByEmail(emails: string[]): Promise<ResolvedPerson[]> {
    if (!emails.length) return [];
    const results = await Promise.all(
        PERSON_TYPES.map(async (type) => {
            const docs = await PERSON_MODELS[type].find({ email: { $in: emails } });
            return docs.map((doc: any) => ({ doc, type }));
        })
    );
    return results.flat();
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
    const { doc, type } = person;
    return {
        _id: doc._id,
        recordType: type,
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
