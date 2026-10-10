import express from "express";
const router = express.Router();
import Campaign from "../models/Campaign.js";
import CampaignMember from "../models/CampaignMember.js";
import Session from "../models/Session.js";
import Account from "../models/Account.js";
import { auth } from "../middleware/auth.js";
import { getAuthorizedCampaignIds } from "../utils/gameNightPlannerUtils.js";
import { personDisplayName } from "../utils/personUtils.js";
import { SettingsError, cleanGmTitle, updateCampaignSettings } from "../planning/campaignSettings.js";
import { clearBanner, requestBannerUpload, setBanner, withBannerUrl } from "../planning/campaignBanner.js";
import { bus } from "../events/index.js";
import { TorchError, passTorchPermanently } from "../planning/torch.js";

/**
 * Phase 3 (#35, plan §3.4). Auto-enrolment used to branch on req.user.type to
 * choose which of lead_id / contact_id / account_id to write — and the `else`
 * branch, the one a Salesforce User fell into, wrote NO person column at all,
 * only an email. That is why getAuthorizedCampaignIds had to OR over four
 * things including an unindexed email match, and why a Game Master could be the
 * member row with the least to identify them by. One person_id replaces it.
 */

/** Membership fields for the signed-in person. No branch, no email fallback. */
async function memberFieldsFor(user: any, campaignId: string, status: string) {
    const person = await Account.findById(user.id).select("name firstName lastName handle email");
    return {
        campaign: campaignId,
        person: user.id,
        email: person?.email ?? user.email,
        firstName: person?.firstName ?? personDisplayName(person),
        lastName: person?.lastName ?? undefined,
        status,
        joinedAt: new Date(),
    };
}

// Create a new campaign
router.post("/", auth, async (req: any, res) => {
    try {
        const { title, description, status, startDate, endDate } = req.body;

        // Validation
        if (!title || !description || !status || !startDate) {
            return res.status(400).json({
                error: "Missing required fields: title, description, status, startDate"
            });
        }

        // The creator owns the campaign (#57): the banner and GM title are
        // theirs, and stay theirs if the torch later passes to someone else.
        // They may name the Game Master role now; left blank, it's the default.
        const gmTitle = cleanGmTitle(req.body.gmTitle, { optional: true });
        const campaign = new Campaign({
            title,
            description,
            status,
            startDate,
            endDate,
            owner: req.user.id,
            gmTitle,
        });
        await campaign.save();

        // Auto-enroll creator as Game Master
        const memberFields = await memberFieldsFor(req.user, campaign._id, "Game Master");
        await new CampaignMember(memberFields).save();
        bus.publish("campaign.changed", { campaignId: String(campaign._id), action: "created" }).catch(() => { /* non-fatal */ });

        res.status(201).json({
            message: "Campaign created successfully!",
            campaign: {
                id: campaign._id,
                title: campaign.title,
                description: campaign.description,
                status: campaign.status,
                startDate: campaign.startDate,
                endDate: campaign.endDate,
                owner: campaign.owner,
                gmTitle: campaign.gmTitle,
            }
        });
    } catch (error: any) {
        if (error instanceof SettingsError) return res.status(error.status).json({ error: error.message });
        console.error("Error creating campaign:", error);
        res.status(500).json({ error: "Failed to create campaign", details: error.message });
    }
});

// Get all campaigns
router.get("/", auth, async (req: any, res) => {
    try {
        const campaignIds = await getAuthorizedCampaignIds(req.user);
        const query = campaignIds ? { _id: { $in: campaignIds } } : {};

        const campaigns = await Campaign.find(query).sort({ startDate: -1 });
        res.json(await Promise.all(campaigns.map((c: any) => withBannerUrl(c.toJSON()))));
    } catch (error: any) {
        console.error("Error fetching campaigns:", error);
        res.status(500).json({ error: "Failed to fetch campaigns", details: error.message });
    }
});

// Get a specific campaign
router.get("/:id", auth, async (req: any, res) => {
    try {
        const campaign = await Campaign.findById(req.params.id);
        if (!campaign) {
            return res.status(404).json({ error: "Campaign not found" });
        }
        // Anyone signed in can read a campaign (the invite page needs it before
        // joining), but only the party (and admins) get a link to its banner.
        const campaignIds = await getAuthorizedCampaignIds(req.user);
        const inParty = !campaignIds || campaignIds.some((cid: any) => cid.toString() === String(campaign._id));
        res.json(inParty ? await withBannerUrl(campaign.toJSON()) : { ...campaign.toJSON(), bannerUrl: null });
    } catch (error: any) {
        console.error("Error fetching campaign:", error);
        res.status(500).json({ error: "Failed to fetch campaign", details: error.message });
    }
});

// Update a campaign
router.put("/:id", auth, async (req: any, res) => {
    try {
        const campaignIds = await getAuthorizedCampaignIds(req.user);
        if (campaignIds && !campaignIds.some((cid: any) => cid.toString() === req.params.id)) {
            return res.status(403).json({ error: "Unauthorized" });
        }
        const { title, description, status, startDate, endDate, discordGuildId, discordChannelId } = req.body;
        const campaign = await Campaign.findByIdAndUpdate(
            req.params.id,
            { title, description, status, startDate, endDate, discordGuildId, discordChannelId },
            { new: true }
        );
        if (!campaign) return res.status(404).json({ error: "Campaign not found" });
        res.json(await withBannerUrl(campaign.toJSON()));
    } catch (error: any) {
        console.error("Error updating campaign:", error);
        res.status(500).json({ error: "Failed to update campaign", details: error.message });
    }
});

// Owner-only settings planning reads (#57): quorum, table link, GM title.
router.patch("/:id/settings", auth, async (req: any, res) => {
    try {
        res.json(await updateCampaignSettings(req.user.id, req.params.id, req.body));
    } catch (error: any) {
        if (error instanceof SettingsError) return res.status(error.status).json({ error: error.message });
        console.error("Error updating campaign settings:", error);
        res.status(500).json({ error: "Failed to update campaign settings" });
    }
});

// Pass the torch permanently (#89): { to, from? }. GM or admin; ownership stays put.
router.post("/:id/torch", auth, async (req: any, res) => {
    try {
        res.json(await passTorchPermanently(req.user.id, req.params.id, req.body));
    } catch (error: any) {
        if (error instanceof TorchError) return res.status(error.status).json({ error: error.message });
        console.error("Error passing the torch:", error);
        res.status(500).json({ error: "Failed to pass the torch" });
    }
});

// Campaign banner (#81), owner-only like the settings above. The browser asks
// for an upload URL, PUTs the cropped image straight to S3, then saves the key.
const bannerRoute = (fn: (actorId: string, campaignId: string, body: any) => Promise<unknown>) =>
    async (req: any, res: any) => {
        try {
            res.json(await fn(req.user.id, req.params.id, req.body));
        } catch (error: any) {
            if (error instanceof SettingsError) return res.status(error.status).json({ error: error.message });
            console.error("Error updating campaign banner:", error);
            res.status(500).json({ error: "Failed to update the campaign banner" });
        }
    };
router.post("/:id/banner/upload-url", auth, bannerRoute(requestBannerUpload));
router.put("/:id/banner", auth, bannerRoute(setBanner));
router.delete("/:id/banner", auth, bannerRoute(clearBanner));

// Get sessions for a specific campaign
router.get("/:id/sessions", auth, async (req: any, res) => {
    try {
        const campaignIds = await getAuthorizedCampaignIds(req.user);
        // Verify the user has access to this campaign
        if (campaignIds && !campaignIds.some((cid: any) => cid.toString() === req.params.id)) {
            return res.status(403).json({ error: "Unauthorized" });
        }
        const sessions = await Session.find({ campaign: req.params.id }).sort({ date: -1 });
        res.json(sessions);
    } catch (error: any) {
        console.error("Error fetching campaign sessions:", error);
        res.status(500).json({ error: "Failed to fetch sessions", details: error.message });
    }
});

// Join a campaign via invite link
router.post("/:id/join", auth, async (req: any, res) => {
    try {
        const campaign = await Campaign.findById(req.params.id);
        if (!campaign) return res.status(404).json({ error: "Campaign not found" });

        // Membership is keyed on the person, not their email. Matching on email
        // let the same person join twice under two different records.
        const existing = await CampaignMember.findOne({ campaign: req.params.id, person: req.user.id });
        if (existing) return res.status(409).json({ error: "Already a member of this campaign" });

        const memberFields = await memberFieldsFor(req.user, req.params.id, "Player");
        const member = await new CampaignMember(memberFields).save();
        res.status(201).json({ message: "Joined campaign successfully!", member });
    } catch (error: any) {
        console.error("Error joining campaign:", error);
        res.status(500).json({ error: "Failed to join campaign", details: error.message });
    }
});

// Get members (players) for a specific campaign
router.get("/:id/members", auth, async (req: any, res) => {
    try {
        const campaignIds = await getAuthorizedCampaignIds(req.user);
        if (campaignIds && !campaignIds.some((cid: any) => cid.toString() === req.params.id)) {
            return res.status(403).json({ error: "Unauthorized" });
        }
        // Every member sees this for every other member, so `person` carries
        // what the pages name them by and nothing else. Populated whole, it
        // handed out each account's password hash and reset token.
        const members = await CampaignMember.find({ campaign: req.params.id })
            .populate({ path: "person", select: "handle name firstName lastName" })
            .sort({ joinedAt: 1 });

        // playerId used to be assembled from whichever of three refs was set,
        // with an email lookup across four collections for the rows that had
        // none. Every member now has one.
        const enriched = members.map((m: any) => {
            const obj = m.toObject();
            obj.playerId = m.person?._id?.toString() ?? null;
            return obj;
        });
        res.json(enriched);
    } catch (error: any) {
        console.error("Error fetching campaign members:", error);
        res.status(500).json({ error: "Failed to fetch members", details: error.message });
    }
});

export default router;
