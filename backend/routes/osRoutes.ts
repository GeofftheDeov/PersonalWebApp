import express from "express";
import pool from "../db/index.js";
import { buildOverview, type Queryable, type TileSource } from "../os/overview.js";
import { renderOverviewPage } from "../os/page.js";
import { TILES } from "../os/tiles/index.js";

/**
 * /admin/os — the agentic OS home screen (spec #135, W2).
 *
 *   GET /admin/os                the overview page (HTML)
 *   GET /admin/os/api/overview   the same overview as JSON: { generatedAt, tiles: { [id]: Tile } }
 *
 * Mounted inside adminRoutes after verifyToken + requireAdmin, so every route
 * here is admin-only. Built from a factory so tests inject the clock (and the
 * tile list); the model client for the ask endpoint (#146) joins these deps.
 */
export interface OsRouterDeps {
    /** The clock every tile reads. */
    now?: () => Date;
    /** The tiles, in page order. */
    tiles?: readonly TileSource<any>[];
    db?: Queryable;
}

export function createOsRouter({ now = () => new Date(), tiles = TILES, db = pool }: OsRouterDeps = {}) {
    const router = express.Router();

    const overview = (at: Date) => buildOverview(tiles, { now: at, db });

    router.get("/", async (req, res) => {
        const at = now();
        try {
            const token = String(req.query.token ?? "");
            res.send(renderOverviewPage({ token, now: at, overview: await overview(at), sources: tiles }));
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

    return router;
}

export default createOsRouter();
