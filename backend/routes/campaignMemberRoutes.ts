import express from "express";
const router = express.Router();
import CampaignMember from "../models/CampaignMember.js";
import { auth } from "../middleware/auth.js";
import { getAuthorizedCampaignIds, isCampaignGameMaster } from "../utils/gameNightPlannerUtils.js";

/**
 * Campaign membership admin (#35, plan §3.6).
 *
 * This router had no authorization at all. `GET /` returned every campaign
 * member across every campaign — names, emails, phones — to any authenticated
 * user, and `PUT /:id` / `DELETE /:id` let any authenticated user edit or delete
 * any membership in the system. Every handler is now scoped: reads to campaigns
 * you can see, writes to campaigns you run.
 *
 * The person columns also collapsed to one. `lead` / `contact` / `account` are
 * gone from the model, so a client that still posts them gets a membership with
 * no person rather than a silent partial write — hence the explicit 400.
 */

/** The membership, plus the campaign it belongs to — or null if you can't see it. */
async function readableMember(req: any, id: string) {
    const member = await CampaignMember.findById(id).populate("campaign").populate("person");
    if (!member) return { member: null, allowed: false };
    const campaignIds = await getAuthorizedCampaignIds(req.user);
    const campaignId = String((member.campaign as any)?._id ?? member.campaign);
    const allowed = campaignIds === null
        || campaignIds.some((cid: any) => String(cid) === campaignId);
    return { member, allowed, campaignId };
}

// Every membership in a campaign you can see. Admins see all (campaignIds null).
router.get("/", auth, async (req: any, res) => {
    try {
        const campaignIds = await getAuthorizedCampaignIds(req.user);
        const filter = campaignIds === null ? {} : { campaign: { $in: campaignIds } };
        const members = await CampaignMember.find(filter)
            .populate("campaign")
            .populate("person")
            .sort({ createdAt: -1 });
        res.json(members);
    } catch (error: any) {
        console.error("Error fetching campaign members:", error);
        res.status(500).json({ error: "Failed to fetch campaign members", details: error.message });
    }
});

router.get("/:id", auth, async (req: any, res) => {
    try {
        const { member, allowed } = await readableMember(req, req.params.id);
        if (!member) return res.status(404).json({ error: "Campaign member not found" });
        if (!allowed) return res.status(403).json({ error: "Unauthorized" });
        res.json(member);
    } catch (error: any) {
        console.error("Error fetching campaign member:", error);
        res.status(500).json({ error: "Failed to fetch campaign member", details: error.message });
    }
});

// Adding somebody to a campaign is a Game Master action.
router.post("/", auth, async (req: any, res) => {
    try {
        const { campaign, person, status, joinedAt, firstName, lastName, email, phone } = req.body;

        if (!campaign) return res.status(400).json({ error: "Campaign reference is required" });
        if (!person) return res.status(400).json({ error: "A person reference is required" });

        if (!(await isCampaignGameMaster(req.user, String(campaign)))) {
            return res.status(403).json({ error: "Only the Game Master can add members" });
        }

        const existing = await CampaignMember.findOne({ campaign, person });
        if (existing) return res.status(409).json({ error: "Already a member of this campaign" });

        const member = new CampaignMember({
            campaign,
            person,
            status,
            joinedAt: joinedAt || new Date(),
            firstName,
            lastName,
            email,
            phone
        });

        await member.save();
        res.status(201).json({ message: "Campaign member created successfully!", member });
    } catch (error: any) {
        console.error("Error creating campaign member:", error);
        res.status(500).json({ error: "Failed to create campaign member", details: error.message });
    }
});

router.put("/:id", auth, async (req: any, res) => {
    try {
        const { member, campaignId } = await readableMember(req, req.params.id);
        if (!member) return res.status(404).json({ error: "Campaign member not found" });
        if (!(await isCampaignGameMaster(req.user, campaignId!))) {
            return res.status(403).json({ error: "Only the Game Master can edit members" });
        }

        // Moving a membership to a different person or campaign is not an edit.
        const update = { ...req.body };
        delete update.person;
        delete update.campaign;
        delete update._id;

        const updatedMember = await CampaignMember.findByIdAndUpdate(
            req.params.id,
            { $set: update },
            { new: true }
        );
        res.json({ message: "Campaign member updated successfully", member: updatedMember });
    } catch (error: any) {
        console.error("Error updating campaign member:", error);
        res.status(500).json({ error: "Failed to update campaign member", details: error.message });
    }
});

router.delete("/:id", auth, async (req: any, res) => {
    try {
        const { member, campaignId } = await readableMember(req, req.params.id);
        if (!member) return res.status(404).json({ error: "Campaign member not found" });

        // A player may remove themselves; otherwise this is a GM action.
        const isSelf = String((member.person as any)?._id ?? member.person) === String(req.user.id);
        if (!isSelf && !(await isCampaignGameMaster(req.user, campaignId!))) {
            return res.status(403).json({ error: "Only the Game Master can remove members" });
        }

        await CampaignMember.findByIdAndDelete(req.params.id);
        res.json({ message: "Campaign member deleted successfully" });
    } catch (error: any) {
        console.error("Error deleting campaign member:", error);
        res.status(500).json({ error: "Failed to delete campaign member", details: error.message });
    }
});

export default router;
