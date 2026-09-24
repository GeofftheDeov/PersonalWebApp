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
}

/** "Ada King Lovelace" -> { first: "Ada King", last: "Lovelace" }. */
function splitName(full: string | null): { first: string | null; last: string | null } {
    const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return { first: null, last: null };
    if (parts.length === 1) return { first: null, last: parts[0] };
    return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
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
    } else if (sobject === "Account") {
        // A business Account has Name and Phone. It has no Email, FirstName or
        // LastName unless Person Accounts are enabled in the org — which this
        // repo cannot see — so those changes are reported, not pushed.
        if (want.has("name") || want.has("first_name") || want.has("last_name")) {
            fields.Name = account.name ?? [first, last].filter(Boolean).join(" ");
        }
        if (want.has("phone")) fields.Phone = account.phone;
        if (want.has("email")) notPushed.push("email (Account has no standard Email field)");
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
                    `SELECT id, email, name, first_name, last_name, phone, company, sf_object, sf_id
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
