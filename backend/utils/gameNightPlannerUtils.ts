import CampaignMember from "../models/CampaignMember.js";
import User from "../models/User.js";

/**
 * Gets the list of campaign IDs that the user is authorized to view.
 * If the user is an admin, it returns null (meaning all campaigns).
 * @param user The user object from req.user
 * @returns Array of campaign IDs or null
 */
export async function getAuthorizedCampaignIds(user: any) {
    // 1. Check if user is admin
    if (user.type === "User") {
        const dbUser = await User.findById(user.id);
        if (dbUser?.role === "admin") return null; // Admin sees all
    }

    // 2. Find campaigns where user is a member
    const membershipQuery: any = {
        $or: [
            { email: user.email },
            { lead: user.id },
            { contact: user.id },
            { account: user.id }
        ]
    };

    const memberships = await CampaignMember.find(membershipQuery).select("campaign");
    return memberships.map(m => m.campaign);
}
