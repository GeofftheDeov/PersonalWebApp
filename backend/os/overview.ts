import type pg from "pg";

/**
 * The agentic OS overview (spec #135, W2): one module that builds every tile
 * in parallel for /admin/os and its JSON.
 *
 * A tile is `{ status: 'ok', ...data }` or `{ status: 'unavailable', reason }`.
 * Each tile degrades on its own: a throw, a missing table or column, or a
 * timeout (#140, see TILE_BUDGET_MS) becomes `unavailable` with a reason, so one broken source
 * never blanks the page or turns the response into a 500.
 *
 * The page reads only the database, in-memory state and the local vault
 * checkout. A tile never calls an outside service.
 *
 * Adding a tile: write a TileSource in os/tiles/<name>.ts and list it in
 * os/tiles/index.ts. Its `build` returns ok(data) or unavailable(reason); its
 * `render` draws the ok state; the unavailable state is drawn for it.
 */

/**
 * Time budgets (#140): one slow source can't hold up the overview.
 *
 * Every query a tile sends through `ctx.db` runs in a short transaction of its
 * own on a pooled client, `BEGIN; SET LOCAL statement_timeout = TILE_BUDGET_MS`,
 * so Postgres cancels a blocked or slow query (57014), the transaction rolls
 * back and the client goes back to the pool clean. SET LOCAL, not a session
 * SET: DATABASE_URL is a PgBouncer pooler in transaction mode, where a session
 * setting can land on another server connection and leak to other clients.
 * A client is held only for its one query, so a tile's queries still run in
 * parallel, and one failed query doesn't abort the tile's others.
 *
 * The whole build is also raced against TILE_BUDGET_MS + TILE_DEADLINE_GRACE_MS,
 * which bounds non-database waits (and the wait for a pool client) too; the
 * grace lets a tile that catches its own cancelled query (the brief tile's run
 * history) finish in its degraded state. Either way the tile is unavailable
 * with TIMED_OUT_REASON, and once the deadline passes the tile can't start
 * another query. Synchronous work (the brief tile's vault read) can't be
 * interrupted; it counts against the deadline but runs to the end.
 *
 * A new tile inherits all of this from buildOverview: it reads `ctx.db`.
 */
/** How long one tile query may run before Postgres cancels it. */
export const TILE_BUDGET_MS = 400;
/** How long past TILE_BUDGET_MS a tile's build may run before the overview stops waiting for it. */
export const TILE_DEADLINE_GRACE_MS = 150;
/** The whole overview's target response time; the tile deadline leaves room for rendering under it. */
export const OVERVIEW_BUDGET_MS = 1_000;
/** A timed-out tile's reason. */
export const TIMED_OUT_REASON = `timed out (over its ${TILE_BUDGET_MS} ms budget)`;

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
    /**
     * The database. Given to buildOverview, it's the pool; inside a tile's
     * build it's that pool behind the tile's time budget (see TILE_BUDGET_MS).
     */
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
    if (err?.code === "57014") return isStatementTimeout(err) ? "timed out" : "query cancelled";
    return msg.length > MAX_REASON ? msg.slice(0, MAX_REASON - 1) + "…" : msg;
}

/** 57014 query_canceled from a statement timeout (the tile budget), as opposed to a manual or shutdown cancel. */
export const isStatementTimeout = (err: any): boolean =>
    err?.code === "57014" && /statement timeout/i.test(String(err?.message ?? ""));

/** A pg.Pool (or anything shaped like one): it hands out clients of its own. */
interface PoolLike extends Queryable {
    connect(): Promise<pg.PoolClient>;
}
const isPool = (db: Queryable): db is PoolLike =>
    typeof (db as any).connect === "function" && typeof (db as any).totalCount === "number";

/** Thrown by a tile's db once the overview has stopped waiting for the tile. */
class TileDeadlinePassed extends Error {
    constructor() { super("the tile's time budget is spent"); }
}

/**
 * Runs one query on its own pooled client, in a transaction whose
 * statement_timeout is `ms`. A cancelled or failed query is rolled back and its
 * client returned clean; a client that can't be rolled back is destroyed
 * rather than pooled.
 */
async function queryWithTimeout(pool: PoolLike, ms: number, text: string, params?: unknown[]) {
    const c = await pool.connect();
    /** Set when the client's state is unknown: release(err) destroys it instead of pooling it. */
    let destroy: Error | undefined;
    try {
        try {
            // One round trip. SET LOCAL ends with the transaction, on whichever server connection PgBouncer picked.
            await c.query(`BEGIN; SET LOCAL statement_timeout = ${Math.round(ms)}`);
        } catch (err) {
            destroy = err as Error;
            throw err;
        }
        try {
            const result = await c.query(text, params as any[]);
            await c.query("COMMIT");
            return result;
        } catch (err) {
            await c.query("ROLLBACK").catch((e: Error) => { destroy = e; });
            throw err;
        }
    } finally {
        c.release(destroy);
    }
}

/**
 * One tile's view of the database. Over a pool every query gets the tile
 * budget (queryWithTimeout). Over a Queryable that isn't a pool (a single
 * client, a test fake) there's nothing to set a timeout on: queries pass
 * through, and only the deadline race bounds the tile. `close()` stops new
 * queries: a tile the overview gave up on can't start another.
 */
function tileDb(db: Queryable, statementMs: number): { db: Queryable; close(): void } {
    let closed = false;
    const pool = isPool(db) ? db : null;
    return {
        db: {
            async query(text: string, params?: unknown[]) {
                if (closed) throw new TileDeadlinePassed();
                return pool ? queryWithTimeout(pool, statementMs, text, params) : db.query(text, params);
            },
        },
        close() { closed = true; },
    };
}

async function runTile(source: TileSource<any>, ctx: TileContext): Promise<Tile> {
    try {
        const tile = await source.build(ctx);
        if (tile?.status === "ok" || tile?.status === "unavailable") return tile;
        return unavailable("tile returned no state");
    } catch (err) {
        if (err instanceof TileDeadlinePassed) return unavailable(TIMED_OUT_REASON);
        console.error(`[os] tile ${source.id} failed:`, (err as any)?.message ?? err);
        if (isStatementTimeout(err)) return unavailable(TIMED_OUT_REASON);
        let reason: string | undefined;
        try { reason = source.explain?.(err); } catch { /* fall back */ }
        return unavailable(reason ?? describeError(err));
    }
}

/** One tile, its queries under the budget, raced against its deadline. Never rejects. */
async function buildTile(source: TileSource<any>, ctx: TileContext): Promise<Tile> {
    const conn = tileDb(ctx.db, TILE_BUDGET_MS);
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"deadline">((resolve) => {
        timer = setTimeout(() => resolve("deadline"), TILE_BUDGET_MS + TILE_DEADLINE_GRACE_MS);
    });
    // runTile never rejects, so the abandoned build can't raise an unhandled rejection.
    const outcome = await Promise.race([runTile(source, { ...ctx, db: conn.db }), deadline]);
    clearTimeout(timer);
    conn.close();
    if (outcome === "deadline") {
        // A query still in flight is cancelled by its statement_timeout and its client returned then.
        console.error(`[os] tile ${source.id} timed out after ${TILE_BUDGET_MS + TILE_DEADLINE_GRACE_MS} ms`);
        return unavailable(TIMED_OUT_REASON);
    }
    return outcome;
}

/**
 * Builds every tile in parallel, each within its time budget. Never rejects
 * because of a tile. Over a pool, each query holds a pooled client only while
 * it runs.
 */
export async function buildOverview(sources: readonly TileSource<any>[], ctx: TileContext): Promise<Overview> {
    const built = await Promise.all(sources.map((s) => buildTile(s, ctx)));
    return {
        generatedAt: ctx.now.toISOString(),
        tiles: Object.fromEntries(sources.map((s, i) => [s.id, built[i]])),
    };
}
