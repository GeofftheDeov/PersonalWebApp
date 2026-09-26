import express from "express";
import { isUuid } from "../db/model.js";
import Campaign from "../models/Campaign.js";
import CampaignInvite from "../models/CampaignInvite.js";
import CampaignMember from "../models/CampaignMember.js";
import { auth } from "../middleware/auth.js";
import { getAuthorizedCampaignIds } from "../utils/gameNightPlannerUtils.js";
import { notify, resolveNotifications } from "../utils/notify.js";
import { findPersonById, personDisplayName, toPublicPerson } from "../utils/personUtils.js";

/**
 * Anyone can be invited to a campaign, whatever person table they live in.
 *
 * This route used to resolve both sides with User.findById, which made the
 * whole flow User-only: a Lead/Contact/Account could not invite anybody (their
 * own lookup came back null, so the friends check failed with "You can only
 * invite friends"), and inviting a non-User friend 404'd with "User not found".
 * That was never the intent — the invite picker offers your friends list, and
 * `friends` is a polymorphic uuid[] on all four tables, so the picker could
 * always offer someone this route then refused. campaign_members has been
 * polymorphic all along (lead_id / contact_id / account_id) and
 * getAuthorizedCampaignIds already matches on any of them.
 *
 * Every person lookup here goes through personUtils, exactly as friendRoutes
 * does. When Phase 3 (#35) cuts the app over, personUtils starts resolving the
 * unified `accounts` table and this route needs no further change.
 */

/** campaign_members has a column per person type; User members match on email. */
function memberIdField(type: string): "lead" | "contact" | "account" | null {
    if (type === "Lead") return "lead";
    if (type === "Contact") return "contact";
    if (type === "Account") return "account";
    return null; // User
}

const router = express.Router();

/* ------------------------------------------------------------------ */
/* POST /api/campaign-invites — invite a friend to a campaign          */
/* Body: { campaignId, toUserId }                                      */
/* ------------------------------------------------------------------ */
router.post("/", auth, async (req: any, res) => {
    try {
        const { campaignId, toUserId } = req.body;
        if (!isUuid(campaignId) || !isUuid(toUserId)) {
            return res.status(400).json({ error: "campaignId and toUserId are required" });
        }

        // Inviter must be a member of (or admin over) the campaign.
        const authorized = await getAuthorizedCampaignIds(req.user);
        if (authorized && !authorized.some((id: any) => String(id) === String(campaignId))) {
            return res.status(403).json({ error: "Not a member of this campaign" });
        }

        const campaign = await Campaign.findById(campaignId);
        if (!campaign) return res.status(404).json({ error: "Campaign not found" });

        // Invites go friend-to-friend (the UI offers your friends list), and a
        // friend may live in any of the four person tables.
        const mePerson = await findPersonById(req.user.id, "name handle friends");
        const me = mePerson?.doc;
        if (!me?.friends?.some((f: any) => String(f) === String(toUserId))) {
            return res.status(400).json({ error: "You can only invite friends" });
        }

        const inviteePerson = await findPersonById(toUserId, "email");
        if (!inviteePerson) return res.status(404).json({ error: "Person not found" });
        const invitee = inviteePerson.doc;

        // Already a member? Match on the invitee's own id column where they have
        // one, and on email either way — a Lead/Contact/Account may have joined
        // by link (email only) or by a previous invite (id set).
        const idField = memberIdField(inviteePerson.type);
        const memberOr: any[] = [];
        if (idField) memberOr.push({ [idField]: toUserId });
        if (invitee.email) memberOr.push({ email: invitee.email });
        if (memberOr.length) {
            const existingMember = await CampaignMember.findOne({ campaign: campaignId, $or: memberOr });
            if (existingMember) return res.status(409).json({ error: "Already a member of this campaign" });
        }

        const existingInvite = await CampaignInvite.findOne({ campaign: campaignId, to: toUserId, status: "pending" });
        if (existingInvite) return res.status(409).json({ error: "Invite already pending" });

        const invite = await CampaignInvite.create({ campaign: campaignId, from: req.user.id, to: toUserId });

        const inviterName = personDisplayName(me) || req.user.email;
        await notify(toUserId, {
            type: "campaign_invite",
            title: `@${inviterName} invited you to "${campaign.title}"`,
            body: campaign.description || undefined,
            sourceKey: `invite:${invite._id}`,
            meta: { inviteId: String(invite._id), campaignId: String(campaignId) },
        });

        res.status(201).json({ message: "Invite sent", invite });
    } catch (err: any) {
        console.error("[invites] create error:", err);
        res.status(500).json({ error: "Failed to send invite", details: err.message });
    }
});

/* ------------------------------------------------------------------ */
/* GET /api/campaign-invites/mine — my pending invites                 */
/* ------------------------------------------------------------------ */
router.get("/mine", auth, async (req: any, res) => {
    try {
        // `campaign` still populates through the model layer, but `from` cannot:
        // populate() resolves one declared model, and an inviter may live in any
        // of the four person tables. Resolve it with personUtils instead, the
        // way friendRoutes does — otherwise a Lead/Contact/Account inviter comes
        // back as null and the bell shows an invite from nobody.
        const invites = await CampaignInvite.find({ to: req.user.id, status: "pending" })
            .populate("campaign", "title description status")
            .sort({ createdAt: -1 });

        const withInviters = await Promise.all(invites.map(async (invite: any) => {
            const out = invite.toObject();
            const person = await findPersonById(
                String(invite.from), "name firstName lastName handle userNumber profilePicture");
            out.from = person ? toPublicPerson(person) : null;
            return out;
        }));
        res.json(withInviters);
    } catch (err: any) {
        console.error("[invites] mine error:", err);
        res.status(500).json({ error: "Failed to fetch invites", details: err.message });
    }
});

/* ------------------------------------------------------------------ */
/* PUT /api/campaign-invites/:id/respond — accept or decline           */
/* Body: { action: "accept" | "decline" }                              */
/* ------------------------------------------------------------------ */
router.put("/:id/respond", auth, async (req: any, res) => {
    try {
        const { action } = req.body as { action?: string };
        if (action !== "accept" && action !== "decline") {
            return res.status(400).json({ error: "action must be 'accept' or 'decline'" });
        }

        const invite = await CampaignInvite.findById(req.params.id).populate("campaign", "title");
        if (!invite || String(invite.to) !== String(req.user.id)) {
            return res.status(404).json({ error: "Invite not found or unauthorized" });
        }
        if (invite.status !== "pending") {
            return res.status(409).json({ error: `Invite already ${invite.status}` });
        }

        const campaignDoc = invite.campaign as any;
        const campaignId = String(campaignDoc?._id ?? campaignDoc);
        const campaignTitle = campaignDoc?.title || "a campaign";
        const mePerson = await findPersonById(req.user.id, "name firstName lastName handle email");
        const me = mePerson?.doc;
        const myName = (me ? personDisplayName(me) : null) || req.user.email;

        if (action === "accept") {
            // Membership is polymorphic: campaign_members carries a column per
            // person type. Stamp the invitee's own id as well as their email, so
            // getAuthorizedCampaignIds finds them by id — a person with no email
            // would otherwise accept an invite and still not be a member.
            const idField = memberIdField(mePerson?.type ?? "User");
            const email = me?.email ?? req.user.email;
            const matchOr: any[] = [];
            if (idField) matchOr.push({ [idField]: req.user.id });
            if (email) matchOr.push({ email });

            const existing = matchOr.length
                ? await CampaignMember.findOne({ campaign: campaignId, $or: matchOr })
                : null;
            if (!existing) {
                await new CampaignMember({
                    campaign: campaignId,
                    ...(idField ? { [idField]: req.user.id } : {}),
                    email: email || undefined,
                    status: "Player",
                    joinedAt: new Date(),
                    firstName: me ? personDisplayName(me) : undefined,
                }).save();
            }
            invite.status = "accepted";
        } else {
            invite.status = "declined";
        }
        await invite.save();

        // Clear the invitee's bell entry and tell the inviter what happened.
        await resolveNotifications(req.user.id, `invite:${invite._id}`);
        await notify(invite.from, {
            type: "system",
            title: `@${myName} ${invite.status} your invite to "${campaignTitle}"`,
            link: invite.status === "accepted" ? `/game-night/campaigns/${campaignId}` : undefined,
        });

        res.json({ message: `Invite ${invite.status}`, invite });
    } catch (err: any) {
        console.error("[invites] respond error:", err);
        res.status(500).json({ error: "Failed to respond to invite", details: err.message });
    }
});

export default router;
