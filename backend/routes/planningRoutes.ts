import express from "express";
import { auth } from "../middleware/auth.js";
import { createPlanner, PlanningError, type Planner } from "../planning/planner.js";
import { PollError } from "../planning/poll.js";

/**
 * Session planning (#57). Thin wrappers over planning/planner.ts:
 *
 *   GET  /api/planning/campaigns/:campaignId          the Notice Board: { canPlan, gmTitle, planning: [state] }
 *   POST /api/planning/campaigns/:campaignId/kickoff  { title, isOnline, agenda? }
 *   GET  /api/planning/sessions/:sessionId            planning state
 *   POST /api/planning/sessions/:sessionId/shortlist    { options: [{ start, end }] }   2-4 times
 *   POST /api/planning/sessions/:sessionId/reshortlist  same; replaces an open round
 *   POST /api/planning/sessions/:sessionId/vote         { optionIds: [...] }  every time I can make
 *   POST /api/planning/sessions/:sessionId/advance      GM: close the vote now
 *   POST /api/planning/sessions/:sessionId/tiebreak     GM: { optionId }
 *   POST /api/planning/sessions/:sessionId/reopen       GM: change a scheduled session's night; { options } opens a new round
 *   POST /api/planning/sessions/:sessionId/cancel       GM
 *   POST   /api/planning/sessions/:sessionId/torch      campaign GM: { to }  one-session torch pass (#89)
 *   DELETE /api/planning/sessions/:sessionId/torch      campaign GM or the stand-in: take it back
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
    router.post("/sessions/:sessionId/advance", auth, handle("move forward",
        (req) => planner.advance(req.user, req.params.sessionId)));
    router.post("/sessions/:sessionId/tiebreak", auth, handle("break the tie",
        (req) => planner.tiebreak(req.user, req.params.sessionId, req.body)));
    router.post("/sessions/:sessionId/reopen", auth, handle("change the night",
        (req) => planner.reopen(req.user, req.params.sessionId, req.body)));
    router.post("/sessions/:sessionId/cancel", auth, handle("cancel planning",
        (req) => planner.cancel(req.user, req.params.sessionId)));

    router.post("/sessions/:sessionId/torch", auth, handle("pass the torch",
        (req) => planner.passSession(req.user, req.params.sessionId, req.body)));
    router.delete("/sessions/:sessionId/torch", auth, handle("take the torch back",
        (req) => planner.clearSessionPass(req.user, req.params.sessionId)));

    return router;
}

export default buildPlanningRouter(createPlanner());
