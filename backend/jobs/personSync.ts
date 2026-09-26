import pool, { query } from "../db/index.js";
import {
    createSalesforceRecord,
    updateSalesforceRecord,
} from "../services/salesforceService.js";

/**
 * The person sync pipeline (#35, plan §2.7–2.8).
 *
 * Replaces the setImmediate postSave hooks that pushed to Salesforce from inside
 * the signup request. Someone who signs up at 10am exists fully in the app all
 * day and reaches Salesforce that night, as a Lead: no Salesforce round-trip in
 * the request, no half-created person when Salesforce is down, and a failure
 * that stays visible instead of being logged and forgotten.
 *
 * This file is slice 6b, the DRAIN: person_outbox -> Salesforce. The trigger
 * that fills the outbox is db/migrations/2026-09-24-phase3-person-outbox-trigger.sql.
 */

// ── Salesforce seam ─────────────────────────────────────────────────────────

/** Injected so tests can stand in for Salesforce. Both methods must THROW on failure. */
export interface SalesforcePersonClient {
    create(sobject: string, fields: Record<string, unknown>): Promise<string>;
    update(sobject: string, id: string, fields: Record<string, unknown>): Promise<void>;
}

export const liveSalesforce: SalesforcePersonClient = {
    create: createSalesforceRecord,
    update: updateSalesforceRecord,
};

// ── Field mapping ───────────────────────────────────────────────────────────

/** The five pushable columns (§2.6). Anything else in a payload is ignored. */
type Pushable = "email" | "name" | "first_name" | "last_name" | "phone";
const PUSHABLE: Pushable[] = ["email", "first_name", "last_name", "name", "phone"];

interface AccountRow {
    id: string;
    email: string | null;
    name: string | null;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    company: string | null;
    sf_object: string | null;
    sf_id: string | null;
    sf_record_type_name: string | null;
}

/** "Ada King Lovelace" -> { first: "Ada King", last: "Lovelace" }. */
function splitName(full: string | null): { first: string | null; last: string | null } {
    const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return { first: null, last: null };
    if (parts.length === 1) return { first: null, last: parts[0] };
    return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

/**
 * Person Account or business Account? Nothing the app stores says so directly
 * (Salesforce's IsPersonAccount is not in the landing tables), so the record type
 * decides: a business Account only when its record type is KNOWN and is not a
 * person type. Unknown means Person Account, because the org has them enabled and
 * every Account here is a human. If that is ever wrong for a record, its push
 * fails with Salesforce's error and shows on the admin Person Sync page — it does
 * not fail silently.
 */
function isPersonAccount(account: AccountRow): boolean {
    const rt = account.sf_record_type_name;
    return !rt || /person/i.test(rt);
}

/**
 * Map an account's CURRENT values to Salesforce API fields, for the columns that
 * changed. Values are read at drain time, not from the payload: the drain is
 * nightly, so a snapshot taken when the change was made could push something the
 * person has changed again since.
 *
 * Returns the fields to send, plus any changed columns that have nowhere to go
 * on this object — reported rather than failed, because retrying cannot help.
 */
export function toSalesforceFields(
    account: AccountRow, changed: string[], op: "create" | "update",
): { sobject: string; fields: Record<string, unknown>; notPushed: string[] } {
    const want = new Set(op === "create" ? PUSHABLE : changed.filter((c): c is Pushable =>
        (PUSHABLE as string[]).includes(c)));
    const sobject = op === "create" ? "Lead" : (account.sf_object ?? "Lead");
    const fields: Record<string, unknown> = {};
    const notPushed: string[] = [];

    // FirstName/LastName come from their own columns when present, and from
    // `name` otherwise — people who signed up with a single display name have
    // only that. LastName is required on both Lead and Contact.
    const fromName = splitName(account.name);
    const first = account.first_name ?? fromName.first;
    const last = account.last_name ?? fromName.last;

    if (sobject === "Lead" || sobject === "Contact") {
        if (want.has("email")) fields.Email = account.email;
        if (want.has("phone")) fields.Phone = account.phone;
        if (want.has("first_name") || want.has("name")) fields.FirstName = first;
        if (want.has("last_name") || want.has("name")) fields.LastName = last ?? "Unknown";
    } else if (sobject === "Account" && isPersonAccount(account)) {
        // The org has Person Accounts enabled (Geoff, 2026-09-24), and every
        // Account in this app is a human. A Person Account's Name is DERIVED from
        // FirstName/LastName and Salesforce rejects writes to it, so a name change
        // goes out as First/Last; email is PersonEmail.
        if (want.has("email")) fields.PersonEmail = account.email;
        if (want.has("phone")) fields.Phone = account.phone;
        if (want.has("first_name") || want.has("name")) fields.FirstName = first;
        if (want.has("last_name") || want.has("name")) fields.LastName = last ?? "Unknown";
    } else if (sobject === "Account") {
        // A business Account has Name and Phone, and no email of its own.
        if (want.has("name") || want.has("first_name") || want.has("last_name")) {
            fields.Name = account.name ?? [first, last].filter(Boolean).join(" ");
        }
        if (want.has("phone")) fields.Phone = account.phone;
        if (want.has("email")) notPushed.push("email (a business Account has no email field)");
    } else {
        notPushed.push(...[...want].map((f) => `${f} (no mapping for ${sobject})`));
    }

    if (op === "create") {
        // Salesforce requires Company on a Lead. The signup form makes it
        // optional, which is why the old postSave create failed for anyone who
        // left it blank. Fall back to the person's own name — the same choice the
        // old createLeadFromAccount made.
        fields.Company = account.company || account.name
            || [first, last].filter(Boolean).join(" ") || "Individual";
        fields.LeadSource = "Web App";
        fields.Status = "Open - Not Contacted";
    }

    return { sobject, fields, notPushed };
}

// ── Drain ───────────────────────────────────────────────────────────────────

interface OutboxRow {
    id: string;
    account_id: string;
    op: "create" | "update";
    payload: { fields?: string[] };
    attempts: number;
}

export interface DrainResult {
    claimed: number;
    created: number;
    updated: number;
    /** Done without a Salesforce call: pull-only, or nothing mappable. */
    skipped: number;
    /** Put back for the next run, attempts remaining. */
    retrying: number;
    /** Gave up: attempts exhausted. Surfaced in the admin UI. */
    failed: number;
    errors: Array<{ outboxId: string; accountId: string; error: string }>;
}

/**
 * Put a row back for another attempt, or give up on it.
 *
 * The one subtlety: a person may have changed something while this row was in
 * flight, which enqueued a fresh PENDING row, and there may be only one pending
 * row per person (ux_person_outbox_one_pending). So a retry folds into that row
 * — union of fields, create wins, highest attempt count — rather than colliding
 * with it.
 */
async function releaseForRetry(
    row: OutboxRow, error: string, maxAttempts: number,
): Promise<"retrying" | "failed"> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        if (row.attempts >= maxAttempts) {
            await client.query(
                `UPDATE person_outbox SET status = 'failed', last_error = $2, processed_at = now()
                  WHERE id = $1`, [row.id, error]);
            await client.query("COMMIT");
            return "failed";
        }
        const { rows: pending } = await client.query(
            `SELECT id FROM person_outbox
              WHERE account_id = $1 AND status = 'pending' AND id <> $2 FOR UPDATE`,
            [row.account_id, row.id]);
        if (pending.length) {
            await client.query(
                `UPDATE person_outbox p
                    SET op = CASE WHEN p.op = 'create' OR $2 = 'create' THEN 'create' ELSE 'update' END,
                        payload = jsonb_build_object('fields', (
                          SELECT to_jsonb(array_agg(f ORDER BY f)) FROM (
                            SELECT jsonb_array_elements_text(p.payload -> 'fields') AS f
                            UNION SELECT unnest($3::text[])) u)),
                        attempts = GREATEST(p.attempts, $4),
                        last_error = $5
                  WHERE p.id = $1`,
                [pending[0].id, row.op, row.payload.fields ?? [], row.attempts, error]);
            await client.query(`DELETE FROM person_outbox WHERE id = $1`, [row.id]);
        } else {
            await client.query(
                `UPDATE person_outbox SET status = 'pending', last_error = $2 WHERE id = $1`,
                [row.id, error]);
        }
        await client.query("COMMIT");
        return "retrying";
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

/** Mark a row done and, when Salesforce assigned one, write the id back. */
async function complete(row: OutboxRow, newSfId: string | null, note: string | null): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        // The loop guard. Without it, writing the new sf_id back would look to
        // the outbox trigger like an app edit. (sf_id and sf_last_pushed_at are
        // not pushable columns today, so it would enqueue nothing — but this is
        // exactly the kind of write the guard exists for, and it should not rely
        // on today's column list.)
        await client.query("SET LOCAL app.sync_in_progress = 'on'");
        if (newSfId) {
            await client.query(
                `UPDATE accounts SET sf_id = $2, sf_last_pushed_at = now() WHERE id = $1`,
                [row.account_id, newSfId]);
        } else {
            await client.query(
                `UPDATE accounts SET sf_last_pushed_at = now() WHERE id = $1`, [row.account_id]);
        }
        await client.query(
            `UPDATE person_outbox SET status = 'done', processed_at = now(), last_error = $2
              WHERE id = $1`, [row.id, note]);
        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Drain person_outbox to Salesforce.
 *
 * Claims with FOR UPDATE SKIP LOCKED and polls rather than LISTENing: dev's
 * DATABASE_URL is a PgBouncer pooler, and LISTEN/NOTIFY is session-scoped. A
 * row attempted in this run is not claimed again in the same run, so one bad
 * record costs one attempt per run rather than burning all of its attempts in a
 * loop — with a nightly schedule, `maxAttempts` is effectively "nights".
 *
 * Call it through runPersonSync, which holds the advisory lock. Rows found
 * in_flight at the start belong to a run that stopped mid-push; they are
 * released for retry rather than left stranded.
 */
export async function drainPersonOutbox(opts: {
    sf?: SalesforcePersonClient; batchSize?: number; maxAttempts?: number;
} = {}): Promise<DrainResult> {
    const sf = opts.sf ?? liveSalesforce;
    const batchSize = opts.batchSize ?? 20;
    const maxAttempts = opts.maxAttempts ?? 5;
    const result: DrainResult = {
        claimed: 0, created: 0, updated: 0, skipped: 0, retrying: 0, failed: 0, errors: [],
    };

    const { rows: stranded } = await query<OutboxRow>(
        `SELECT id, account_id, op, payload, attempts FROM person_outbox WHERE status = 'in_flight'`);
    for (const row of stranded) {
        await releaseForRetry(row, "interrupted: in flight when a previous run stopped", maxAttempts);
    }

    const attempted: string[] = [];
    for (;;) {
        const { rows: batch } = await query<OutboxRow>(
            `UPDATE person_outbox SET status = 'in_flight', attempts = attempts + 1
              WHERE id IN (
                SELECT id FROM person_outbox
                 WHERE status = 'pending' AND NOT (id = ANY($2::bigint[]))
                 ORDER BY created_at, id
                 LIMIT $1
                 FOR UPDATE SKIP LOCKED)
              RETURNING id, account_id, op, payload, attempts`,
            [batchSize, attempted]);
        if (!batch.length) break;

        for (const row of batch) {
            attempted.push(row.id);
            result.claimed++;
            try {
                const { rows: [account] } = await query<AccountRow>(
                    `SELECT id, email, name, first_name, last_name, phone, company, sf_object, sf_id,
                            sf_record_type_name
                       FROM accounts WHERE id = $1`, [row.account_id]);

                // Deleting an account cascades to its outbox rows, so this is a race
                // with a delete in flight. Nothing to push.
                if (!account) { await complete(row, null, "account no longer exists"); result.skipped++; continue; }

                // Pull-only. The trigger never enqueues these, but a person can
                // become User-sourced through the merge after a row was queued.
                if (account.sf_object === "User") {
                    await complete(row, null, "skipped: sf_users is pull-only");
                    result.skipped++;
                    continue;
                }

                // A create whose account already has an sf_id — the Lead arrived
                // through the pull and the merge linked it first — is an update.
                const op = row.op === "create" && !account.sf_id ? "create" : "update";
                const changed = row.payload?.fields ?? [];
                const { sobject, fields, notPushed } = toSalesforceFields(account, changed, op);
                const note = notPushed.length ? `not pushed: ${notPushed.join("; ")}` : null;

                if (op === "create") {
                    const newId = await sf.create(sobject, fields);
                    await complete(row, newId, note);
                    result.created++;
                } else if (!account.sf_id) {
                    // Should be unreachable: the trigger never queues an update for a
                    // person with no sf_id. Failing loudly beats guessing a target.
                    throw new Error(`update for ${account.sf_object} with no sf_id`);
                } else if (Object.keys(fields).length === 0) {
                    await complete(row, null, note ?? "nothing to push");
                    result.skipped++;
                } else {
                    await sf.update(sobject, account.sf_id, fields);
                    await complete(row, null, note);
                    result.updated++;
                }
            } catch (err: any) {
                const message = String(err?.message ?? err).slice(0, 2000);
                const outcome = await releaseForRetry(row, message, maxAttempts);
                result[outcome]++;
                result.errors.push({ outboxId: row.id, accountId: row.account_id, error: message });
            }
        }
    }

    return result;
}

// ── Merge: landing tables -> accounts (slice 6c) ────────────────────────────

type LandingTable = "sf_users" | "sf_accounts" | "sf_contacts" | "sf_leads";
type SfObject = "User" | "Account" | "Contact" | "Lead";
type SharedCol = "name" | "first_name" | "last_name" | "phone";
type SfOwnedCol = "company" | "industry" | "website" | "address" | "lead_status"
    | "sf_record_type_id" | "sf_record_type_name";

interface SourceDef {
    table: LandingTable;
    sfObject: SfObject;
    /** Salesforce identity column: sf_leads alone calls it sf_lead_id. */
    sfIdCol: "sf_id" | "sf_lead_id";
    /** account column -> landing column, for shared fields (last writer wins). */
    shared: Partial<Record<SharedCol, string>>;
    /** account column -> landing column, for Salesforce-owned fields (SF always wins). */
    sfOwned: Partial<Record<SfOwnedCol, string>>;
    /**
     * App-owned starting values, copied ONLY when a landing row founds a new
     * account. Never the password: landing rows no longer hold one, and the ones
     * that did were placeholders. A person founded from Salesforce sets theirs
     * through Forgot Password, as Salesforce-synced people always have.
     */
    seed: string[];
}

/**
 * Rank, highest first, is the plan's tie-break (§2.4): a User outranks an
 * Account outranks a Contact outranks a Lead. It decides whose value speaks for
 * Salesforce when a person has several linked rows, and it decides promotion —
 * a Lead who converts arrives as a Contact, and the person's Salesforce identity
 * should move up with them rather than keep pointing at a converted Lead that
 * Salesforce will no longer let anyone update.
 */
const SOURCES: SourceDef[] = [
    { table: "sf_users", sfObject: "User", sfIdCol: "sf_id",
      shared: { name: "name", phone: "phone" }, sfOwned: {},
      seed: ["handle", "user_number", "user_digit", "is_verified",
             "profile_picture", "favorite_games", "discord_id", "discord_handle"] },
    { table: "sf_accounts", sfObject: "Account", sfIdCol: "sf_id",
      shared: { name: "name", phone: "phone" },
      sfOwned: { company: "company", industry: "industry", website: "website", address: "address",
                 sf_record_type_id: "sf_record_type_id", sf_record_type_name: "sf_record_type_name" },
      seed: ["handle", "user_number", "user_digit", "is_verified",
             "profile_picture", "favorite_games"] },
    { table: "sf_contacts", sfObject: "Contact", sfIdCol: "sf_id",
      shared: { name: "name", phone: "phone" }, sfOwned: {},
      seed: ["handle", "user_number", "user_digit", "is_verified",
             "profile_picture", "favorite_games"] },
    { table: "sf_leads", sfObject: "Lead", sfIdCol: "sf_lead_id",
      shared: { first_name: "first_name", last_name: "last_name", phone: "phone" },
      sfOwned: { company: "company", lead_status: "status",
                 sf_record_type_id: "sf_record_type_id", sf_record_type_name: "sf_record_type_name" },
      seed: ["handle", "user_number", "user_digit", "is_verified",
             "profile_picture", "favorite_games"] },
];
const RANK: Record<string, number> = { User: 4, Account: 3, Contact: 2, Lead: 1 };
const SOURCE_BY_TABLE = new Map(SOURCES.map((s) => [s.table, s]));

export interface MergeResult {
    linked: { bySalesforceId: number; byEmail: number; byContactAccount: number };
    created: number;
    /** An existing person whose Salesforce identity moved up (e.g. Lead -> Contact). */
    promoted: number;
    excluded: number;
    /** Accounts whose Salesforce-derived fields changed. */
    updated: number;
    fieldsChanged: Record<string, number>;
    /** Shared fields left alone because the app holds a change Salesforce hasn't seen. */
    protectedFields: number;
    roleChanges: number;
    tierChanges: number;
    conflicts: Array<{ source: string; problem: string }>;
}

const same = (a: unknown, b: unknown) =>
    (a ?? null) === (b ?? null)
    || (a instanceof Date && b instanceof Date && a.getTime() === b.getTime());

/**
 * Merge the Salesforce landing tables into accounts, in one transaction.
 *
 *   1. Link every landing row with no account_source_links entry — by Salesforce
 *      id (how an app signup the drain created comes home), then email, then a
 *      Contact's parent Account. What matches nothing founds a new account, and
 *      donates its UUID. Rows in account_merge_exclusions are never touched.
 *   2. Apply field ownership (§2.6) to every linked person:
 *        Salesforce-owned  company, industry, website, address, lead_status,
 *                          sf_record_type_*: Salesforce always wins.
 *        shared            name, first_name, last_name, phone: Salesforce wins
 *                          unless the app holds a change to THAT field that
 *                          Salesforce has not seen — unsent, or pushed after the
 *                          last pull of that object. See the merge-support
 *                          migration for why this replaces §2.6's timestamps.
 *        email             app-owned: never overwritten. Except for a person who
 *                          IS a Salesforce User, whose name, email and phone are
 *                          Salesforce's outright (§2.6).
 *        everything else   app-owned: never read from landing after creation.
 *   3. app_role from sf_profile_role_map, for User-sourced people only, and only
 *      where app_role_source = 'sf' — the manual admin pin is never touched.
 *   4. account_tier from sf_object_tier_map, where account_tier_source = 'sf'.
 *
 * Everything runs under app.sync_in_progress, so none of it is queued back to
 * Salesforce. Only values that differ are written, so a second run with no new
 * Salesforce data changes nothing at all.
 */
export async function mergeLandingIntoAccounts(
    opts: { trigger?: "schedule" | "manual" } = {},
): Promise<MergeResult> {
    const startedAt = new Date();
    const result: MergeResult = {
        linked: { bySalesforceId: 0, byEmail: 0, byContactAccount: 0 },
        created: 0, promoted: 0, excluded: 0, updated: 0, fieldsChanged: {},
        protectedFields: 0, roleChanges: 0, tierChanges: 0, conflicts: [],
    };

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("SET LOCAL app.sync_in_progress = 'on'");

        // ── load: these tables are CRM-sized, tens to hundreds of rows ──────
        const landing: Array<{ src: SourceDef; row: any }> = [];
        for (const src of SOURCES) {
            const { rows } = await client.query(`SELECT * FROM ${src.table}`);
            for (const row of rows) landing.push({ src, row });
        }
        const linkKey = (t: string, id: string) => `${t}:${id}`;
        const { rows: linkRows } = await client.query(
            `SELECT source_table, source_id, account_id FROM account_source_links`);
        const linkedTo = new Map<string, string>(
            linkRows.map((l: any) => [linkKey(l.source_table, l.source_id), l.account_id]));
        const { rows: exclRows } = await client.query(
            `SELECT source_table, source_id FROM account_merge_exclusions`);
        const excluded = new Set(exclRows.map((e: any) => linkKey(e.source_table, e.source_id)));

        // ── 1. link or found ────────────────────────────────────────────────
        for (const { src, row } of landing) {
            const key = linkKey(src.table, row.id);
            if (linkedTo.has(key)) continue;
            if (excluded.has(key)) { result.excluded++; continue; }

            const sfId: string | null = row[src.sfIdCol] ?? null;
            let target: string | null = null;

            if (sfId) {
                const { rows } = await client.query(
                    `SELECT id FROM accounts WHERE sf_object = $1 AND sf_id = $2
                     UNION
                     SELECT account_id FROM account_source_links WHERE sf_object = $1 AND sf_id = $2
                     LIMIT 1`, [src.sfObject, sfId]);
                target = rows[0]?.id ?? null;
                if (target) result.linked.bySalesforceId++;
            }
            if (!target && row.email) {
                const { rows } = await client.query(
                    `SELECT id FROM accounts WHERE email = $1::citext`, [row.email]);
                target = rows[0]?.id ?? null;
                if (target) result.linked.byEmail++;
            }
            if (!target && src.table === "sf_contacts" && row.account_id) {
                target = linkedTo.get(linkKey("sf_accounts", row.account_id)) ?? null;
                if (target) result.linked.byContactAccount++;
            }

            if (target) {
                await client.query(
                    `INSERT INTO account_source_links (source_table, source_id, account_id, sf_object, sf_id, is_primary)
                     VALUES ($1, $2, $3, $4, $5, false)`,
                    [src.table, row.id, target, src.sfObject, sfId]);
                linkedTo.set(key, target);

                // Promotion: the person's Salesforce identity moves up, never down.
                if (sfId) {
                    const { rows: [acct] } = await client.query(
                        `SELECT sf_object FROM accounts WHERE id = $1`, [target]);
                    if ((RANK[src.sfObject] ?? 0) > (RANK[acct?.sf_object] ?? 0)) {
                        const { rows: taken } = await client.query(
                            `SELECT 1 FROM accounts WHERE sf_object = $1 AND sf_id = $2 AND id <> $3`,
                            [src.sfObject, sfId, target]);
                        if (taken.length) {
                            result.conflicts.push({ source: key,
                                problem: `${src.sfObject} ${sfId} already belongs to another account; not promoted` });
                        } else {
                            await client.query(
                                `UPDATE accounts SET sf_object = $2, sf_id = $3, sf_last_synced_at = now() WHERE id = $1`,
                                [target, src.sfObject, sfId]);
                            result.promoted++;
                        }
                    }
                }
                continue;
            }

            // Nothing matched: this landing row founds a new person, donating its UUID.
            const cols: Record<string, unknown> = {
                id: row.id, sf_object: src.sfObject, sf_id: sfId, email: row.email ?? null,
                app_role: "user", app_role_source: "sf", account_tier_source: "sf",
                sf_last_synced_at: new Date(),
            };
            for (const [acctCol, landCol] of Object.entries({ ...src.shared, ...src.sfOwned })) {
                cols[acctCol] = row[landCol!] ?? null;
            }
            if (src.table === "sf_leads") {
                cols.name = [row.first_name, row.last_name].filter(Boolean).join(" ") || null;
            }
            for (const c of src.seed) if (row[c] !== undefined) cols[c] = row[c];

            const insert = async (values: Record<string, unknown>) => {
                const names = Object.keys(values);
                await client.query(
                    `INSERT INTO accounts (${names.join(", ")})
                     VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
                    names.map((n) => values[n]));
            };

            await client.query("SAVEPOINT found_account");
            try {
                await insert(cols);
            } catch (err: any) {
                await client.query("ROLLBACK TO SAVEPOINT found_account");
                // A handle#number another person already holds is the one collision
                // worth recovering from: keep the person, drop the claim on the handle.
                if (err?.code === "23505" && /handle/.test(String(err?.constraint ?? err?.message))) {
                    await insert({ ...cols, handle: null });
                    result.conflicts.push({ source: key,
                        problem: `handle "${row.handle}#${row.user_number}" already taken; account created without it` });
                } else {
                    result.conflicts.push({ source: key, problem: `not created: ${err?.message ?? err}` });
                    continue;
                }
            }
            await client.query("RELEASE SAVEPOINT found_account");
            await client.query(
                `INSERT INTO account_source_links (source_table, source_id, account_id, sf_object, sf_id, is_primary)
                 VALUES ($1, $2, $2, $3, $4, true)`, [src.table, row.id, src.sfObject, sfId]);
            linkedTo.set(key, row.id);
            result.created++;
        }

        // ── 2. field ownership ──────────────────────────────────────────────
        // Which (person, field) pairs the app holds a change to that Salesforce
        // has not seen: unsent, or pushed after the last pull of that object.
        const { rows: protectedRows } = await client.query(`
            WITH last_pull AS (
              SELECT sf_object, max(finished_at) AS at FROM person_sync_runs
               WHERE step = 'pull' AND ok GROUP BY sf_object)
            SELECT DISTINCT o.account_id, f.field
              FROM person_outbox o
              JOIN accounts a ON a.id = o.account_id
              LEFT JOIN last_pull lp ON lp.sf_object = a.sf_object
              CROSS JOIN LATERAL jsonb_array_elements_text(o.payload -> 'fields') AS f(field)
             WHERE o.status IN ('pending', 'in_flight', 'failed')
                OR (o.status = 'done' AND o.processed_at > coalesce(lp.at, '-infinity'::timestamptz))`);
        const appHolds = new Set(protectedRows.map((r: any) => `${r.account_id}:${r.field}`));

        const byAccount = new Map<string, Array<{ src: SourceDef; row: any }>>();
        for (const item of landing) {
            const acct = linkedTo.get(linkKey(item.src.table, item.row.id));
            if (!acct) continue;
            if (!byAccount.has(acct)) byAccount.set(acct, []);
            byAccount.get(acct)!.push(item);
        }

        for (const [accountId, items] of byAccount) {
            const { rows: [account] } = await client.query(`SELECT * FROM accounts WHERE id = $1`, [accountId]);
            if (!account) continue;
            const isUser = account.sf_object === "User";

            // Salesforce's view of this person: per column, the first non-null
            // value in rank order among the linked rows whose table HAS the
            // column. A column no linked table carries is no opinion at all.
            items.sort((a, b) => (RANK[b.src.sfObject] ?? 0) - (RANK[a.src.sfObject] ?? 0));
            const view = new Map<string, unknown>();
            const consider = (col: string, value: unknown) => {
                if (!view.has(col)) view.set(col, value ?? null);
                else if (view.get(col) == null && value != null) view.set(col, value);
            };
            for (const { src, row } of items) {
                for (const [a, l] of Object.entries(src.shared)) consider(a, row[l!]);
                for (const [a, l] of Object.entries(src.sfOwned)) consider(a, row[l!]);
                consider("email", row.email);
            }

            const set: Record<string, unknown> = {};
            for (const [col, sfValue] of view) {
                if (same(account[col], sfValue)) continue;
                if (col === "email") {
                    if (!isUser) continue;                      // app-owned for everyone else
                    if (sfValue) {
                        const { rows: taken } = await client.query(
                            `SELECT 1 FROM accounts WHERE email = $1::citext AND id <> $2`, [sfValue, accountId]);
                        if (taken.length) {
                            result.conflicts.push({ source: `account:${accountId}`,
                                problem: `Salesforce email ${sfValue} is already another account's login; not applied` });
                            continue;
                        }
                    }
                } else if ((["name", "first_name", "last_name", "phone"] as string[]).includes(col)) {
                    // A Salesforce User's shared fields are Salesforce's outright.
                    if (!isUser && appHolds.has(`${accountId}:${col}`)) { result.protectedFields++; continue; }
                }
                set[col] = sfValue;
            }

            const names = Object.keys(set);
            if (names.length) {
                await client.query(
                    `UPDATE accounts SET ${names.map((n, i) => `${n} = $${i + 2}`).join(", ")},
                            sf_last_synced_at = now()
                      WHERE id = $1`, [accountId, ...names.map((n) => set[n])]);
                result.updated++;
                for (const n of names) result.fieldsChanged[n] = (result.fieldsChanged[n] ?? 0) + 1;
            }
        }

        // ── 3. app_role, User-sourced only, never the manual pin ────────────
        const roles = await client.query(`
            UPDATE accounts a
               SET app_role = coalesce(
                     (SELECT m.app_role FROM sf_profile_role_map m WHERE m.sf_profile = a.sf_profile), 'user')
             WHERE a.app_role_source = 'sf'
               AND EXISTS (SELECT 1 FROM account_source_links l
                            WHERE l.account_id = a.id AND l.source_table = 'sf_users')
               AND a.app_role IS DISTINCT FROM coalesce(
                     (SELECT m.app_role FROM sf_profile_role_map m WHERE m.sf_profile = a.sf_profile), 'user')`);
        result.roleChanges = roles.rowCount ?? 0;

        // ── 4. account_tier from the object map ─────────────────────────────
        const tiers = await client.query(`
            UPDATE accounts a SET account_tier = t.account_tier
              FROM sf_object_tier_map t
             WHERE t.sf_object = a.sf_object
               AND a.account_tier_source = 'sf'
               AND a.account_tier IS DISTINCT FROM t.account_tier`);
        result.tierChanges = tiers.rowCount ?? 0;

        await client.query(
            `INSERT INTO person_sync_runs (step, trigger, started_at, ok, result)
             VALUES ('merge', $1, $2, true, $3)`,
            [opts.trigger ?? "schedule", startedAt, JSON.stringify(result)]);
        await client.query("COMMIT");
        return result;
    } catch (err: any) {
        await client.query("ROLLBACK");
        await query(
            `INSERT INTO person_sync_runs (step, trigger, started_at, ok, error)
             VALUES ('merge', $1, $2, false, $3)`,
            [opts.trigger ?? "schedule", startedAt, String(err?.message ?? err).slice(0, 2000)]);
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Record that Salesforce's records of one object type landed. Called by
 * POST /api/sync/salesforce; the merge uses the latest per object to decide
 * whether a pushed change can have come back yet.
 */
export async function recordPull(sfObject: string, startedAt: Date, result: unknown, ok = true, error?: string) {
    await query(
        `INSERT INTO person_sync_runs (step, sf_object, trigger, started_at, ok, result, error)
         VALUES ('pull', $1, 'salesforce', $2, $3, $4, $5)`,
        [sfObject, startedAt, ok, JSON.stringify(result ?? null), error ?? null]);
}

// ── Orchestration (slice 6d) ────────────────────────────────────────────────

/** Arbitrary but fixed: identifies the person-sync lock among advisory locks. */
const PERSON_SYNC_LOCK = 350_035;

export interface PersonSyncResult {
    ran: boolean;
    reason?: string;
    drain?: DrainResult;
    merge?: MergeResult;
}

/**
 * The nightly pipeline, and the admin "run now": drain, then merge.
 *
 * Plan §2.8's order is push -> pull -> merge. The middle step is not ours to
 * run: Salesforce's own scheduled Apex (GenericDataSyncBatch / AccountSyncBatch)
 * POSTs its records to /api/sync/salesforce whenever the org schedules it. So
 * this runs the two ends, and the merge's shared-field rule is what makes the
 * order safe regardless of when that pull happens: a change pushed after the
 * last pull of its object is protected until a pull could have brought it back.
 *
 * One run at a time. The lock is a TRANSACTION-level advisory lock held on a
 * dedicated connection for the length of the run: dev's DATABASE_URL is a
 * PgBouncer pooler, and behind transaction pooling a session-level lock can
 * outlive its statement on a backend that someone else is then handed. An open
 * transaction pins its backend, so the xact lock is held exactly as long as the
 * run and released however the run ends.
 */
export async function runPersonSync(opts: {
    trigger?: "schedule" | "manual";
    sf?: SalesforcePersonClient;
} = {}): Promise<PersonSyncResult> {
    const trigger = opts.trigger ?? "schedule";
    const lock = await pool.connect();
    try {
        await lock.query("BEGIN");
        const { rows: [got] } = await lock.query(
            `SELECT pg_try_advisory_xact_lock($1) AS ok`, [PERSON_SYNC_LOCK]);
        if (!got?.ok) {
            await lock.query("ROLLBACK");
            return { ran: false, reason: "another person-sync run is in progress" };
        }

        const drainStarted = new Date();
        let drain: DrainResult;
        try {
            drain = await drainPersonOutbox({ sf: opts.sf });
            await query(
                `INSERT INTO person_sync_runs (step, trigger, started_at, ok, result)
                 VALUES ('drain', $1, $2, true, $3)`,
                [trigger, drainStarted, JSON.stringify(drain)]);
        } catch (err: any) {
            await query(
                `INSERT INTO person_sync_runs (step, trigger, started_at, ok, error)
                 VALUES ('drain', $1, $2, false, $3)`,
                [trigger, drainStarted, String(err?.message ?? err).slice(0, 2000)]);
            throw err;
        }

        // A failed push does not stop the merge: its fields are protected by the
        // 'failed' outbox row, so merging cannot clobber them.
        const merge = await mergeLandingIntoAccounts({ trigger });

        await lock.query("COMMIT");
        return { ran: true, drain, merge };
    } catch (err) {
        await lock.query("ROLLBACK").catch(() => { /* connection may be gone */ });
        throw err;
    } finally {
        lock.release();
    }
}

/** What the admin page shows: queue health, the last runs, and what is stuck. */
export async function personSyncStatus() {
    const [{ rows: queue }, { rows: runs }, { rows: failed }, { rows: [unsynced] }] = await Promise.all([
        query(`SELECT status, count(*)::int AS n FROM person_outbox GROUP BY status ORDER BY status`),
        query(`SELECT step, sf_object, trigger, started_at, finished_at, ok, result, error
                 FROM person_sync_runs ORDER BY finished_at DESC LIMIT 15`),
        query(`SELECT o.id, o.account_id, o.op, o.payload, o.attempts, o.last_error, o.created_at,
                      a.email, a.name, a.sf_object, a.sf_id
                 FROM person_outbox o JOIN accounts a ON a.id = o.account_id
                WHERE o.status = 'failed' ORDER BY o.created_at DESC LIMIT 50`),
        // Plan §2.8: sf_id IS NULL marks "app-native, not in the CRM yet". A count
        // that keeps growing means the drain has stalled, which should be visible
        // rather than silent.
        query(`SELECT count(*)::int AS n FROM accounts WHERE sf_id IS NULL AND sf_object = 'Lead'`),
    ]);
    return { queue, runs, failed, awaitingSalesforce: unsynced?.n ?? 0 };
}

/** Put a failed row back in the queue — the admin "retry". Folds like any retry. */
export async function retryFailedOutboxRow(id: string): Promise<boolean> {
    const { rows } = await query(
        `UPDATE person_outbox SET status = 'pending', attempts = 0, last_error = NULL
          WHERE id = $1 AND status = 'failed'
            AND NOT EXISTS (SELECT 1 FROM person_outbox p
                             WHERE p.account_id = person_outbox.account_id AND p.status = 'pending')
          RETURNING id`, [id]);
    if (rows.length) return true;
    // The person already has a pending row: fold this one's fields into it.
    const { rows: folded } = await query(
        `WITH f AS (SELECT account_id, op, payload FROM person_outbox WHERE id = $1 AND status = 'failed')
         UPDATE person_outbox p
            SET op = CASE WHEN p.op = 'create' OR f.op = 'create' THEN 'create' ELSE 'update' END,
                payload = jsonb_build_object('fields', (
                  SELECT to_jsonb(array_agg(x ORDER BY x)) FROM (
                    SELECT jsonb_array_elements_text(p.payload -> 'fields') AS x
                    UNION SELECT jsonb_array_elements_text(f.payload -> 'fields')) u))
           FROM f WHERE p.account_id = f.account_id AND p.status = 'pending'
         RETURNING p.id`, [id]);
    if (!folded.length) return false;
    await query(`DELETE FROM person_outbox WHERE id = $1 AND status = 'failed'`, [id]);
    return true;
}
