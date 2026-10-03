/**
 * Passing the torch permanently (#57, #89): another party member becomes the
 * campaign's Game Master and the one passing it becomes a Player. Their
 * "Game Master" membership statuses swap; ownership doesn't move, so the
 * owner keeps the campaign's settings.
 *
 * The one-session pass (a session's GM override) lives with the planner,
 * which owns per-session Game Master control.
 *
 * Only a Game Master of the campaign, or an admin, can pass it. A GM steps
 * down themselves. An admin who isn't one names the GM stepping down with
 * `from`, which may be left out when the campaign has exactly one GM (or
 * none, in which case nobody steps down).
 */
import { withTransaction } from "../db/index.js";
import { isUuid } from "../db/model.js";
import { bus } from "../events/index.js";
import { notify } from "../utils/notify.js";
import { postTableTalk } from "../utils/tableTalk.js";
import { campaignParty } from "./availabilityStore.js";

export class TorchError extends Error {
    constructor(public status: number, message: string) { super(message); }
}

export interface TorchPassed {
    campaignId: string;
    gameMasterIds: string[];
    owner: string | null;
}

export async function passTorchPermanently(actorId: string, campaignId: string, body: any): Promise<TorchPassed> {
    if (!isUuid(campaignId)) throw new TorchError(404, "Campaign not found.");

    const result = await withTransaction(async (db) => {
        // Lock the campaign's memberships so two passes can't interleave.
        const { rows: [c] } = await db.query(`SELECT id, title, gm_title, owner_id FROM campaigns WHERE id = $1`, [campaignId]);
        if (!c) throw new TorchError(404, "Campaign not found.");
        const { rows: members } = await db.query(
            `SELECT id, person_id, status FROM campaign_members
              WHERE campaign_id = $1 AND person_id IS NOT NULL
              ORDER BY joined_at NULLS LAST, created_at FOR UPDATE`, [campaignId]);
        const { rows: [acct] } = await db.query(`SELECT app_role FROM accounts WHERE id = $1`, [actorId]);
        const isGm = (id: string) => members.some((m) => m.person_id === id && m.status === "Game Master");
        const gms = [...new Set(members.filter((m) => m.status === "Game Master").map((m) => m.person_id as string))];

        if (!isGm(actorId) && acct?.app_role !== "admin") {
            throw new TorchError(403, `Only the ${c.gm_title} can pass the torch.`);
        }
        const to = body?.to;
        if (typeof to !== "string" || !members.some((m) => m.person_id === to)) {
            throw new TorchError(400, "Pass the torch to someone in the party.");
        }
        if (isGm(to)) throw new TorchError(400, `They're already the ${c.gm_title}.`);

        let from: string | null;
        if (isGm(actorId)) from = actorId;
        else if (body?.from !== undefined && body?.from !== null) {
            if (typeof body.from !== "string" || !isGm(body.from)) {
                throw new TorchError(400, `"from" must be the campaign's ${c.gm_title}.`);
            }
            from = body.from;
        } else if (gms.length <= 1) from = gms[0] ?? null;
        else throw new TorchError(400, `This campaign has more than one ${c.gm_title}: say who steps down with "from".`);

        await db.query(`UPDATE campaign_members SET status = 'Game Master' WHERE campaign_id = $1 AND person_id = $2`, [campaignId, to]);
        if (from) {
            await db.query(`UPDATE campaign_members SET status = 'Player' WHERE campaign_id = $1 AND person_id = $2`, [campaignId, from]);
        }
        const gameMasterIds = [...gms.filter((id) => id !== from), to];
        return { campaign: c, from, to: to as string, gameMasterIds };
    });

    const { campaign: c, from, to } = result;
    // After the commit, never inside it: a failing side effect can't undo the pass.
    await bus.publish("campaign.torch_passed", {
        campaignId, scope: "campaign", sessionId: null, byId: actorId, fromId: from, toId: to,
    }).catch(() => { /* bus down is non-fatal */ });
    try {
        const party = await campaignParty(campaignId);
        const name = (id: string | null) => party.find((p) => p.id === id)?.name ?? "someone";
        await notify(to, {
            type: "system", title: `You're the ${c.gm_title} of ${c.title} now`,
            body: from ? `${name(from)} passed you the torch.` : "The torch has been passed to you.",
            link: `/game-night/campaigns/${campaignId}`, meta: { campaignId },
        });
        await postTableTalk(campaignId, `**The torch has passed.** ${name(to)} is the ${c.gm_title} now` +
            (from ? `, taking over from ${name(from)}.` : "."));
    } catch (err: any) {
        console.error("[torch] side effect failed:", err.message);
    }
    return { campaignId, gameMasterIds: result.gameMasterIds, owner: c.owner_id };
}
