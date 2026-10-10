import express from "express";
import { auth } from "../middleware/auth.js";
import { campaignThreadKey, dmThreadKey } from "../services/threads.js";
import {
    sendThreadMessage,
    threadHistory,
    type HistoryResult,
    type MessageRow,
    type SendResult,
} from "../services/threadMessages.js";

/*
 * Campaign chat (Table Talk) and friend DMs by campaign / friend id: thin
 * aliases over the thread-keyed endpoints (#101; routes/threadRoutes.ts,
 * services/threadMessages.ts) until every client has moved to those. They
 * answer as they always have: a bare array of messages in the model's shape
 * for history, the saved message for send, and the same error strings.
 * Live delivery is the live channel's job (backend/live/liveChannel.ts).
 */
const router = express.Router();

type Kind = "campaign" | "dm";

const FORBIDDEN: Record<Kind, string> = {
    campaign: "Not a member of this campaign",
    dm: "You can only message friends",
};

/** A message as these endpoints always returned it: the Message model's document. */
const legacyMessage = (row: MessageRow) => ({
    campaign: row.campaign_id,
    event: row.event_id,
    dmKey: row.dm_key,
    recipient: row.recipient,
    sender: { id: row.sender_id, name: row.sender_name, email: row.sender_email },
    body: row.body,
    createdAt: row.created_at,
    _id: row.id,
    id: row.id,
});

function legacyError(kind: Kind, reason: Exclude<HistoryResult | SendResult, { ok: true }>["reason"]): [number, string] {
    switch (reason) {
        // A malformed id was always just "not yours".
        case "invalid-thread": case "forbidden": return [403, FORBIDDEN[kind]];
        case "empty-body": return [400, "body is required"];
        case "body-too-long": return [400, "body is too long (4000 characters at most)"];
        case "invalid-before": return [400, "before must be a message id in this thread or a timestamp"];
        case "invalid-client-id": return [400, "clientId must be 8-64 letters, digits, '-' or '_'"];
        case "client-id-conflict": return [409, "That clientId was already used for another message"];
    }
}

const threadKeyOf = (kind: Kind, req: any) =>
    kind === "campaign" ? campaignThreadKey(req.params.campaignId) : dmThreadKey(req.user.id, req.params.userId);

/** GET history, newest first. Query: ?limit=50&before=<ISO date or message id> */
const history = (kind: Kind) => async (req: any, res: any) => {
    try {
        const result = await threadHistory(req.user, threadKeyOf(kind, req), req.query);
        if (!result.ok) {
            const [status, error] = legacyError(kind, result.reason);
            return res.status(status).json({ error });
        }
        res.json(result.rows.map(legacyMessage));
    } catch (err: any) {
        console.error(`[messages] ${kind} history error:`, err);
        res.status(500).json({ error: "Failed to fetch messages", details: err.message });
    }
};

/** POST send. Body: { body, eventId? (campaigns), clientId? } */
const send = (kind: Kind) => async (req: any, res: any) => {
    try {
        const { body, eventId, clientId } = req.body ?? {};
        const result = await sendThreadMessage(req.user, threadKeyOf(kind, req), { body, eventId, clientId });
        if (!result.ok) {
            const [status, error] = legacyError(kind, result.reason);
            return res.status(status).json({ error });
        }
        res.status(result.created ? 201 : 200).json(legacyMessage(result.row));
    } catch (err: any) {
        console.error(`[messages] ${kind} send error:`, err);
        res.status(500).json({ error: "Failed to send message", details: err.message });
    }
};

router.get("/campaign/:campaignId", auth, history("campaign"));
router.post("/campaign/:campaignId", auth, send("campaign"));
router.get("/dm/:userId", auth, history("dm"));
router.post("/dm/:userId", auth, send("dm"));

export default router;
