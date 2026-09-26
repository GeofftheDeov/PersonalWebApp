/**
 * Move production's Mongo data into Neon `production` (#49, the data half of #45).
 *
 * Reads a `mongodump` DIRECTORY (not --archive) of the July build's database and
 * writes it into the RELEASE schema — the one at b18fa67: person rows land in
 * sf_users / sf_accounts / sf_contacts / sf_leads, which is what the release
 * build reads. The unified `accounts` table is not touched; filling it is the
 * Phase 2 backfill (#34), a later, separate, reversible step.
 *
 *   # 1. Profile the dump. No database needed, nothing written.
 *   npx tsx scripts/mongo-to-neon.ts ./dump/personal_web_app
 *
 *   # 2. Load it inside a transaction, report everything, roll back.
 *   npx tsx scripts/mongo-to-neon.ts --dry-run ./dump/personal_web_app
 *
 *   # 3. The same, and commit.
 *   npx tsx scripts/mongo-to-neon.ts --apply ./dump/personal_web_app
 *
 * Options:
 *   --replace          target tables may already hold rows; TRUNCATE them first
 *                      (same transaction). For re-running into a scratch branch.
 *                      Never use it against a production branch that has gone live.
 *   --allow-unmapped   the dump has collections no model owns; skip them.
 *   --accept-data-loss rows that exist in Mongo but that the release schema cannot
 *                      hold (e.g. a Lead's stored API key: api_key_vault's FK admits
 *                      only sf_users) are left out. Refused without this flag.
 *   --report <file>    where to write the JSON report (default ./mongo-to-neon-report.json)
 *   --batch <n>        rows per INSERT (default 500)
 *
 * IDS. Every ObjectId becomes uuidv5(hex, NAMESPACE) — a pure function, so a
 * re-run produces identical ids, a dry run predicts the real run exactly, and a
 * reference to a document deleted years ago maps to the same uuid it would
 * have had. The ids will not match dev's; dev was filled by Salesforce sync.
 * Nothing joins across the two.
 *
 * REFERENCES that point at nothing (a Lead deleted by the July Lead -> Account
 * conversion, a deleted campaign or dungeon) are handled by one rule:
 *   - a column with a real FK gets the schema's own ON DELETE behaviour, as if
 *     the parent had been deleted after the load: CASCADE -> the row is
 *     excluded, SET NULL -> the column is NULL;
 *   - a person reference with no FK (friends[], friend_requests, messages,
 *     characters.player_id, ...) is kept, mapped like any other id. It dangled
 *     in Mongo and it dangles identically here — parity, not repair.
 * Every exclusion, every NULL and every dangling id is listed in the report.
 *
 * All writes happen in ONE transaction. --apply commits only if every row
 * inserted; any failure rolls the whole load back.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { BSON, ObjectId } from "bson";

// ---------------------------------------------------------------- ids

/** Fixed forever. Changing it changes every migrated id. */
export const NAMESPACE = "9c87b100-6902-445f-a65e-558e34b8a9f4";
const HEX24 = /^[0-9a-f]{24}$/i;
const HEX24_TOKEN = /\b[0-9a-f]{24}\b/gi;

function uuidv5(name: string, namespace = NAMESPACE): string {
    const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
    const h = createHash("sha1").update(ns).update(name, "utf8").digest();
    h[6] = (h[6] & 0x0f) | 0x50;
    h[8] = (h[8] & 0x3f) | 0x80;
    const x = h.subarray(0, 16).toString("hex");
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** ObjectId or 24-hex string -> lowercase hex; anything else -> null. */
function hexOf(v: any): string | null {
    if (v instanceof ObjectId) return v.toHexString();
    if (v && typeof v === "object" && v._bsontype === "ObjectId") return v.toHexString();
    if (typeof v === "string" && HEX24.test(v)) return v.toLowerCase();
    return null;
}

export const idFor = (hex: string) => uuidv5(hex.toLowerCase());

// ---------------------------------------------------------------- mapping

type Col =
    | { col: string; kind: "pk" }
    | { col: string; kind: "value"; from: string; notNullDefault?: boolean }
    | { col: string; kind: "createdAt"; from?: string }
    | { col: string; kind: "updatedAt" }
    | { col: string; kind: "textArr"; from: string }
    | { col: string; kind: "fk"; from: string; target: string; onMissing: "exclude" | "null" }
    | { col: string; kind: "person"; from: string }
    | { col: string; kind: "personArr"; from: string }
    | { col: string; kind: "idText"; from: string }
    | { col: string; kind: "dmKey"; from: string }
    | { col: string; kind: "sourceKey"; from: string }
    | { col: string; kind: "link"; from: string }
    | { col: string; kind: "readyCheck"; from: string }
    | { col: string; kind: "meta"; from: string }
    | { col: string; kind: "json"; from: string; notNullDefault?: boolean };

interface TableMap { collection: string; table: string; cols: Col[] }

const v = (col: string, from: string, notNullDefault = false): Col => ({ col, kind: "value", from, notNullDefault });
const fk = (col: string, from: string, target: string, onMissing: "exclude" | "null"): Col =>
    ({ col, kind: "fk", from, target, onMissing });
const PK: Col = { col: "id", kind: "pk" };
const CREATED: Col = { col: "created_at", kind: "createdAt" };

/** The four person collections. A person reference may point into any of them. */
const PERSON_COLLECTIONS = ["users", "accounts", "contacts", "leads"];

/**
 * Collection -> table, field -> column. Taken from the July Mongoose models
 * (4ca0afec) on the source side and the b18fa67 defineModel maps on the target
 * side; the port kept every field name, so the pairs line up one for one.
 * ORDER MATTERS: a table appears after every table its FKs point to.
 */
export const MAPS: TableMap[] = [
    { collection: "users", table: "sf_users", cols: [PK,
        v("name", "name"), v("email", "email"), v("phone", "phone"), v("handle", "handle"),
        v("password", "password"), v("reset_password_token", "resetPasswordToken"),
        v("reset_password_expires", "resetPasswordExpires"), v("is_verified", "isVerified", true),
        v("email_verification_token", "emailVerificationToken"), v("role", "role", true),
        v("user_number", "userNumber"), v("user_digit", "userDigit"), v("sf_id", "sfID"),
        v("discord_id", "discordId"), v("discord_handle", "discordHandle"),
        v("profile_picture", "profilePicture"), { col: "favorite_games", kind: "textArr", from: "favoriteGames" },
        { col: "friends", kind: "personArr", from: "friends" }, CREATED, { col: "updated_at", kind: "updatedAt" }] },
    { collection: "accounts", table: "sf_accounts", cols: [PK,
        v("name", "name"), v("email", "email"), v("password", "password"),
        v("reset_password_token", "resetPasswordToken"), v("reset_password_expires", "resetPasswordExpires"),
        v("is_verified", "isVerified", true), v("email_verification_token", "emailVerificationToken"),
        v("industry", "industry"), v("company", "company"), v("website", "website"), v("handle", "handle"),
        v("phone", "phone"), v("address", "address"), v("user_number", "userNumber"), v("user_digit", "userDigit"),
        v("sf_id", "sfID"), v("sf_record_type_id", "sfRecordTypeID"), v("sf_record_type_name", "sfRecordTypeName"),
        v("profile_picture", "profilePicture"), { col: "favorite_games", kind: "textArr", from: "favoriteGames" },
        { col: "friends", kind: "personArr", from: "friends" }, CREATED] },
    { collection: "contacts", table: "sf_contacts", cols: [PK,
        v("name", "name"), v("email", "email"), v("password", "password"), v("is_verified", "isVerified", true),
        v("email_verification_token", "emailVerificationToken"), v("reset_password_token", "resetPasswordToken"),
        v("reset_password_expires", "resetPasswordExpires"), v("phone", "phone"), v("handle", "handle"),
        v("role", "role"), fk("account_id", "accountId", "accounts", "null"),
        v("user_number", "userNumber"), v("user_digit", "userDigit"), v("notes", "notes"), v("sf_id", "sfID"),
        v("profile_picture", "profilePicture"), { col: "favorite_games", kind: "textArr", from: "favoriteGames" },
        { col: "friends", kind: "personArr", from: "friends" }, CREATED] },
    { collection: "leads", table: "sf_leads", cols: [PK,
        v("first_name", "firstName"), v("last_name", "lastName"), v("email", "email"), v("password", "password"),
        v("reset_password_token", "resetPasswordToken"), v("reset_password_expires", "resetPasswordExpires"),
        v("is_verified", "isVerified", true), v("email_verification_token", "emailVerificationToken"),
        v("company", "company"), v("handle", "handle"), v("phone", "phone"),
        v("status", "status", true), v("source", "source", true),
        v("user_number", "userNumber"), v("user_digit", "userDigit"), v("sf_lead_id", "sfLeadId"),
        v("sf_record_type_id", "sfRecordTypeId"), v("sf_record_type_name", "sfRecordTypeName"),
        v("profile_picture", "profilePicture"), { col: "favorite_games", kind: "textArr", from: "favoriteGames" },
        { col: "friends", kind: "personArr", from: "friends" }, CREATED] },
    { collection: "campaigns", table: "campaigns", cols: [PK,
        v("title", "title"), v("description", "description"), v("status", "status", true),
        v("start_date", "startDate"), v("end_date", "endDate"), v("discord_guild_id", "discordGuildId"),
        v("discord_channel_id", "discordChannelId"), v("sf_id", "sfID"), CREATED] },
    { collection: "dungeons", table: "dungeons", cols: [PK,
        v("name", "name"), v("description", "description"), v("level", "level"),
        v("is_completed", "isCompleted", true), v("sf_id", "sfID"), CREATED] },
    { collection: "events", table: "events", cols: [PK,
        v("title", "title"), v("description", "description"), v("status", "status", true),
        v("start_date", "startDate"), v("end_date", "endDate"), CREATED] },
    { collection: "sessions", table: "game_sessions", cols: [PK,
        v("title", "title"), fk("campaign_id", "campaign", "campaigns", "exclude"),
        v("date", "date", true), v("end_date", "endDate"), v("location", "location"),
        v("is_online", "isOnline", true), v("agenda", "agenda"), v("summary", "summary"), v("vod_url", "vodUrl"),
        v("discord_event_id", "discordEventId"), v("google_event_id", "googleEventId"),
        v("google_calendar_link", "googleCalendarLink"), v("sf_id", "sfID"),
        { col: "ready_check", kind: "readyCheck", from: "readyCheck" }, CREATED] },
    { collection: "campaignmembers", table: "campaign_members", cols: [PK,
        fk("campaign_id", "campaign", "campaigns", "exclude"),
        fk("lead_id", "lead", "leads", "null"), fk("contact_id", "contact", "contacts", "null"),
        fk("account_id", "account", "accounts", "null"),
        v("email", "email"), v("phone", "phone"), v("first_name", "firstName"), v("last_name", "lastName"),
        v("status", "status"), v("joined_at", "joinedAt"), v("sf_id", "sfID"), CREATED] },
    { collection: "campaigninvites", table: "campaign_invites", cols: [PK,
        fk("campaign_id", "campaign", "campaigns", "exclude"),
        { col: "from_user", kind: "person", from: "from" }, { col: "to_user", kind: "person", from: "to" },
        v("status", "status", true), CREATED] },
    { collection: "characters", table: "characters", cols: [PK,
        v("name", "name"), { col: "player_id", kind: "person", from: "player" },
        fk("campaign_id", "campaign", "campaigns", "null"), fk("dungeon_id", "dungeon", "dungeons", "null"),
        v("game_type", "gameType"), v("class", "class"), v("level", "level", true),
        v("is_dead", "isDead", true), v("sf_id", "sfID"), CREATED] },
    { collection: "playersessions", table: "player_sessions", cols: [PK,
        v("name", "name"), fk("session_id", "session", "sessions", "exclude"),
        { col: "player_id", kind: "person", from: "player" },
        fk("campaign_id", "campaign", "campaigns", "exclude"), v("sf_id", "sfID"), CREATED] },
    { collection: "encounters", table: "encounters", cols: [PK,
        v("name", "name"), v("description", "description"), v("difficulty", "difficulty", true),
        v("type", "type", true), fk("session_id", "session", "sessions", "null"),
        fk("dungeon_id", "dungeon", "dungeons", "null"), v("sf_id", "sfID"), CREATED] },
    { collection: "tasks", table: "tasks", cols: [PK,
        v("title", "title"), v("description", "description"), v("status", "status", true),
        v("due_date", "dueDate"), v("sf_id", "sfID"), v("sf_record_type_id", "sfRecordTypeID"),
        v("sf_record_type_name", "sfRecordTypeName"), v("sf_last_synced", "sfLastSynced"),
        v("notion_page_id", "notionPageId"), v("notion_last_synced", "notionLastSynced"),
        { col: "owner_id", kind: "idText", from: "ownerId" }, v("owner_name", "ownerName"), CREATED] },
    { collection: "opportunities", table: "opportunities", cols: [PK,
        v("name", "name"), v("amount", "amount"), v("stage", "stage", true), v("close_date", "closeDate"),
        fk("account_id", "accountId", "accounts", "null"), CREATED] },
    { collection: "messages", table: "messages", cols: [PK,
        fk("campaign_id", "campaign", "campaigns", "exclude"), fk("event_id", "event", "events", "null"),
        { col: "dm_key", kind: "dmKey", from: "dmKey" }, { col: "recipient", kind: "idText", from: "recipient" },
        { col: "sender_id", kind: "idText", from: "sender.id" }, v("sender_name", "sender.name"),
        v("sender_email", "sender.email"), v("body", "body"), CREATED] },
    { collection: "notifications", table: "notifications", cols: [PK,
        { col: "user_id", kind: "person", from: "user" }, v("type", "type"), v("title", "title"),
        v("body", "body"), { col: "link", kind: "link", from: "link" },
        { col: "source_key", kind: "sourceKey", from: "sourceKey" }, { col: "meta", kind: "meta", from: "meta" },
        v("count", "count", true), v("read", "read", true), CREATED] },
    { collection: "friendrequests", table: "friend_requests", cols: [PK,
        { col: "from_user", kind: "person", from: "from" }, { col: "to_user", kind: "person", from: "to" },
        v("status", "status", true), CREATED] },
    { collection: "apikeyvaults", table: "api_key_vault", cols: [PK,
        fk("user_id", "userId", "users", "exclude"), v("provider", "provider"), v("label", "label", true),
        v("encrypted_key_id", "encryptedKeyId"), v("encrypted_secret", "encryptedSecret"),
        CREATED, { col: "updated_at", kind: "updatedAt" }] },
    { collection: "cloudclawsessions", table: "cloud_claw_sessions", cols: [PK,
        fk("user_id", "userId", "users", "exclude"), { col: "messages", kind: "json", from: "messages", notNullDefault: true },
        CREATED, { col: "updated_at", kind: "updatedAt" }] },
    { collection: "alpacasnapshots", table: "alpaca_snapshots", cols: [PK,
        v("ts", "ts", true), v("equity", "equity", true), v("last_equity", "last_equity", true),
        v("cash", "cash", true), v("buying_power", "buying_power", true), v("day_pl", "day_pl", true),
        { col: "positions", kind: "json", from: "positions", notNullDefault: true }] },
];

export const TARGET_TABLES = MAPS.map((m) => m.table);

/** Mongo fields each map reads, for spotting fields the dump has and the map does not. */
function knownFields(m: TableMap): Set<string> {
    const s = new Set(["_id", "__v"]);
    for (const c of m.cols) {
        const from = (c as any).from as string | undefined;
        if (from) s.add(from.split(".")[0]);
    }
    s.add("createdAt");
    if (m.cols.some((c) => c.kind === "updatedAt")) s.add("updatedAt");
    return s;
}

// ---------------------------------------------------------------- dump reading

export function readDump(dir: string): Record<string, any[]> {
    const out: Record<string, any[]> = {};
    for (const f of readdirSync(dir)) {
        const gz = f.endsWith(".bson.gz");
        if (!f.endsWith(".bson") && !gz) continue;
        const name = f.replace(/\.bson(\.gz)?$/, "");
        if (name.startsWith("system.")) continue;
        let buf = readFileSync(join(dir, f));
        if (gz) buf = gunzipSync(buf);
        const docs: any[] = [];
        let off = 0;
        while (off < buf.length) {
            const size = buf.readInt32LE(off);
            if (size < 5 || off + size > buf.length) throw new Error(`${f}: corrupt BSON at byte ${off}`);
            docs.push(BSON.deserialize(buf.subarray(off, off + size), { promoteValues: true }));
            off += size;
        }
        out[name] = docs;
    }
    return out;
}

// ---------------------------------------------------------------- planning

const get = (doc: any, path: string) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), doc);

/** Marker for "let the column default apply" in a VALUES list. */
const DEFAULT = Symbol("DEFAULT");

interface Excluded { collection: string; id: string; reason: string }
interface Nulled { collection: string; id: string; column: string; missing: string; foundIn?: string }
interface Dangling { collection: string; id: string; column: string; ref: string }

export interface Plan {
    rows: Record<string, { cols: string[]; values: any[][]; srcIds: string[] }>;
    report: {
        sourceCounts: Record<string, number>;
        planned: Record<string, number>;
        excluded: Excluded[];
        nulled: Nulled[];
        dangling: Dangling[];
        unknownHexInIdFields: { collection: string; id: string; column: string; value: string }[];
        unknownFields: Record<string, Record<string, number>>;
        unmappedCollections: Record<string, number>;
        duplicateIds: { hex: string; collections: string[] }[];
        /** Same email (case-insensitive) in more than one person collection. Login's
         *  cascade (users, accounts, contacts, leads) decides which one signs in —
         *  unchanged by this load, but the Phase 2 merge will have to adjudicate them. */
        sharedEmails: { email: string; collections: string[] }[];
        nonObjectIdKeys: { collection: string; id: string }[];
        fatal: string[];
    };
}

function toJsonSafe(value: any, convertId: (hex: string) => string): any {
    if (value === null || value === undefined) return value;
    const hex = value instanceof ObjectId || value?._bsontype === "ObjectId" ? hexOf(value) : null;
    if (hex) return convertId(hex);
    if (value instanceof Date) return value.toISOString();
    if (value?._bsontype === "Decimal128" || value?._bsontype === "Long") return Number(value.toString());
    if (Array.isArray(value)) return value.map((x) => toJsonSafe(x, convertId));
    if (typeof value === "object") {
        const o: any = {};
        for (const [k, x] of Object.entries(value)) o[k] = toJsonSafe(x, convertId);
        return o;
    }
    return value;
}

export function plan(dump: Record<string, any[]>): Plan {
    const report: Plan["report"] = {
        sourceCounts: {}, planned: {}, excluded: [], nulled: [], dangling: [],
        unknownHexInIdFields: [], unknownFields: {}, unmappedCollections: {}, duplicateIds: [],
        nonObjectIdKeys: [], fatal: [], sharedEmails: [],
    };
    const mapped = new Set(MAPS.map((m) => m.collection));
    for (const [name, docs] of Object.entries(dump)) {
        report.sourceCounts[name] = docs.length;
        if (!mapped.has(name)) report.unmappedCollections[name] = docs.length;
    }

    // Every _id in the dump, and which collection owns it. A hex owned by two
    // collections would make a polymorphic reference ambiguous: fatal.
    const owner = new Map<string, string>();
    const dups = new Map<string, Set<string>>();
    for (const m of MAPS) {
        for (const d of dump[m.collection] ?? []) {
            const hex = hexOf(d._id);
            if (!hex) { report.nonObjectIdKeys.push({ collection: m.collection, id: String(d._id) }); continue; }
            const prev = owner.get(hex);
            if (prev && prev !== m.collection) {
                if (!dups.has(hex)) dups.set(hex, new Set([prev]));
                dups.get(hex)!.add(m.collection);
            }
            owner.set(hex, m.collection);
        }
    }
    for (const [hex, cols] of dups) report.duplicateIds.push({ hex, collections: [...cols] });
    if (report.duplicateIds.length) {
        report.fatal.push(`${report.duplicateIds.length} ObjectId(s) appear in more than one collection; ` +
            "a reference to one of them could not be resolved to a single row.");
    }
    if (report.nonObjectIdKeys.length) {
        report.fatal.push(`${report.nonObjectIdKeys.length} document(s) have an _id that is not an ObjectId.`);
    }

    const byEmail = new Map<string, Set<string>>();
    for (const c of PERSON_COLLECTIONS) {
        for (const d of dump[c] ?? []) {
            if (typeof d.email !== "string" || !d.email.trim()) continue;
            const e = d.email.trim().toLowerCase();
            if (!byEmail.has(e)) byEmail.set(e, new Set());
            byEmail.get(e)!.add(c);
        }
    }
    for (const [email, cs] of byEmail) if (cs.size > 1) report.sharedEmails.push({ email, collections: [...cs] });

    const isPerson = (hex: string) => PERSON_COLLECTIONS.includes(owner.get(hex) ?? "");
    // Rows that will actually be inserted, per source collection — FK checks are
    // against THIS, so a row excluded upstream cascades correctly downstream.
    const present: Record<string, Set<string>> = {};

    const rows: Plan["rows"] = {};
    for (const m of MAPS) {
        const docs = dump[m.collection] ?? [];
        present[m.collection] = new Set();
        const known = knownFields(m);
        const unknown: Record<string, number> = {};
        const out = { cols: m.cols.map((c) => c.col), values: [] as any[][], srcIds: [] as string[] };

        for (const d of docs) {
            for (const k of Object.keys(d)) if (!known.has(k)) unknown[k] = (unknown[k] ?? 0) + 1;
            const hex = hexOf(d._id);
            if (!hex) continue;
            const idStr = hex;
            const createdFallback = d._id instanceof ObjectId || d._id?._bsontype === "ObjectId"
                ? d._id.getTimestamp() : null;
            const convertId = (h: string, column: string) => {
                if (!owner.has(h)) report.unknownHexInIdFields.push({ collection: m.collection, id: idStr, column, value: h });
                return idFor(h);
            };
            const personRef = (raw: any, column: string): string | null => {
                const h = hexOf(raw);
                if (!h) return raw == null ? null : String(raw);
                if (!isPerson(h)) report.dangling.push({ collection: m.collection, id: idStr, column, ref: h });
                return idFor(h);
            };
            const rewriteIdTokens = (s: string, column: string) =>
                s.replace(HEX24_TOKEN, (tok) => convertId(tok.toLowerCase(), column));

            let skip: string | null = null;
            const row: any[] = [];
            for (const c of m.cols) {
                switch (c.kind) {
                    case "pk": row.push(idFor(hex)); break;
                    case "value": {
                        let x = get(d, c.from);
                        if (x?._bsontype === "Decimal128" || x?._bsontype === "Long") x = x.toString();
                        row.push(x == null ? (c.notNullDefault ? DEFAULT : null) : x);
                        break;
                    }
                    case "createdAt": {
                        const x = get(d, c.from ?? "createdAt");
                        row.push(x ?? createdFallback ?? DEFAULT);
                        break;
                    }
                    case "updatedAt":
                        row.push(d.updatedAt ?? d.createdAt ?? createdFallback ?? DEFAULT);
                        break;
                    case "textArr": {
                        const x = get(d, c.from);
                        row.push(Array.isArray(x) ? x.map(String) : DEFAULT);
                        break;
                    }
                    case "personArr": {
                        const x = get(d, c.from);
                        if (!Array.isArray(x)) { row.push(DEFAULT); break; }
                        const ids = x.map((e) => personRef(e, c.col)).filter((e): e is string => !!e);
                        row.push([...new Set(ids)]);
                        break;
                    }
                    case "fk": {
                        const raw = get(d, c.from);
                        if (raw == null) { row.push(null); break; }
                        const h = hexOf(raw);
                        if (h && present[c.target]?.has(h)) { row.push(idFor(h)); break; }
                        const elsewhere = h ? owner.get(h) : undefined;
                        if (c.onMissing === "exclude") {
                            // Two different situations, reported differently: a parent that
                            // was deleted in Mongo (the schema's own CASCADE, applied late),
                            // and a parent that EXISTS but in a collection the release
                            // schema's FK does not admit — that one is data loss.
                            skip = elsewhere && elsewhere !== c.target
                                ? `DATA LOSS: ${c.col} points at a ${elsewhere} document (${h}); the release schema's FK admits only ${c.target}`
                                : `${c.col} -> ${c.target} ${h ?? String(raw)} does not exist (ON DELETE CASCADE)`;
                        } else {
                            report.nulled.push({ collection: m.collection, id: idStr, column: c.col, missing: h ?? String(raw),
                                ...(elsewhere ? { foundIn: elsewhere } : {}) });
                            row.push(null);
                        }
                        break;
                    }
                    case "person": row.push(personRef(get(d, c.from), c.col)); break;
                    case "idText": {
                        const x = get(d, c.from);
                        if (x == null) { row.push(null); break; }
                        const h = hexOf(x);
                        if (h) {
                            if (!isPerson(h) && (c.col === "sender_id" || c.col === "recipient" || c.col === "owner_id")) {
                                report.dangling.push({ collection: m.collection, id: idStr, column: c.col, ref: h });
                            }
                            row.push(idFor(h));
                        } else row.push(String(x));
                        break;
                    }
                    case "dmKey": {
                        const x = get(d, c.from);
                        if (x == null) { row.push(null); break; }
                        const parts = String(x).split(":");
                        if (parts.length === 2 && parts.every((p) => HEX24.test(p))) {
                            for (const p of parts) {
                                if (!isPerson(p.toLowerCase())) {
                                    report.dangling.push({ collection: m.collection, id: idStr, column: c.col, ref: p.toLowerCase() });
                                }
                            }
                            // The app builds the key as the two ids SORTED; uuids sort
                            // differently from ObjectIds, so re-sort after mapping or
                            // the thread is invisible to both participants.
                            row.push(parts.map((p) => idFor(p)).sort().join(":"));
                        } else {
                            report.unknownHexInIdFields.push({ collection: m.collection, id: idStr, column: c.col, value: String(x) });
                            row.push(String(x));
                        }
                        break;
                    }
                    case "sourceKey":
                    case "link": {
                        const x = get(d, c.from);
                        row.push(x == null ? null : rewriteIdTokens(String(x), c.col));
                        break;
                    }
                    case "readyCheck": {
                        const x = get(d, c.from);
                        if (x == null) { row.push(null); break; }
                        // Mongoose gives every response subdocument an _id. They are
                        // not data and nothing references them; drop them BEFORE the
                        // ObjectId conversion so they are not mistaken for references.
                        const { _id: _drop, ...rcRaw } = x;
                        if (Array.isArray(rcRaw.responses)) {
                            rcRaw.responses = rcRaw.responses.map(({ _id, ...r }: any) => r);
                        }
                        const rc = toJsonSafe(rcRaw, (h) => convertId(h, c.col));
                        if (Array.isArray(rc.responses)) {
                            rc.responses = rc.responses.map((rest: any) => {
                                if (typeof rest.playerId === "string" && HEX24.test(rest.playerId)) {
                                    const h = rest.playerId.toLowerCase();
                                    if (!isPerson(h)) report.dangling.push({ collection: m.collection, id: idStr, column: "ready_check.playerId", ref: h });
                                    rest.playerId = idFor(h);
                                }
                                return rest;
                            });
                        }
                        row.push(JSON.stringify(rc));
                        break;
                    }
                    case "meta": {
                        const x = get(d, c.from);
                        if (x == null) { row.push(null); break; }
                        // Id-valued keys (requestId, campaignId, fromUserId, ...) are
                        // rewritten; free-form values are left exactly as they were.
                        const walk = (o: any): any => {
                            if (Array.isArray(o)) return o.map(walk);
                            if (o && typeof o === "object" && !(o instanceof Date) && !o._bsontype) {
                                const r: any = {};
                                for (const [k, val] of Object.entries(o)) {
                                    r[k] = /id$/i.test(k) && typeof val === "string" && HEX24.test(val)
                                        ? convertId(val.toLowerCase(), `meta.${k}`)
                                        : walk(val);
                                }
                                return r;
                            }
                            return toJsonSafe(o, (h) => convertId(h, c.col));
                        };
                        row.push(JSON.stringify(walk(x)));
                        break;
                    }
                    case "json": {
                        const x = get(d, c.from);
                        row.push(x == null ? (c.notNullDefault ? DEFAULT : null)
                            : JSON.stringify(toJsonSafe(x, (h) => convertId(h, c.col))));
                        break;
                    }
                }
                if (skip) break;
            }
            if (skip) { report.excluded.push({ collection: m.collection, id: idStr, reason: skip }); continue; }
            present[m.collection].add(hex);
            out.values.push(row);
            out.srcIds.push(idStr);
        }
        if (Object.keys(unknown).length) report.unknownFields[m.collection] = unknown;
        report.planned[m.table] = out.values.length;
        rows[m.table] = out;
    }
    return { rows, report };
}

// ---------------------------------------------------------------- loading

async function insertBatch(client: any, table: string, cols: string[], batch: any[][]) {
    const params: any[] = [];
    const tuples = batch.map((row) => "(" + row.map((val) => {
        if (val === DEFAULT) return "DEFAULT";
        params.push(val);
        return `$${params.length}`;
    }).join(", ") + ")");
    await client.query(`INSERT INTO ${table} (${cols.join(", ")}) VALUES ${tuples.join(", ")}`, params);
}

export interface LoadResult { inserted: Record<string, number>; errors: { table: string; id: string; error: string }[] }

/**
 * Insert every planned row. Batches for speed; a batch that fails is retried
 * row by row under savepoints so the report names exactly which rows failed
 * and why, instead of "something in these 500".
 */
export async function load(client: any, p: Plan, batchSize = 500): Promise<LoadResult> {
    const inserted: Record<string, number> = {};
    const errors: LoadResult["errors"] = [];
    for (const table of TARGET_TABLES) {
        const { cols, values, srcIds } = p.rows[table];
        inserted[table] = 0;
        for (let i = 0; i < values.length; i += batchSize) {
            const batch = values.slice(i, i + batchSize);
            await client.query("SAVEPOINT batch");
            try {
                await insertBatch(client, table, cols, batch);
                await client.query("RELEASE SAVEPOINT batch");
                inserted[table] += batch.length;
            } catch {
                await client.query("ROLLBACK TO SAVEPOINT batch");
                for (let j = 0; j < batch.length; j++) {
                    await client.query("SAVEPOINT one");
                    try {
                        await insertBatch(client, table, cols, [batch[j]]);
                        await client.query("RELEASE SAVEPOINT one");
                        inserted[table]++;
                    } catch (err: any) {
                        await client.query("ROLLBACK TO SAVEPOINT one");
                        errors.push({ table, id: srcIds[i + j], error: err.message + (err.detail ? ` (${err.detail})` : "") });
                    }
                }
                await client.query("RELEASE SAVEPOINT batch");
            }
        }
    }
    return { inserted, errors };
}

/** Refuse anything that is not the release schema, or that already holds people. */
export async function checkTarget(client: any, replace: boolean): Promise<string[]> {
    const problems: string[] = [];
    const cols = await client.query(`
        SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = ANY($1)`, [[...TARGET_TABLES, "accounts"]]);
    const have = new Set(cols.rows.map((r: any) => `${r.table_name}.${r.column_name}`));
    for (const m of MAPS) {
        for (const c of m.cols) {
            if (!have.has(`${m.table}.${c.col}`)) problems.push(`missing column ${m.table}.${c.col}`);
        }
    }
    if (problems.length) {
        problems.unshift("The target is not the release (b18fa67) schema. Apply the three Phase 1 " +
            "migrations first; if it has Phase 3's shape (campaign_invites.from_account_id), this is the wrong branch.");
        return problems;
    }
    const counts = await client.query(
        TARGET_TABLES.map((t) => `SELECT '${t}' AS t, count(*)::int AS n FROM ${t}`).join(" UNION ALL "));
    const nonEmpty = counts.rows.filter((r: any) => r.n > 0);
    if (nonEmpty.length && !replace) {
        problems.push("Target tables already hold rows: " + nonEmpty.map((r: any) => `${r.t}=${r.n}`).join(", ") +
            ". Pass --replace to truncate them first (scratch branches only).");
    }
    const [acc] = (await client.query(`SELECT count(*)::int AS n FROM accounts`)).rows;
    if (acc.n > 0) {
        problems.push(`accounts holds ${acc.n} rows. The Phase 2 backfill has run here; loading people underneath ` +
            "it would leave accounts describing a different set of people. Use a branch where it has not.");
    }
    return problems;
}

// ---------------------------------------------------------------- CLI

function summarise(p: Plan, res?: LoadResult) {
    const r = p.report;
    console.log("\n  collection            source   planned  excluded" + (res ? "  inserted  failed" : ""));
    for (const m of MAPS) {
        const src = r.sourceCounts[m.collection] ?? 0;
        const exc = r.excluded.filter((e) => e.collection === m.collection).length;
        const failed = res?.errors.filter((e) => e.table === m.table).length ?? 0;
        const line = `  ${m.collection.padEnd(20)} ${String(src).padStart(7)} ${String(r.planned[m.table]).padStart(9)} ` +
            `${String(exc).padStart(9)}` + (res ? `${String(res.inserted[m.table]).padStart(10)} ${String(failed).padStart(7)}` : "");
        console.log(line + (src !== r.planned[m.table] + exc ? "   <-- does not reconcile" : ""));
    }
    for (const [c, n] of Object.entries(r.unmappedCollections)) console.log(`  ${c.padEnd(20)} ${String(n).padStart(7)}   NOT MIGRATED (no model owns this collection)`);

    const group = (xs: { collection: string; column: string }[]) => {
        const g: Record<string, number> = {};
        for (const x of xs) g[`${x.collection}.${x.column}`] = (g[`${x.collection}.${x.column}`] ?? 0) + 1;
        return Object.entries(g).map(([k, n]) => `${k} ×${n}`).join(", ");
    };
    if (r.excluded.length) {
        console.log(`\n  Excluded rows (${r.excluded.length}):`);
        for (const e of r.excluded) console.log(`    ${e.collection} ${e.id}: ${e.reason}`);
    }
    if (r.sharedEmails.length) {
        console.log(`\n  Emails held by more than one person collection (${r.sharedEmails.length}) — login picks the first of ` +
            "users, accounts, contacts, leads, exactly as before: " + r.sharedEmails.map((x) => x.collections.join("+")).join(", "));
    }
    if (r.nulled.length) console.log(`\n  References set NULL (${r.nulled.length}) — ON DELETE SET NULL: ${group(r.nulled)}`);
    if (r.dangling.length) {
        const refs = new Set(r.dangling.map((d) => d.ref));
        console.log(`\n  Dangling person references kept as-is (${r.dangling.length}, ${refs.size} distinct missing people): ${group(r.dangling)}`);
    }
    if (r.unknownHexInIdFields.length) console.log(`\n  Ids in id fields that match no document (mapped anyway): ${group(r.unknownHexInIdFields)}`);
    for (const [c, f] of Object.entries(r.unknownFields)) {
        console.log(`\n  Fields in ${c} that no model maps (NOT MIGRATED): ` + Object.entries(f).map(([k, n]) => `${k} ×${n}`).join(", "));
    }
    if (res?.errors.length) {
        console.log(`\n  Rows Postgres rejected (${res.errors.length}):`);
        for (const e of res.errors.slice(0, 50)) console.log(`    ${e.table} ${e.id}: ${e.error}`);
        if (res.errors.length > 50) console.log(`    … and ${res.errors.length - 50} more in the report`);
    }
    for (const f of r.fatal) console.log(`\n  FATAL: ${f}`);
}

async function main() {
    const args = process.argv.slice(2);
    const flag = (f: string) => args.includes(f);
    const opt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
    const mode = flag("--apply") ? "apply" : flag("--dry-run") ? "dry-run" : "profile";
    const optVals = new Set([opt("--report"), opt("--batch")]);
    const dir = args.find((a) => !a.startsWith("--") && !optVals.has(a));
    const reportPath = resolve(opt("--report") ?? "mongo-to-neon-report.json");
    const batch = Number(opt("--batch") ?? 500);
    if (!dir || !existsSync(dir)) {
        console.error("Usage: npx tsx scripts/mongo-to-neon.ts [--dry-run|--apply] [--replace] [--allow-unmapped] <mongodump-dir/personal_web_app>");
        process.exit(2);
    }

    const dump = readDump(dir);
    console.log(`\n  Dump      ${resolve(dir)} (${Object.keys(dump).length} collections)`);
    console.log(`  Mode      ${mode}`);
    const p = plan(dump);
    const write = (res?: LoadResult) => writeFileSync(reportPath, JSON.stringify({ ...p.report, load: res ?? null }, null, 2));

    if (mode === "profile") {
        summarise(p);
        write();
        console.log(`\n  Report    ${reportPath}\n  Nothing written. Next: --dry-run against a Neon branch.\n`);
        process.exit(p.report.fatal.length ? 1 : 0);
    }

    const { default: pool } = await import("../db/index.js");
    const url = process.env.DATABASE_URL ?? "";
    const u = (() => { try { return new URL(url); } catch { return null; } })();
    if (!u) { console.error("\n  Set DATABASE_URL to the target Neon branch.\n"); process.exit(2); }
    console.log(`  Target    ${u.hostname}   <- match this against the Neon console before --apply`);
    console.log(`  Database  ${u.pathname.slice(1)}`);

    const client = await pool.connect();
    let code = 0;
    try {
        await client.query("BEGIN");
        const problems = await checkTarget(client, flag("--replace"));
        const unmapped = Object.keys(p.report.unmappedCollections);
        if (unmapped.length && !flag("--allow-unmapped")) {
            problems.push(`Collections no model owns: ${unmapped.join(", ")}. Check them, then pass --allow-unmapped.`);
        }
        if (p.report.fatal.length) problems.push(...p.report.fatal);
        const loss = p.report.excluded.filter((e) => e.reason.startsWith("DATA LOSS"));
        if (loss.length && !flag("--accept-data-loss")) {
            problems.push(`${loss.length} row(s) exist in Mongo but cannot exist in the release schema (see "DATA LOSS" above). ` +
                "Decide what happens to them, then pass --accept-data-loss to load without them.");
        }
        if (problems.length) {
            await client.query("ROLLBACK");
            summarise(p);
            write();
            console.error("\n  Refusing:\n" + problems.map((x) => `    - ${x}`).join("\n") + "\n  Nothing changed.\n");
            code = 1;
            return;
        }
        if (flag("--replace")) await client.query(`TRUNCATE ${TARGET_TABLES.join(", ")}`);

        const res = await load(client, p, batch);
        summarise(p, res);
        write(res);
        console.log(`\n  Report    ${reportPath}`);

        if (res.errors.length) {
            await client.query("ROLLBACK");
            console.error(`\n  ✗ ${res.errors.length} row(s) failed. Rolled back — the database is exactly as it was.\n`);
            code = 1;
        } else if (mode === "apply") {
            await client.query("COMMIT");
            console.log("\n  ✓ Committed.\n");
        } else {
            await client.query("ROLLBACK");
            console.log("\n  ✓ Dry run passed. Rolled back — nothing changed. Re-run with --apply to commit.\n");
        }
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
        await pool.end();
        process.exitCode = code;
    }
}

if (process.argv[1] && basename(process.argv[1]).startsWith("mongo-to-neon")) {
    main().catch((err) => { console.error(err); process.exit(1); });
}
