/**
 * Leaving a campaign, and a Game Master removing someone from one.
 *
 * Both are one removal: a player removes themselves, a Game Master (or an
 * admin) removes someone else. The rules that keep a campaign runnable:
 *
 *   - A Game Master removes Players. Removing another Game Master is an admin's
 *     call, since there's no other way to take the role off someone.
 *   - The last Game Master can't go while anyone else is in the party: they
 *     pass the torch first, so the party isn't left with nobody to plan.
 *
 * A person can hold more than one member row in a campaign (campaignParty
 * dedupes them), so removing a person removes every row of theirs there. A
 * row with no person (pre-Phase-3) is removed on its own.
 *
 * Ownership doesn't move: an owner who leaves still owns the campaign's
 * settings, as after a torch pass.
 */
import { withTransaction } from "../db/index.js";
import { isUuid } from "../db/model.js";
import { notify } from "../utils/notify.js";
import { postTableTalk } from "../utils/tableTalk.js";
import { personDisplayName } from "../utils/personUtils.js";
import { publishMembershipChanged } from "./accessEvents.js";

export class MembershipError extends Error {
    constructor(public status: number, message: string) { super(message); }
}

export interface MemberRemoved {
    campaignId: string;
    personId: string | null;
    /** True when they removed themselves. */
    left: boolean;
}

export async function removeCampaignMember(actorId: string, memberId: string): Promise<MemberRemoved> {
    if (!isUuid(memberId)) throw new MembershipError(404, "Campaign member not found");

    const result = await withTransaction(async (db) => {
        const { rows: [target] } = await db.query(
            `SELECT id, campaign_id, person_id, status, first_name, last_name FROM campaign_members WHERE id = $1`, [memberId]);
        if (!target) throw new MembershipError(404, "Campaign member not found");
        const campaignId: string = target.campaign_id;

        // Lock the campaign's memberships so two GMs leaving at once can't both
        // be "not the last one", and a removal can't interleave with a torch pass.
        const { rows: [c] } = await db.query(`SELECT id, title, gm_title FROM campaigns WHERE id = $1`, [campaignId]);
        const { rows: members } = await db.query(
            `SELECT id, person_id, status FROM campaign_members WHERE campaign_id = $1 FOR UPDATE`, [campaignId]);
        const { rows: [acct] } = await db.query(`SELECT app_role FROM accounts WHERE id = $1`, [actorId]);
        const isAdmin = acct?.app_role === "admin";
        const gmTitle: string = c.gm_title;

        const personId: string | null = target.person_id;
        const isSelf = personId !== null && personId === actorId;
        const isGm = (id: string | null) => id !== null && members.some((m) => m.person_id === id && m.status === "Game Master");
        // The rows going: all of this person's, or just this one if it names nobody.
        const going = (m: any) => (personId ? m.person_id === personId : m.id === target.id);

        if (!isSelf) {
            if (!isGm(actorId) && !isAdmin) throw new MembershipError(403, `Only the ${gmTitle} can remove members`);
            if (isGm(personId) && !isAdmin) throw new MembershipError(403, `Only an admin can remove another ${gmTitle}`);
        }
        const gmsLeft = members.some((m) => !going(m) && m.status === "Game Master");
        const othersLeft = members.some((m) => !going(m));
        if (isGm(personId) && !gmsLeft && othersLeft) {
            throw new MembershipError(409, isSelf
                ? `You're the only ${gmTitle}: pass the torch before you leave.`
                : `They're the only ${gmTitle}: pass the torch to someone else first.`);
        }

        const name = personId
            ? personDisplayName((await db.query(
                `SELECT handle, name, first_name AS "firstName", last_name AS "lastName", email FROM accounts WHERE id = $1`,
                [personId])).rows[0])
            : personDisplayName({ firstName: target.first_name, lastName: target.last_name });

        if (personId) {
            await db.query(`DELETE FROM campaign_members WHERE campaign_id = $1 AND person_id = $2`, [campaignId, personId]);
            // A one-session stand-in loses it with their seat (isSessionGameMaster
            // already ignores it), so no session still names them its GM.
            await db.query(
                `UPDATE game_sessions SET gm_override_id = NULL
                  WHERE campaign_id = $1 AND gm_override_id = $2 AND status IN ('planning', 'scheduled')`,
                [campaignId, personId]);
        } else {
            await db.query(`DELETE FROM campaign_members WHERE id = $1`, [target.id]);
        }
        return { campaign: c, campaignId, personId, isSelf, name };
    });

    const { campaign: c, campaignId, personId, isSelf, name } = result;
    // After the commit, never inside it: a failing side effect can't undo the removal.
    if (personId) await publishMembershipChanged(campaignId, "member-removed", personId);
    try {
        if (!isSelf && personId) {
            await notify(personId, {
                type: "system", title: `You were removed from ${c.title}`,
                body: "You're no longer in the party.", meta: { campaignId },
            });
        }
        await postTableTalk(campaignId, isSelf ? `**${name} left the party.**` : `**${name} was removed from the party.**`);
    } catch (err: any) {
        console.error("[membership] side effect failed:", err.message);
    }
    return { campaignId, personId, left: isSelf };
}
