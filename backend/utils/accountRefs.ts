import { query } from "../db/index.js";
import { isUuid } from "../db/model.js";

/**
 * Resolving a person id that predates the unified account model (#35, plan §2.3).
 *
 * The Phase 2 merge (#34) collapsed 40 landing rows into 19 accounts. Nineteen
 * source rows donated their UUID to the account they won; the rest kept ids that
 * are no longer any `accounts.id`. Phase 2 asserted that every reference in the
 * database still *resolves* — through `accounts.id` OR `account_source_links` —
 * which was the right bar while the app read the four landing tables.
 *
 * Phase 3 raises that bar. The app now queries `accounts` directly, so an id
 * that only resolves via a link returns nothing at all: a friends list quietly
 * loses a person, a character loses its player. The one-time migration
 * `2026-09-09-phase3-remap-person-refs.sql` rewrites every stored reference, so
 * nothing in the database needs this helper afterwards.
 *
 * What still does: ids arriving from OUTSIDE the database — a JWT minted before
 * the cutover, a bookmarked `/players/<id>` URL, an id a client cached. Those
 * cannot be migrated, so they get resolved on the way in.
 */

/**
 * Map any historical person id to its current account id.
 *
 * Returns the id unchanged when it is already an account, the winning account's
 * id when it is a merged-away source row, and null when it is neither (an
 * unknown id, or one of the landing rows deliberately excluded from the merge).
 */
export async function resolveAccountId(id: string): Promise<string | null> {
    if (!isUuid(String(id))) return null;
    const { rows } = await query<{ account_id: string }>(
        `SELECT id AS account_id FROM accounts WHERE id = $1
         UNION ALL
         SELECT account_id FROM account_source_links
          WHERE source_id = $1 AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = $1)
         LIMIT 1`,
        [id],
    );
    return rows[0]?.account_id ?? null;
}

/** Batch form. Returns a map of input id -> account id, omitting ids that resolve to nothing. */
export async function resolveAccountIds(ids: string[]): Promise<Map<string, string>> {
    const valid = [...new Set(ids.map(String).filter(isUuid))];
    if (!valid.length) return new Map();
    const { rows } = await query<{ given: string; account_id: string }>(
        `SELECT g.given, COALESCE(a.id, l.account_id) AS account_id
           FROM unnest($1::uuid[]) AS g(given)
           LEFT JOIN accounts a ON a.id = g.given
           LEFT JOIN account_source_links l ON l.source_id = g.given
          WHERE COALESCE(a.id, l.account_id) IS NOT NULL`,
        [valid],
    );
    return new Map(rows.map((r) => [String(r.given), String(r.account_id)]));
}
