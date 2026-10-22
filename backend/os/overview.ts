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
 * Each tile reads the database through its own pooled connection carrying
 * `statement_timeout = TILE_BUDGET_MS`, so Postgres cancels a blocked or slow
 * query (57014) and the connection goes back to the pool, healthy. The whole
 * build is also raced against TILE_BUDGET_MS + TILE_DEADLINE_GRACE_MS, which
 * bounds non-database waits too; the grace lets a tile that catches its own
 * cancelled query (the brief tile's run history) finish in its degraded state.
 * Either way the tile is unavailable with TIMED_OUT_REASON. Synchronous work
 * (the brief tile's vault read) can't be interrupted; it counts against the
 * deadline but runs to the end.
 *
 * A new tile inherits all of this from buildOverview: it reads `ctx.db`.
 */
/** How long one tile's statement may run before Postgres cancels it. */
export const TILE_BUDGET_MS = 400;
/** How long past TILE_BUDGET_MS a tile's build may run before the overview stops waiting for it. */
export const TILE_DEADLINE_GRACE_MS = 100;
/** The whole overview's target response time; the tile deadline leaves room for rendering under it. */
export const OVERVIEW_BUDGET_MS = 1_000;
/** A timed-out tile's reason. */
export const TIMED_OUT_REASON = `timed out (over its ${TILE_BUDGET_MS} ms budget)`;

export type Unavailable ={ status: "unavailable"; reason: string };
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
     * The database. Inside a tile's build this is the tile's own budgeted
     * connection (see TILE_BUDGET_MS), never the pool itself.
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
    // 57014 query_canceled: a statement timeout (#140's per-tile budget), or a manual/shutdown cancel.
    if (err?.code === "57014") return /statement timeout/i.test(msg) ? "timed out" : "query cancelled";
    return msg.length > MAX_REASON ? msg.slice(0, MAX_REASON - 1) + "…" : msg;
}

/** A pg.Pool (or anything shaped like one): it can hand out a client of its own. */
interface PoolLike extends Queryable {
    connect(): Promise<pg.PoolClient>;
    totalCount: number;
}
const isPool = (db: Queryable): db is PoolLike =>
    typeof (db as any).connect === "function" && typeof (db as any).totalCount === "number";

/** Thrown by a tile's db once the overview has stopped waiting for the tile. */
class TileDeadlinePassed extends Error {
    constructor() { super("the tile's time budget is spent"); }
}

/** A statement timeout (57014 with Postgres's message), as opposed to another cancel. */
const isStatementTimeout = (err: any) => err?.code === "57014" && /statement timeout/i.test(String(err?.message ?? ""));

/**
 * One tile's view of the database: a pooled client of its own, taken on its
 * first query, with `statement_timeout` set to `statementMs`. Queries issued
 * concurrently within the tile run one after another on that client.
 *
 * `close()` stops new queries and returns the client once whatever is in
 * flight has finished (a blocked one is cancelled by the timeout), after
 * resetting the timeout; a client that can't be reset is destroyed rather
 * than pooled.
 *
 * Over a Queryable that isn't a pool (a single client, a test fake) there's no
 * connection to set a timeout on: queries pass straight through, and only the
 * deadline race bounds the tile.
 */
function tileDb(db: Queryable, statementMs: number): { db: Queryable; close(): Promise<void> } {
    if (!isPool(db)) return { db, close: async () => {} };
    let closed = false;
    let client: Promise<pg.PoolClient> | null = null;
    const acquire = () => (client ??= (async () => {
        const c = await db.connect();
        try {
            await c.query(`SET statement_timeout = ${Math.round(statementMs)}`);
        } catch (err) {
            c.release(err as Error);
            throw err;
        }
        return c;
    })());
    return {
        db: {
            async query(text: string, params?: unknown[]) {
                if (closed) throw new TileDeadlinePassed();
                const c = await acquire();
                if (closed) throw new TileDeadlinePassed();
                return c.query(text, params as any[]);
            },
        },
        async close() {
            closed = true;
            if (!client) return;
            let c: pg.PoolClient;
            try { c = await client; } catch { return; } // never connected, or released already
            try {
                // Queued behind any statement still in flight on this client.
                await c.query(`RESET statement_timeout`);
                c.release();
            } catch (err) {
                c.release(err as Error);
            }
        },
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

/** One tile, on its own budgeted connection, raced against its deadline. Never rejects. */
async function buildTile(source: TileSource<any>, ctx: TileContext): Promise<Tile> {
    const conn = tileDb(ctx.db, TILE_BUDGET_MS);
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"deadline">((resolve) => {
        timer = setTimeout(() => resolve("deadline"), TILE_BUDGET_MS + TILE_DEADLINE_GRACE_MS);
    });
    const built = runTile(source, { ...ctx, db: conn.db });
    const outcome = await Promise.race([built, deadline]);
    clearTimeout(timer);
    if (outcome === "deadline") {
        console.error(`[os] tile ${source.id} timed out after ${TILE_BUDGET_MS + TILE_DEADLINE_GRACE_MS} ms`);
        // Don't hold the response for it: the client goes back once its statement is cancelled.
        conn.close().catch(() => {});
        return unavailable(TIMED_OUT_REASON);
    }
    await conn.close();
    return outcome;
}

/**
 * Builds every tile in parallel, each within its time budget. Never rejects
 * because of a tile. With a pool as `ctx.db`, each tile holds one pooled
 * connection while it builds.
 */
export async function buildOverview(sources: readonly TileSource<any>[], ctx: TileContext): Promise<Overview> {
    const built = await Promise.all(sources.map((s) => buildTile(s, ctx)));
    return {
        generatedAt: ctx.now.toISOString(),
        tiles: Object.fromEntries(sources.map((s, i) => [s.id, built[i]])),
    };
}
