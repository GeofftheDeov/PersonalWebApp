import CampaignMember from "../models/CampaignMember.js";
import Account from "../models/Account.js";

/**
 * Campaign authorization (#35, plan §3.4).
 *
 * Both functions used to open with `if (user.type === "User")` before looking
 * up a role — the type standing in for "staff". After the merge everyone is an
 * account, so that check would have been false for every person alive and
 * silently removed admin bypass from the only admin. The replacement is the
 * column that actually means it: `accounts.app_role`.
 *
 * `app_role` is authorization and `account_tier` is entitlement (#28). A tier
 * change must never move somebody's access, so nothing here may read the tier.
 */

/** True when this person is an app admin. One indexed lookup. */
async function isAdmin(user: any): Promise<boolean> {
    if (!user?.id) return false;
    const doc = await Account.findById(user.id).select("appRole");
    return doc?.appRole === "admin";
}

/**
 * Campaign ids this person may view, or null for "all" (admins).
 * @param user The user object from req.user
 */
export async function getAuthorizedCampaignIds(user: any) {
    if (await isAdmin(user)) return null;

    // Membership was a four-way OR across { email, lead, contact, account },
    // including an unindexed email match. One person column, one indexed lookup.
    const memberships = await CampaignMember.find({ person: user.id }).select("campaign");
    return memberships.map((m: any) => m.campaign);
}

/**
 * True when the user is the Game Master of the campaign (or an admin).
 * Session creation/editing is GM-only.
 */
export async function isCampaignGameMaster(user: any, campaignId: string): Promise<boolean> {
    if (!campaignId) return false;
    if (await isAdmin(user)) return true;

    const gm = await CampaignMember.findOne({
        campaign: campaignId,
        status: "Game Master",
        person: user.id,
    }).select("_id");

    return Boolean(gm);
}
