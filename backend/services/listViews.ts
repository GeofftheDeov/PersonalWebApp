/**
 * Saved list views for the admin table browser (/db, "The Workshop").
 *
 * Plain SQL rather than defineModel: this is new code with no mongoose call
 * sites to stay compatible with. Table: migrations/2026-09-25-admin-list-views.sql.
 *
 * The config blob is written by the browser, so it is rebuilt field by field
 * here rather than stored as received — nothing the client sends beyond the
 * known shape reaches the database.
 */
import { query, withTransaction } from '../db/index.js';
import { isUuid } from '../db/model.js';

export const FILTER_OPS = ['contains', 'not_contains', 'equals', 'not_equals', 'starts', 'empty', 'not_empty', 'gt', 'lt'] as const;
type FilterOp = typeof FILTER_OPS[number];

export interface ListViewConfig {
    columns: { key: string; width: number | null; hidden: boolean }[];
    sort: { key: string; order: 'asc' | 'desc' }[];
    search: string;
    filters: { key: string; op: FilterOp; value: string }[];
}

export interface ListView {
    id: string;
    collection: string;
    name: string;
    config: ListViewConfig;
    isDefault: boolean;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
}

/** A 4xx the route can hand straight back to the page. */
export class ListViewError extends Error {
    constructor(public status: number, message: string, public code?: string) { super(message); }
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v : '').slice(0, max);

export function sanitizeConfig(raw: any): ListViewConfig {
    const src = raw && typeof raw === 'object' ? raw : {};
    const columns = (Array.isArray(src.columns) ? src.columns : []).slice(0, 500)
        .filter((c: any) => c && typeof c.key === 'string' && c.key)
        .map((c: any) => {
            const w = Number(c.width);
            return {
                key: str(c.key, 200),
                width: Number.isFinite(w) && w > 0 ? Math.round(Math.min(Math.max(w, 40), 2000)) : null,
                hidden: c.hidden === true,
            };
        });
    const sort = (Array.isArray(src.sort) ? src.sort : []).slice(0, 10)
        .filter((s: any) => s && typeof s.key === 'string' && s.key)
        .map((s: any) => ({ key: str(s.key, 200), order: s.order === 'desc' ? 'desc' as const : 'asc' as const }));
    const filters = (Array.isArray(src.filters) ? src.filters : []).slice(0, 30)
        .filter((f: any) => f && typeof f.key === 'string' && f.key && FILTER_OPS.includes(f.op))
        .map((f: any) => ({ key: str(f.key, 200), op: f.op as FilterOp, value: str(f.value, 500) }));
    return { columns, sort, search: str(src.search, 500), filters };
}

function cleanName(v: unknown): string {
    const name = typeof v === 'string' ? v.trim() : '';
    if (!name) throw new ListViewError(400, 'A view needs a name.');
    if (name.length > 80) throw new ListViewError(400, 'View names are limited to 80 characters.');
    return name;
}

const toView = (r: any): ListView => ({
    id: r.id,
    collection: r.collection,
    name: r.name,
    config: sanitizeConfig(r.config),
    isDefault: r.is_default,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
});

/** Translate the Postgres errors a user can actually cause into readable ones. */
function explain(err: any, name?: string): never {
    if (err instanceof ListViewError) throw err;
    if (err?.code === '42P01') {
        throw new ListViewError(503,
            'List views are not set up on this database yet — apply backend/db/migrations/2026-09-25-admin-list-views.sql.',
            'LIST_VIEWS_TABLE_MISSING');
    }
    if (err?.code === '23505') throw new ListViewError(409, `A view named "${name ?? ''}" already exists for this table.`);
    throw err;
}

export async function listViews(collection: string): Promise<ListView[]> {
    try {
        const { rows } = await query(
            'SELECT * FROM admin_list_views WHERE collection = $1 ORDER BY is_default DESC, lower(name)', [collection]);
        return rows.map(toView);
    } catch (err) { explain(err); }
}

export async function createView(
    collection: string,
    input: { name: unknown; config: unknown; isDefault?: unknown },
    createdBy: string | null,
): Promise<ListView> {
    const name = cleanName(input.name);
    const config = sanitizeConfig(input.config);
    const isDefault = input.isDefault === true;
    try {
        return await withTransaction(async (c) => {
            if (isDefault) await c.query('UPDATE admin_list_views SET is_default = false WHERE collection = $1 AND is_default', [collection]);
            const { rows } = await c.query(
                `INSERT INTO admin_list_views (collection, name, config, is_default, created_by)
                 VALUES ($1, $2, $3::jsonb, $4, $5) RETURNING *`,
                [collection, name, JSON.stringify(config), isDefault, createdBy]);
            return toView(rows[0]);
        });
    } catch (err) { explain(err, name); }
}

export async function updateView(
    collection: string,
    id: string,
    patch: { name?: unknown; config?: unknown; isDefault?: unknown },
): Promise<ListView> {
    if (!isUuid(id)) throw new ListViewError(404, 'That view no longer exists.');
    const sets: string[] = [];
    const params: unknown[] = [];
    let name: string | undefined;
    if (patch.name !== undefined) { name = cleanName(patch.name); params.push(name); sets.push(`name = $${params.length}`); }
    if (patch.config !== undefined) { params.push(JSON.stringify(sanitizeConfig(patch.config))); sets.push(`config = $${params.length}::jsonb`); }
    if (patch.isDefault !== undefined) { params.push(patch.isDefault === true); sets.push(`is_default = $${params.length}`); }
    if (!sets.length) throw new ListViewError(400, 'Nothing to update.');
    try {
        return await withTransaction(async (c) => {
            if (patch.isDefault === true) {
                await c.query('UPDATE admin_list_views SET is_default = false WHERE collection = $1 AND is_default AND id <> $2', [collection, id]);
            }
            params.push(id, collection);
            const { rows } = await c.query(
                `UPDATE admin_list_views SET ${sets.join(', ')}
                 WHERE id = $${params.length - 1} AND collection = $${params.length} RETURNING *`, params);
            if (!rows[0]) throw new ListViewError(404, 'That view no longer exists.');
            return toView(rows[0]);
        });
    } catch (err) { explain(err, name); }
}

export async function deleteView(collection: string, id: string): Promise<void> {
    if (!isUuid(id)) throw new ListViewError(404, 'That view no longer exists.');
    try {
        const res = await query('DELETE FROM admin_list_views WHERE id = $1 AND collection = $2', [id, collection]);
        if (!res.rowCount) throw new ListViewError(404, 'That view no longer exists.');
    } catch (err) { explain(err); }
}
