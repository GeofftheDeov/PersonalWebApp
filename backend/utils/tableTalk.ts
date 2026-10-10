import Message from "../models/Message.js";
import { bus } from "../events/index.js";

/** Synthetic sender for automated Table Talk posts. */
export const SYSTEM_SENDER = { id: "system", name: "GAME NIGHT", email: "system@personal-web-app.local" };

/**
 * Post an automated message into a campaign's Table Talk and announce it on
 * the bus, which is what puts it on screen for anyone watching the chat.
 * Never throws: like notify(), it is a side effect that must not fail the
 * action that triggered it.
 */
export async function postTableTalk(campaignId: string, body: string) {
    try {
        const message = await Message.create({ campaign: campaignId, sender: SYSTEM_SENDER, body });
        await bus.publish("gamenight.message", {
            messageId: String(message._id),
            campaignId,
            sender: SYSTEM_SENDER,
            body: message.body,
            createdAt: message.createdAt.toISOString(),
        });
        return message;
    } catch (err: any) {
        console.error("[table-talk] post failed:", err.message);
        return null;
    }
}
