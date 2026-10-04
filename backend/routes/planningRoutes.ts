import express from "express";
import { auth } from "../middleware/auth.js";
import { createPlanner, PlanningError, type Planner } from "../planning/planner.js";
import { PollError } from "../planning/poll.js";

/**
 * Session planning (#57). Thin wrappers over planning/planner.ts:
 *
 *   GET  /api/planning/campaigns/:campaignId          the Notice Board: { canPlan, gmTitle, planning: [state] }
 *   POST /api/planning/campaigns/:campaignId/kickoff  { title, isOnline, agenda?, foodMode?, foodOwnerId? }
 *                                                     in person, required: foodMode "potluck" | "provided" (with a foodOwnerId)
 *   GET  /api/planning/sessions/:sessionId            planning state
 *   POST /api/planning/sessions/:sessionId/shortlist    night: { options: [{ start, end }] } 2-4 times;
 *                                                       venue: { venueIds: [...] } 1-6 of the campaign's venues
 *   POST /api/planning/sessions/:sessionId/reshortlist  same; replaces an open round
 *   POST /api/planning/sessions/:sessionId/vote         { optionIds: [...] }  night: every time I can make; venue: exactly one
 *   POST /api/planning/sessions/:sessionId/suggest-venue  party: { venueId } or { name, address?, kind?, hostId? }
 *   POST /api/planning/sessions/:sessionId/advance      GM: close the vote now
 *   POST /api/planning/sessions/:sessionId/tiebreak     GM: { optionId }
 *   POST /api/planning/sessions/:sessionId/confirm-food GM: the food step is done; the session is scheduled
 *                                                       (unclaimed slots don't block; it also closes by itself at the start)
 *   POST /api/planning/sessions/:sessionId/food/seed    GM, potluck: { titles: ["Main", "Snacks", ...] } 1-10 unclaimed slots
 *   POST /api/planning/sessions/:sessionId/food/add     party, potluck: { title } a slot of my own, claimed by me
 *   POST /api/planning/sessions/:sessionId/food/:questId/claim    party, potluck: claim an open slot
 *   POST /api/planning/sessions/:sessionId/food/:questId/unclaim  its claimer: back out; the slot is open again
 *   POST /api/planning/sessions/:sessionId/reopen       GM: change a scheduled session's night; { options } opens a new round
 *   POST /api/planning/sessions/:sessionId/cancel       GM
 *
 * Built from a planner so tests can hand it one with fake integrations.
 */
export function buildPlanningRouter(planner: Planner) {
    const router = express.Router();

    const handle = (what: string, fn: (req: any) => Promise<unknown>) => async (req: any, res: express.Response) => {
        try {
            res.json(await fn(req));
        } catch (err: any) {
            if (err instanceof PlanningError || err instanceof PollError) {
                return res.status(err.status).json({ error: err.message });
            }
            console.error(`[planning] ${what} failed:`, err);
            res.status(500).json({ error: `Failed to ${what}` });
        }
    };

    router.get("/campaigns/:campaignId", auth, handle("load the Notice Board",
        (req) => planner.board(req.user, req.params.campaignId)));
    router.post("/campaigns/:campaignId/kickoff", auth, handle("start planning",
        (req) => planner.kickoff(req.user, req.params.campaignId, req.body)));

    router.get("/sessions/:sessionId", auth, handle("load planning",
        (req) => planner.state(req.user, req.params.sessionId)));
    router.post("/sessions/:sessionId/shortlist", auth, handle("shortlist",
        (req) => planner.shortlist(req.user, req.params.sessionId, req.body, { replace: false })));
    router.post("/sessions/:sessionId/reshortlist", auth, handle("re-shortlist",
        (req) => planner.shortlist(req.user, req.params.sessionId, req.body, { replace: true })));
    router.post("/sessions/:sessionId/vote", auth, handle("vote",
        (req) => planner.vote(req.user, req.params.sessionId, req.body)));
    router.post("/sessions/:sessionId/suggest-venue", auth, handle("suggest a venue",
        (req) => planner.suggestVenue(req.user, req.params.sessionId, req.body)));
    router.post("/sessions/:sessionId/confirm-food", auth, handle("confirm the food",
        (req) => planner.confirmFood(req.user, req.params.sessionId)));
    router.post("/sessions/:sessionId/food/seed", auth, handle("seed the potluck",
        (req) => planner.seedFood(req.user, req.params.sessionId, req.body)));
    router.post("/sessions/:sessionId/food/add", auth, handle("add a food slot",
        (req) => planner.addFood(req.user, req.params.sessionId, req.body)));
    router.post("/sessions/:sessionId/food/:questId/claim", auth, handle("claim the slot",
        (req) => planner.claimFood(req.user, req.params.sessionId, req.params.questId)));
    router.post("/sessions/:sessionId/food/:questId/unclaim", auth, handle("un-claim the slot",
        (req) => planner.unclaimFood(req.user, req.params.sessionId, req.params.questId)));
    router.post("/sessions/:sessionId/advance", auth, handle("move forward",
        (req) => planner.advance(req.user, req.params.sessionId)));
    router.post("/sessions/:sessionId/tiebreak", auth, handle("break the tie",
        (req) => planner.tiebreak(req.user, req.params.sessionId, req.body)));
    router.post("/sessions/:sessionId/reopen", auth, handle("change the night",
        (req) => planner.reopen(req.user, req.params.sessionId, req.body)));
    router.post("/sessions/:sessionId/cancel", auth, handle("cancel planning",
        (req) => planner.cancel(req.user, req.params.sessionId)));

    return router;
}

export default buildPlanningRouter(createPlanner());
