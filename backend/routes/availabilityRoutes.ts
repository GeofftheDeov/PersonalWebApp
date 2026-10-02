import express from "express";
import { auth } from "../middleware/auth.js";
import { isUuid } from "../db/model.js";
import { isCampaignGameMaster } from "../utils/gameNightPlannerUtils.js";
import {
    AvailabilityError, addException, campaignOverlap, cleanRange, getWindows, listExceptions,
    myPreview, removeException, replaceWindows,
} from "../planning/availabilityStore.js";

/**
 * Regular availability (#57). Thin wrappers over planning/availabilityStore:
 *
 *   GET    /api/availability/me                    my windows + upcoming exceptions
 *   PUT    /api/availability/me/windows            replace my week   { windows: [...] }
 *   GET    /api/availability/me/exceptions         my upcoming exceptions
 *   POST   /api/availability/me/exceptions         add one           { start, end, kind, note? }
 *   DELETE /api/availability/me/exceptions/:id     remove one
 *   GET    /api/availability/me/preview            what the party sees about me  ?start&end
 *   GET    /api/availability/campaigns/:id         the party overlap (Game Master only)
 *                                                  ?start&end[&slotMinutes=240][&stepMinutes=30]
 */
const router = express.Router();

function fail(res: express.Response, err: any, what: string) {
    if (err instanceof AvailabilityError) return res.status(err.status).json({ error: err.message });
    console.error(`[availability] ${what} failed:`, err.message);
    return res.status(500).json({ error: `Failed to ${what}` });
}

router.get("/me", auth, async (req: any, res) => {
    try {
        const [windows, exceptions] = await Promise.all([
            getWindows(req.user.id), listExceptions(req.user.id, new Date()),
        ]);
        res.json({ windows, exceptions });
    } catch (err: any) {
        fail(res, err, "load availability");
    }
});

router.put("/me/windows", auth, async (req: any, res) => {
    try {
        res.json({ windows: await replaceWindows(req.user.id, req.body?.windows) });
    } catch (err: any) {
        fail(res, err, "save weekly windows");
    }
});

router.get("/me/exceptions", auth, async (req: any, res) => {
    try {
        res.json({ exceptions: await listExceptions(req.user.id, new Date()) });
    } catch (err: any) {
        fail(res, err, "load exceptions");
    }
});

router.post("/me/exceptions", auth, async (req: any, res) => {
    try {
        res.status(201).json({ exception: await addException(req.user.id, req.body, new Date()) });
    } catch (err: any) {
        fail(res, err, "add exception");
    }
});

router.delete("/me/exceptions/:id", auth, async (req: any, res) => {
    try {
        if (!(await removeException(req.user.id, req.params.id))) {
            return res.status(404).json({ error: "Exception not found" });
        }
        res.status(204).end();
    } catch (err: any) {
        fail(res, err, "remove exception");
    }
});

router.get("/me/preview", auth, async (req: any, res) => {
    try {
        res.json(await myPreview(req.user.id, cleanRange(req.query, { slotMinutes: 30, stepMinutes: 30 })));
    } catch (err: any) {
        fail(res, err, "preview availability");
    }
});

router.get("/campaigns/:campaignId", auth, async (req: any, res) => {
    try {
        const { campaignId } = req.params;
        if (!isUuid(campaignId)) return res.status(404).json({ error: "Campaign not found" });
        // The grid shows every player's free / busy / unknown, so it is the
        // Game Master's planning tool rather than something the party browses.
        if (!(await isCampaignGameMaster(req.user, campaignId))) {
            return res.status(403).json({ error: "Only the Game Master can see the party's availability" });
        }
        res.json(await campaignOverlap(campaignId, cleanRange(req.query, { slotMinutes: 240, stepMinutes: 30 })));
    } catch (err: any) {
        fail(res, err, "compute the overlap");
    }
});

export default router;
