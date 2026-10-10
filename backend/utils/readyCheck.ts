import Session from "../models/Session.js";
import Campaign from "../models/Campaign.js";
import { notify } from "../utils/notify.js";
import { postTableTalk } from "./tableTalk.js";
import { findCampaignPeopleIds } from "./personUtils.js";

const CHECK_EVERY_MS = 60 * 1000;          // scan once a minute
const READY_WINDOW_MS = 30 * 60 * 1000;    // fire 30 minutes before start

/**
 * Ready-up loop: once a minute, find sessions starting within the next
 * 30 minutes that haven't had their ready check sent, then:
 *  1. bell-notify every campaign member with a link to the session page,
 *  2. post an automated ready-check message into the campaign's Table Talk,
 *  3. stamp readyCheck.sentAt so the session page shows the Ready Up panel.
 */
export function startReadyCheckLoop() {
    setInterval(() => runReadyCheckSweep().catch(err =>
        console.error("[ready-check] sweep failed:", err.message)
    ), CHECK_EVERY_MS);
    console.log("[BACKEND] Ready-check loop scheduled (every 60s, T-30min window).");
}

/**
 * Sessions due a ready check at `now`: starting within the next 30 minutes,
 * not yet sent, and happening -- scheduled (#57), or in the food step (#93).
 * A session still on its night or venue isn't settled, and a cancelled one
 * isn't happening. The food step closes by itself only at the session's
 * start, so without the second arm a session whose food was still open at
 * T-30 would miss its ready check; by the food step its night and venue are
 * settled, so it gets one like any scheduled session.
 */
export function readyCheckDueFilter(now: Date) {
    return {
        $or: [{ status: "scheduled" }, { status: "planning", planningStage: "food" }],
        date: { $gt: now, $lte: new Date(now.getTime() + READY_WINDOW_MS) },
        "readyCheck.sentAt": { $exists: false },
    };
}

export async function runReadyCheckSweep() {
    const due = await Session.find(readyCheckDueFilter(new Date())).populate("campaign", "title");

    for (const session of due) {
        try {
            await sendReadyCheck(session);
        } catch (err: any) {
            console.error(`[ready-check] failed for session ${session._id}:`, err.message);
        }
    }
}

async function sendReadyCheck(session: any) {
    const campaign = session.campaign;
    const campaignId = String(campaign?._id ?? session.campaign);
    const title = campaign?.title ?? "your campaign";
    const sessionLink = `/game-night/sessions/${session._id}`;
    const startTime = new Date(session.date).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

    // Stamp first — better to occasionally miss a notification than to spam
    // every member each minute if a later step throws.
    session.readyCheck = { sentAt: new Date(), responses: session.readyCheck?.responses ?? [] };
    await session.save();

    // 1. Bell notifications for every member with an account.
    const peopleIds = await findCampaignPeopleIds(campaignId);
    await Promise.all(peopleIds.map(id => notify(id, {
        type: "system",
        title: `Ready check: "${session.title}" starts at ${startTime}`,
        body: `${title} — ready up for tonight's session!`,
        link: sessionLink,
        sourceKey: `ready:${session._id}`,
        meta: { sessionId: String(session._id), campaignId },
    })));

    // 2. Automated Table Talk message so the party sees it in chat too.
    const body = `**READY CHECK!** "${session.title}" starts at ${startTime}. Head to the [session page](${sessionLink}) and ready up!`;
    await postTableTalk(campaignId, body);

    console.log(`[ready-check] sent for session "${session.title}" (${session._id}) — ${peopleIds.length} member(s) notified.`);
}
