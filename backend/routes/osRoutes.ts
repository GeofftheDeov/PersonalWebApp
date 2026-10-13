import express from "express";
import { performance } from "perf_hooks";
import pool from "../db/index.js";
import { buildOverview, describeError, type Overview, type Queryable, type TileSource } from "../os/overview.js";
import { renderOverviewPage } from "../os/page.js";
import { TILES } from "../os/tiles/index.js";
import {
    ASK_SOURCES, MAX_ASK_CHARS, matchCommand, normaliseAsk,
    type AskReply, type AskSource, type Command,
} from "../os/ask.js";
import { COMMANDS, isAllowedPage } from "../os/commands.js";
import type { OsModel } from "../os/model.js";

/**
 * /admin/os — the agentic OS home screen (spec #135, W2) and its ask router (W3).
 *
 *   GET  /admin/os                the overview page (HTML), with the ask box
 *   GET  /admin/os/api/overview   the same overview as JSON: { generatedAt, tiles: { [id]: Tile } }
 *   POST /admin/os/ask            { text, source: 'voice' | 'typed' } -> AskReply (os/ask.ts)
 *
 * Mounted inside adminRoutes after verifyToken + requireAdmin, so every route
 * here is admin-only. Built from a factory so tests inject the clock, the tile
 * list, the command table and the model client.
 */
export interface OsRouterDeps {
    /** The clock every tile and command reads. */
    now?: () => Date;
    /** The tiles, in page order. */
    tiles?: readonly TileSource<any>[];
    db?: Queryable;
    /** Tier 1's command table, in match order. */
    commands?: readonly Command[];
    /**
     * Tier 2's model client (#154). null (the default until #154 wires the
     * Haiku client) means no tier 2: an ask no command matches is
     * `not_understood`. Tier 1 never calls it.
     */
    model?: OsModel | null;
}

const NOT_UNDERSTOOD: AskReply = {
    tier: 1, kind: "not_understood",
    say: "Sorry, I didn't understand that.",
    display: "Try “open alpaca”, “show the briefs” or “go to the vault”.",
};
const FAILED: AskReply = { tier: 1, kind: "unavailable", say: "Sorry, something went wrong answering that." };

export function createOsRouter({
    now = () => new Date(), tiles = TILES, db = pool, commands = COMMANDS, model = null,
}: OsRouterDeps = {}) {
    const router = express.Router();
    // Taken now so tests already pin "tier 1 never calls the model"; tier 2 (#154) uses it.
    void model;

    const overview = (at: Date) => buildOverview(tiles, { now: at, db });

    router.get("/", async (req, res) => {
        const at = now();
        try {
            const token = String(req.query.token ?? "");
            // The page carries the admin token in every link: keep it out of caches.
            res.set("Cache-Control", "no-store").send(renderOverviewPage({ token, now: at, overview: await overview(at), sources: tiles }));
        } catch (err: any) {
            console.error("[os] overview page failed:", err?.message ?? err);
            res.status(500).send("overview failed");
        }
    });

    router.get("/api/overview", async (_req, res) => {
        try {
            res.set("Cache-Control", "no-store").json(await overview(now()));
        } catch (err: any) {
            console.error("[os] overview JSON failed:", err?.message ?? err);
            res.status(500).json({ error: "overview failed" });
        }
    });

    // The body is parsed by the app's express.json() (server.ts), as for every admin route.
    router.post("/ask", async (req: any, res) => {
        const started = performance.now();
        const at = now();
        const { text: rawText, source } = req.body ?? {};
        if (typeof rawText !== "string" || !rawText.trim()) return res.status(400).json({ error: "text is required" });
        const text = rawText.trim();
        // Characters as Postgres counts them (code points), not UTF-16 units.
        if ([...text].length > MAX_ASK_CHARS) return res.status(400).json({ error: `text is over ${MAX_ASK_CHARS} characters` });
        if (!ASK_SOURCES.includes(source)) return res.status(400).json({ error: "source must be 'voice' or 'typed'" });
        const accountId: string = req.adminUser.id;

        const normalised = normaliseAsk(text);
        let reply: AskReply = NOT_UNDERSTOOD;
        let intent: string | null = null;
        let error: string | null = null;

        const hit = matchCommand(commands, normalised);
        if (hit) {
            intent = hit.command.intent;
            let built: Promise<Overview> | null = null;
            try {
                const r = await hit.command.handler({
                    now: at, db, accountId, text, normalised, match: hit.match,
                    overview: () => (built ??= overview(at)),
                });
                if (r.kind === "navigate" && !isAllowedPage(r.url)) throw new Error(`navigation outside the allowlist: ${String(r.url).slice(0, 80)}`);
                reply = { ...r, tier: r.kind === "confirm_run" ? 3 : 1 };
            } catch (err) {
                console.error(`[os] ask command ${intent} failed:`, (err as any)?.message ?? err);
                error = describeError(err);
                reply = FAILED;
            }
        }
        // No match: tier 2 (#154) goes here, through `model`. Until then, not understood.

        await logAsk(db, {
            accountId, askedAt: at, text, source, tier: reply.tier, kind: reply.kind, intent, error,
            latencyMs: Math.round(performance.now() - started),
        });
        res.set("Cache-Control", "no-store").json(reply);
    });

    return router;
}

interface AskLogRow {
    accountId: string;
    askedAt: Date;
    text: string;
    source: AskSource;
    tier: AskReply["tier"];
    kind: AskReply["kind"];
    intent: string | null;
    error: string | null;
    latencyMs: number;
}

/**
 * One os_asks row per ask. Best effort for tiers 1 and 2: a failed write
 * (say, the migration isn't applied yet) is logged and the admin still gets
 * the answer. A tier-3 proposal (#148) IS its row, so #148 must insert it
 * before replying and fail the ask if it can't.
 */
async function logAsk(db: Queryable, row: AskLogRow): Promise<void> {
    try {
        await db.query(
            `INSERT INTO os_asks (account_id, asked_at, text, source, tier, kind, intent, error, latency_ms)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [row.accountId, row.askedAt, row.text, row.source, row.tier, row.kind, row.intent, row.error, row.latencyMs]);
    } catch (err: any) {
        console.error("[os] could not log an ask:", err?.message ?? err);
    }
}

export default createOsRouter();
