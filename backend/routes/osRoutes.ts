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
import { logAsk } from "../os/askLog.js";
import { confirmProposal, createProposal, type Enqueue } from "../os/proposals.js";
import { enqueueRun, isSkill, type SkillId } from "../services/agentRuns.js";

/**
 * /admin/os — the agentic OS home screen (spec #135, W2) and its ask router (W3).
 *
 *   GET  /admin/os                the overview page (HTML), with the ask box
 *   GET  /admin/os/api/overview   the same overview as JSON: { generatedAt, tiles: { [id]: Tile } }
 *   POST /admin/os/ask            { text, source: 'voice' | 'typed' } -> AskReply (os/ask.ts)
 *   POST /admin/os/ask/confirm    { id } -> { run, created, say }: queues a tier-3 proposal's run
 *                                 (os/proposals.ts); 404 unknown or another account's, 409
 *                                 already confirmed, 410 expired
 *
 * Mounted inside adminRoutes after verifyToken + requireAdmin, so every route
 * here is admin-only. Built from a factory so tests inject the clock, the tile
 * list, the command table, the model client and the run queue.
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
    /** Queues a confirmed proposal's run: the RUN button's enqueue, duplicate check included. */
    enqueue?: Enqueue;
}

const NOT_UNDERSTOOD: AskReply = {
    tier: 1, kind: "not_understood",
    say: "Sorry, I didn't understand that.",
    display: "Try “open alpaca”, “show the briefs” or “run the brief”.",
};
const FAILED: AskReply = { tier: 1, kind: "unavailable", say: "Sorry, something went wrong answering that." };
const NOT_PROPOSED: AskReply = { tier: 1, kind: "unavailable", say: "Sorry, I couldn't set up that run. Nothing was queued." };

export function createOsRouter({
    now = () => new Date(), tiles = TILES, db = pool, commands = COMMANDS, model = null, enqueue = enqueueRun,
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
        /** A skill to propose (tier 3): the reply becomes a proposal once its row is written. */
        let propose: SkillId | null = null;

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
                if (r.kind === "confirm_run") {
                    if (!isSkill(r.skill)) throw new Error(`proposal of a skill that isn't runnable: ${String(r.skill).slice(0, 80)}`);
                    propose = r.skill;
                }
                const { skill: _skill, ...shown } = r;
                reply = { ...shown, tier: 1 };
            } catch (err) {
                console.error(`[os] ask command ${intent} failed:`, (err as any)?.message ?? err);
                error = describeError(err);
                reply = FAILED;
            }
        }
        // No match: tier 2 (#154) goes here, through `model`. Until then, not understood.

        const entry = { accountId, askedAt: at, text, source: source as AskSource, intent, error };
        if (propose) {
            // The row IS the proposal: without it there's nothing to confirm, so the ask fails.
            try {
                reply = await createProposal(db, { ...entry, latencyMs: Math.round(performance.now() - started) }, propose);
                return res.set("Cache-Control", "no-store").json(reply);
            } catch (err) {
                console.error(`[os] could not record a proposal of ${propose}:`, (err as any)?.message ?? err);
                entry.error = describeError(err);
                reply = NOT_PROPOSED;
            }
        }
        await logAsk(db, { ...entry, tier: reply.tier, kind: reply.kind, latencyMs: Math.round(performance.now() - started) });
        res.set("Cache-Control", "no-store").json(reply);
    });

    router.post("/ask/confirm", async (req: any, res) => {
        res.set("Cache-Control", "no-store");
        const id = req.body?.id;
        if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: "id must be a proposal id" });
        try {
            const outcome = await confirmProposal(db, { id, accountId: req.adminUser.id, now: now(), enqueue });
            switch (outcome.status) {
                case "confirmed":
                    return res.status(outcome.created ? 201 : 200)
                        .json({ run: outcome.run, created: outcome.created, say: outcome.say });
                case "not_found": return res.status(404).json({ error: "no such proposal" });
                case "already_confirmed": return res.status(409).json({ error: "that proposal was already confirmed" });
                case "expired": return res.status(410).json({ error: "that proposal has expired" });
                case "not_runnable": return res.status(410).json({ error: "that skill is no longer runnable" });
            }
        } catch (err: any) {
            console.error(`[os] confirming proposal ${id} failed:`, err?.message ?? err);
            res.status(500).json({ error: "could not queue the run" });
        }
    });

    return router;
}

export default createOsRouter();
