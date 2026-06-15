import Session from "../models/Session.js";
import Campaign from "../models/Campaign.js";
import CampaignMember from "../models/CampaignMember.js";
import Message from "../models/Message.js";
import { bus } from "../events/index.js";
import { notify } from "../utils/notify.js";
import { findPeopleByEmail } from "./personUtils.js";

const CHECK_EVERY_MS = 60 * 1000;          // scan once a minute
const READY_WINDOW_MS = 30 * 60 * 1000;    // fire 30 minutes before start

/** Synthetic sender for automated Table Talk posts. */
const BOT_SENDER = { id: "system", name: "GAME NIGHT", email: "system@personal-web-app.local" };

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

export async function runReadyCheckSweep() {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + READY_WINDOW_MS);

    const due = await Session.find({
        date: { $gt: now, $lte: windowEnd },
        "readyCheck.sentAt": { $exists: false },
    }).populate("campaign", "title");

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

    // 1. Bell notifications for every member, whatever collection they live in.
    const members = await CampaignMember.find({ campaign: campaignId }).select("email");
    const emails = [...new Set(members.map(m => m.email).filter((e): e is string => Boolean(e)))];
    const people = await findPeopleByEmail(emails);
    await Promise.all(people.map(p => notify(p.doc._id, {
        type: "system",
        title: `Ready check: "${session.title}" starts at ${startTime}`,
        body: `${title} — ready up for tonight's session!`,
        link: sessionLink,
        sourceKey: `ready:${session._id}`,
        meta: { sessionId: String(session._id), campaignId },
    })));

    // 2. Automated Table Talk message so the party sees it in chat too.
    const body = `**READY CHECK!** "${session.title}" starts at ${startTime}. Head to the [session page](${sessionLink}) and ready up!`;
    const message = await Message.create({
        campaign: campaignId,
        sender: BOT_SENDER,
        body,
    });
    await bus.publish("gamenight.message", {
        messageId: String(message._id),
        campaignId,
        sender: BOT_SENDER,
        body: message.body,
        createdAt: message.createdAt.toISOString(),
    });

    console.log(`[ready-check] sent for session "${session.title}" (${session._id}) — ${people.length} member(s) notified.`);
}
