import express from "express";
import { auth } from "../middleware/auth.js";
import { createQuests, QuestError, type Quests } from "../planning/quests.js";
import { subscribeQuestSchedule } from "../planning/questReminders.js";

/**
 * Quests (#90, part of #57). Thin wrappers over planning/quests.ts:
 *
 *   GET   /api/quests/mine                 my quests across sessions   ?scope=upcoming (default; the Quest Log) | all
 *   GET   /api/quests/almanac              my dated sessions in range, each with my quests on it   ?start&end
 *   GET   /api/quests/sessions/:sessionId  a session's quests, the party, and whether I'm its GM
 *   POST  /api/quests/sessions/:sessionId  GM: add a custom quest   { title, assigneeId, notes?, dueAt? }
 *   PATCH /api/quests/:questId             GM: edit or reassign     { title?, notes?, dueAt?, assigneeId? }
 *   POST  /api/quests/:questId/done        its owner or the GM: mark it done
 *   PUT   /api/quests/:questId/reminders   its owner: when to be reminded (#91)   { offsets: minutes before due[] }
 *
 * Built from a quests instance so tests can hand it one with an injected clock.
 */
export function buildQuestRouter(quests: Quests) {
    const router = express.Router();

    const handle = (what: string, fn: (req: any) => Promise<unknown>, status = 200) =>
        async (req: any, res: express.Response) => {
            try {
                res.status(status).json(await fn(req));
            } catch (err: any) {
                if (err instanceof QuestError) return res.status(err.status).json({ error: err.message });
                console.error(`[quests] ${what} failed:`, err);
                res.status(500).json({ error: `Failed to ${what}` });
            }
        };

    router.get("/mine", auth, handle("load your quests",
        (req) => quests.mine(req.user, req.query.scope ?? "upcoming")));
    router.get("/almanac", auth, handle("load the Almanac",
        (req) => quests.almanac(req.user, req.query)));
    router.get("/sessions/:sessionId", auth, handle("load the session's quests",
        (req) => quests.ofSession(req.user, req.params.sessionId)));
    router.post("/sessions/:sessionId", auth, handle("add the quest",
        (req) => quests.create(req.user, req.params.sessionId, req.body), 201));
    router.patch("/:questId", auth, handle("update the quest",
        (req) => quests.update(req.user, req.params.questId, req.body)));
    router.post("/:questId/done", auth, handle("mark the quest done",
        (req) => quests.complete(req.user, req.params.questId)));
    router.put("/:questId/reminders", auth, handle("save the reminders",
        (req) => quests.setReminders(req.user, req.params.questId, req.body)));

    return router;
}

// Due times follow the night (#91). Registered at import, before server.ts starts the bus.
subscribeQuestSchedule();

export default buildQuestRouter(createQuests());
