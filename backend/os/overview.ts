import type pg from "pg";

/**
 * The agentic OS overview (spec #135, W2): one module that builds every tile
 * in parallel for /admin/os and its JSON.
 *
 * A tile is `{ status: 'ok', ...data }` or `{ status: 'unavailable', reason }`.
 * Each tile degrades on its own: a throw, a missing table or column (and, from
 * #140, a timeout) becomes `unavailable` with a reason, so one broken source
 * never blanks the page or turns the response into a 500.
 *
 * The page reads only the database, in-memory state and the local vault
 * checkout. A tile never calls an outside service.
 *
 * Adding a tile: write a TileSource in os/tiles/<name>.ts and list it in
 * os/tiles/index.ts. Its `build` returns ok(data) or unavailable(reason); its
 * `render` draws the ok state; the unavailable state is drawn for it.
 */

export type Unavailable = { status: "unavailable"; reason: string };
export type Ok<T extends object> = { status: "ok" } & T;
export type Tile<T extends object = object> = Ok<T> | Unavailable;

// status last, so a data field named `status` can't overwrite the state.
export const ok = <T extends object>(data: T): Ok<T> => ({ ...data, status: "ok" });
export const unavailable = (reason: string): Unavailable => ({ status: "unavailable", reason });

/** What a tile may read the database through (a pool or one client). */
export interface Queryable {
    query<R extends pg.QueryResultRow = any>(text: string, params?: unknown[]): Promise<pg.QueryResult<R>>;
}

/** Everything a tile's build gets. Tiles read the clock from here, never `new Date()`. */
export interface TileContext {
    now: Date;
    db: Queryable;
}

/** Everything a tile's render gets. */
export interface ViewContext {
    now: Date;
    /** Appends the admin `?token=` to an admin path. */
    link(path: string): string;
}

export interface TileSource<T extends object = object> {
    /** Key in `overview.tiles` and the HTML's `data-tile`. */
    id: string;
    /** Header text. */
    title: string;
    /** The admin page with the full picture (no token); the tile header links to it. */
    href: string;
    build(ctx: TileContext): Promise<Tile<T>>;
    /** The body of the ok state, as HTML. Escape everything that came from data. */
    render(tile: Ok<T>, view: ViewContext): string;
    /** A tile-specific reason for an error (e.g. naming a missing migration); falls back to describeError. */
    explain?(err: unknown): string | undefined;
}

export interface Overview {
    generatedAt: string;
    tiles: Record<string, Tile>;
}

const MAX_REASON = 200;

/** A short, admin-facing reason for a failed tile. */
export function describeError(err: any): string {
    const msg = String(err?.message ?? err ?? "unknown error");
    // 42P01 undefined_table, 42703 undefined_column: a migration hasn't been applied.
    if (err?.code === "42P01") return `table missing (${msg.match(/relation "([^"]+)"/)?.[1] ?? msg})`;
    if (err?.code === "42703") return `column missing (${msg.match(/column "?([^" ]+)"? does not exist/)?.[1] ?? msg})`;
    // 57014 query_canceled: a statement timeout (#140's per-tile budget), or a manual/shutdown cancel.
    if (err?.code === "57014") return /statement timeout/i.test(msg) ? "timed out" : "query cancelled";
    return msg.length > MAX_REASON ? msg.slice(0, MAX_REASON - 1) + "…" : msg;
}

async function buildTile(source: TileSource<any>, ctx: TileContext): Promise<Tile> {
    try {
        const tile = await source.build(ctx);
        if (tile?.status === "ok" || tile?.status === "unavailable") return tile;
        return unavailable("tile returned no state");
    } catch (err) {
        console.error(`[os] tile ${source.id} failed:`, (err as any)?.message ?? err);
        let reason: string | undefined;
        try { reason = source.explain?.(err); } catch { /* fall back */ }
        return unavailable(reason ?? describeError(err));
    }
}

/** Builds every tile in parallel. Never rejects because of a tile. */
export async function buildOverview(sources: readonly TileSource<any>[], ctx: TileContext): Promise<Overview> {
    const built = await Promise.all(sources.map((s) => buildTile(s, ctx)));
    return {
        generatedAt: ctx.now.toISOString(),
        tiles: Object.fromEntries(sources.map((s, i) => [s.id, built[i]])),
    };
}
