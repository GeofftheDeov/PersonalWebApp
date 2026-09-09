import express from "express";
const router = express.Router();
import Account from "../models/Account.js";
import PlayerSession from "../models/PlayerSession.js";
import CampaignMember from "../models/CampaignMember.js";
import CampaignInvite from "../models/CampaignInvite.js";
import Campaign from "../models/Campaign.js";
import { getAuthorizedCampaignIds } from "../utils/gameNightPlannerUtils.js";
import { findPersonById, toPublicPerson } from "../utils/personUtils.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import multer from "multer";
import path from "path";
import fs from "fs";
import { sendResetPasswordEmail, sendVerificationEmail } from "../services/emailService.js";
import { auth } from "../middleware/auth.js";
import { OAuth2Client } from "google-auth-library";

/**
 * Phase 3 (#35, plan §3.2).
 *
 * Five separate four-table fallback cascades used to live in this file — login,
 * google-login, verify-email, forgot-password, reset-password — each walking
 * User, then Account, then Contact, then Lead, and each remembering which table
 * it landed in so later code could pick the same model again. Every one of them
 * is now a single query against `accounts`, on an indexed citext column: the
 * `{ $regex: ^email$, i }` pattern that forced a sequential scan on every login
 * attempt is gone with them.
 */

const uploadDir = path.join(process.cwd(), "uploads", "profile-pictures");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (req: any, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `${req.user.id}-${Date.now()}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (file.mimetype.startsWith("image/")) cb(null, true);
        else cb(new Error("Only image files are allowed"));
    }
});

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-this";

/**
 * The token carries only who you are. It deliberately does NOT carry what you
 * may do: `app_role` is read from the database at the moment it is needed, so
 * revoking admin takes effect immediately rather than at the end of somebody's
 * hour-long token. The old `type` claim is not emitted at all — after the merge
 * it could only be meaningless or wrong, and a claim nothing reads is a claim
 * something will eventually start reading again by mistake.
 */
const signToken = (person: any) =>
    jwt.sign({ id: person._id, email: person.email }, JWT_SECRET, { expiresIn: "1h" });

/** The user object the client stores. Capability comes from explicit columns. */
const publicUser = (person: any) => ({
    id: person._id,
    email: person.email,
    name: person.name || person.firstName || "User",
    userNumber: person.userNumber,
    userDigit: person.userDigit,
    phone: person.phone,
    // Authorization and entitlement, deliberately two fields (#28). A tier
    // change must never move somebody's access.
    appRole: person.appRole,
    accountTier: person.accountTier,
    // Provenance only — where the record came from. The Paperclip gate is the
    // one place allowed to read it, and it says so at the point of use.
    recordType: person.sfObject ?? null,
    company: person.company,
    industry: person.industry,
    website: person.website,
    handle: person.handle,
    profilePicture: person.profilePicture,
});

/**
 * Bind any pending invites addressed to this email (plan §3.5). A Game Master
 * can invite somebody who has no account yet; this is where that invite finds
 * its person. Run on registration and again on login, so an invite sent between
 * the two is not stranded.
 */
async function bindPendingInvites(person: any): Promise<void> {
    if (!person?.email) return;
    try {
        await CampaignInvite.updateMany(
            { toEmail: person.email, to: null, status: "pending" },
            { $set: { to: person._id } },
        );
    } catch (err: any) {
        // Never fail a login over this; the next login retries.
        console.error("[INVITES] binding pending invites failed:", err.message);
    }
}

router.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const isDev = process.env.NODE_ENV === "development" || req.headers.host?.includes("localhost");
    const token = isDev ? undefined : crypto.randomBytes(20).toString("hex");

    // sf_object = 'Lead' with sf_id NULL is the marker for "app-native, not yet
    // in the CRM" (§2.8). The nightly outbox drain creates the Salesforce Lead
    // and writes the id back; nothing about signup waits on Salesforce.
    const user = new Account({
      name,
      email,
      password,
      isVerified: isDev,
      emailVerificationToken: token,
      sfObject: "Lead",
    });

    await user.save();
    await bindPendingInvites(user);
    if (!isDev && token) await sendVerificationEmail(email, token);

    res.status(201).json({
      message: isDev ? "User registered successfully!" : "User registered successfully! Please check your email to verify your account.",
      isVerified: isDev
    });
  } catch (error: any) {
    console.error("Register Error:", error);
    res.status(500).json({ error: "Failed to register user" });
  }
});

router.post("/verify-email", async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Token is required" });

    try {
        const user = await Account.findOne({ emailVerificationToken: token });
        if (!user) return res.status(400).json({ error: "Invalid or expired token" });

        await Account.updateOne(
            { _id: user._id },
            {
                $set: { isVerified: true },
                $unset: { emailVerificationToken: "" }
            }
        );

        res.json({ message: "Email verified successfully" });
    } catch (error) {
        console.error("Verify Email Error:", error);
        res.status(500).json({ error: "Error verifying email" });
    }
});

router.post("/login", async (req, res) => {
    try {
        let { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: "Email and password are required" });
        }

        email = email.trim().toLowerCase();

        // accounts.email is citext with a unique index. One query, no cascade,
        // no case-insensitive regex forcing a sequential scan.
        const user: any = await Account.findOne({ email });

        if (!user) {
            console.log(`[AUTH] No account with email "${email}"`);
            return res.status(401).json({ error: "Invalid credentials" });
        }

        // Most people merged in from Salesforce have no password: 34 of 40 dev
        // landing rows carry no email either. They set one through reset.
        if (!user.password) {
            return res.status(403).json({
                error: "Password not set",
                message: "Professional accounts synced from Salesforce must set a password for first-time login. Please use 'Forgot Password'.",
                requiresReset: true
            });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            console.log(`[AUTH] Bad password for "${email}"`);
            return res.status(401).json({ error: "Incorrect Password" });
        }

        await bindPendingInvites(user);

        res.json({ token: signToken(user), user: publicUser(user) });
    } catch (error: any) {
        console.error("Login error:", error);
        res.status(500).json({ error: "Login failed" });
    }
});

router.post("/google-login", async (req, res) => {
    const { idToken } = req.body;

    if (!idToken) {
        return res.status(400).json({ error: "ID Token is required" });
    }

    try {
        const ticket = await client.verifyIdToken({
            idToken,
            audience: process.env.GOOGLE_CLIENT_ID,
        });

        const payload = ticket.getPayload() as any;
        if (!payload) return res.status(400).json({ error: "Invalid Google Token" });

        const { email, name, given_name, family_name, phone_number } = payload;
        console.log(`[AUTH] Google login attempt for: ${email}`);

        // Three fallback ladders of four queries each — email, then phone, then
        // name — collapse to three queries. The order is kept: matching on name
        // is a last resort and stays one.
        let user: any = email ? await Account.findOne({ email }) : null;

        if (!user && phone_number) {
            user = await Account.findOne({ phone: phone_number });
        }

        if (!user && name) {
            const firstName = given_name || name.split(" ")[0];
            const lastName = family_name || name.split(" ").slice(1).join(" ") || "N/A";
            user = await Account.findOne({ name })
                ?? await Account.findOne({ firstName, lastName });
        }

        if (!user) {
            console.log(`[AUTH] No account found. Creating one for: ${email}`);
            user = new Account({
                firstName: given_name || (name ? name.split(" ")[0] : "New"),
                lastName: family_name || (name ? name.split(" ").slice(1).join(" ") : "Google User"),
                name,
                email,
                password: crypto.randomBytes(16).toString("hex"),
                phone: phone_number,
                leadStatus: "New",
                sfObject: "Lead",
            });
            await user.save();
        }

        await bindPendingInvites(user);

        res.json({ token: signToken(user), user: publicUser(user) });
    } catch (error: any) {
        console.error("Google login error:", error);
        res.status(500).json({ error: "Google login failed" });
    }
});

router.get("/profile", auth, async (req: any, res) => {
    try {
        const user = await Account.findById(req.user.id)
            .select("-password -resetPasswordToken -resetPasswordExpires -emailVerificationToken");
        if (!user) return res.status(404).json({ error: "User not found" });

        res.json(user);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch profile" });
    }
});

/**
 * Capability for the client's own UI. The nav used to gate on the `type` stored
 * in localStorage, which outlives the token and cannot be refreshed — so after
 * the cutover a stale copy would have hidden the admin link from its owner.
 * Reading it from the server means the client can never be stale about what it
 * may do, and the server-side gates do not trust this answer anyway.
 */
router.get("/me/capabilities", auth, async (req: any, res) => {
    try {
        const user = await Account.findById(req.user.id)
            .select("appRole accountTier sfObject handle profilePicture");
        if (!user) return res.status(404).json({ error: "User not found" });
        res.json({
            appRole: user.appRole,
            accountTier: user.accountTier,
            recordType: user.sfObject ?? null,
            handle: user.handle ?? null,
            profilePicture: user.profilePicture ?? null,
        });
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch capabilities" });
    }
});

router.put("/profile", auth, async (req: any, res) => {
    try {
        const updateData = req.body;

        // Prevent sensitive field updates. appRole and accountTier are here for
        // the obvious reason; their *_source companions are here because setting
        // one to 'manual' would freeze the nightly merge out of that column.
        delete updateData._id;
        delete updateData.password;
        delete updateData.email;
        delete updateData.appRole;
        delete updateData.appRoleSource;
        delete updateData.accountTier;
        delete updateData.accountTierSource;
        delete updateData.isVerified;
        delete updateData.sfObject;
        delete updateData.sfID;

        // Leads used to keep firstName/lastName while the other three kept
        // `name`, so a rename had to know which table it was in. accounts has
        // all three columns; keep them consistent when a display name arrives.
        if (updateData.name) {
            const parts = String(updateData.name).trim().split(/\s+/);
            updateData.firstName = parts[0];
            updateData.lastName = parts.slice(1).join(" ") || null;
        }

        const updatedUser = await Account.findByIdAndUpdate(
            req.user.id,
            { $set: updateData },
            { new: true }
        ).select("-password");

        if (!updatedUser) return res.status(404).json({ error: "User not found" });

        res.json({ message: "Profile updated successfully", user: updatedUser });
    } catch (err) {
        console.error("Profile update error:", err);
        res.status(500).json({ error: "Failed to update profile" });
    }
});

/**
 * Read-only public profile of another player.
 * Visible only to friends and campaign-mates (or admins / yourself).
 * Deliberately exposes no edit surface and no child-record creation.
 */
router.get("/players/:id", auth, async (req: any, res) => {
    try {
        const targetId = req.params.id;
        const target = await findPersonById(targetId);
        if (!target) return res.status(404).json({ error: "Player not found" });

        const viewerId = req.user.id;
        const isSelf = String(viewerId) === String(targetId);

        // Friendship is symmetric (both sides updated on accept) — check either side.
        const viewer = await findPersonById(viewerId, "friends");
        const isFriend =
            viewer?.doc?.friends?.some((f: any) => String(f) === String(targetId)) ||
            target.doc.friends?.some((f: any) => String(f) === String(viewerId));

        // Campaign-mate check: any campaign both can see. null = admin (sees all).
        const viewerCampaigns = await getAuthorizedCampaignIds(req.user);
        const targetMemberships = await CampaignMember.find({ person: targetId })
            .select("campaign status");
        const targetCampaignIds = [...new Set(targetMemberships.map((m: any) => String(m.campaign)))];
        const sharedIds = viewerCampaigns === null
            ? targetCampaignIds
            : targetCampaignIds.filter(id => viewerCampaigns.some((v: any) => String(v) === id));

        if (!isSelf && !isFriend && sharedIds.length === 0) {
            return res.status(403).json({ error: "You can only view profiles of friends or campaign-mates" });
        }

        const sharedCampaigns = await Campaign.find({ _id: { $in: sharedIds } }).select("title status");
        const gmCampaignIds = new Set(
            targetMemberships.filter((m: any) => m.status === "Game Master").map((m: any) => String(m.campaign))
        );

        res.json({
            ...toPublicPerson(target),
            isFriend: Boolean(isFriend),
            sharedCampaigns: sharedCampaigns.map((c: any) => ({
                _id: c._id,
                title: c.title,
                status: c.status,
                isGameMaster: gmCampaignIds.has(String(c._id)),
            })),
        });
    } catch (err) {
        console.error("Player profile error:", err);
        res.status(500).json({ error: "Failed to fetch player profile" });
    }
});

router.get("/profile/sessions", auth, async (req: any, res) => {
    try {
        const records = await PlayerSession.find({ player: req.user.id })
            .populate("session", "title date summary vodUrl")
            .populate("campaign", "title")
            .sort({ createdAt: -1 });

        const sessions = records
            .filter((r: any) => r.session)
            .map((r: any) => ({
                playerSessionId: r._id,
                sessionId: r.session._id,
                title: r.session.title,
                date: r.session.date,
                summary: r.session.summary,
                vodUrl: r.session.vodUrl,
                campaign: r.campaign ? { id: r.campaign._id, title: r.campaign.title } : null,
            }));

        res.json(sessions);
    } catch (err) {
        console.error("Profile sessions error:", err);
        res.status(500).json({ error: "Failed to fetch sessions" });
    }
});

router.post("/profile/picture", auth, upload.single("profilePicture"), async (req: any, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });

        const pictureUrl = `/uploads/profile-pictures/${req.file.filename}`;

        const existing = await Account.findById(req.user.id).select("profilePicture");
        if (existing?.profilePicture) {
            const oldPath = path.join(process.cwd(), existing.profilePicture);
            if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }

        await Account.findByIdAndUpdate(req.user.id, { $set: { profilePicture: pictureUrl } });

        res.json({ profilePicture: pictureUrl });
    } catch (err: any) {
        console.error("Profile picture upload error:", err);
        res.status(500).json({ error: err.message || "Upload failed" });
    }
});

router.post("/forgot-password", async (req, res) => {
    const { email } = req.body;
    try {
        const user: any = await Account.findOne({ email });
        if (!user) return res.status(404).json({ error: "User not found" });

        const token = crypto.randomBytes(20).toString("hex");

        await Account.updateOne(
            { _id: user._id },
            {
                $set: {
                    resetPasswordToken: token,
                    resetPasswordExpires: new Date(Date.now() + 3600000) // 1 hour
                }
            }
        );

        await sendResetPasswordEmail(user.email, token);

        res.json({ message: "Password reset email sent", mockToken: token });
    } catch (error) {
        console.error("Forgot Password Error:", error);
        res.status(500).json({ error: "Error sending email" });
    }
});

router.post("/reset-password", async (req, res) => {
    const { token, newPassword } = req.body;
    try {
        const doc: any = await Account.findOne({
            resetPasswordToken: token,
            resetPasswordExpires: { $gt: new Date() },
        });

        if (!doc) {
            console.log(`[RESET] No account for this token, or it has expired.`);
            return res.status(400).json({ error: "Invalid or expired token" });
        }

        // Assigning plaintext is deliberate: the model's preSave hook hashes it.
        doc.password = newPassword;
        doc.resetPasswordToken = undefined;
        doc.resetPasswordExpires = undefined;

        await doc.save();

        res.json({ message: "Password reset successfully" });
    } catch (error) {
        console.error("Reset Password Error:", error);
        res.status(500).json({ error: "Error resetting password" });
    }
});

export default router;
