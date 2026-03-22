import express from "express";
const router = express.Router();
import User from "../models/User.js";
import Lead from "../models/Lead.js";
import Contact from "../models/Contact.js";
import Account from "../models/Account.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { sendResetPasswordEmail, sendVerificationEmail } from "../services/emailService.js";
import { OAuth2Client } from "google-auth-library";

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

router.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const token = crypto.randomBytes(20).toString("hex");
    const user = new User({ 
      name, 
      email, 
      password: password,
      isVerified: false,
      emailVerificationToken: token
    });
    
    await user.save();
    await sendVerificationEmail(email, token);
    
    res.status(201).json({ message: "User registered successfully! Please check your email to verify your account." });
  } catch (error: any) {
    console.error("Register Error:", error);
    res.status(500).json({ error: "Failed to register user" });
  }
});

router.post("/verify-email", async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Token is required" });

    try {
        let user: any = await User.findOne({ emailVerificationToken: token });
        let Model: any = User;

        if (!user) {
            user = await Account.findOne({ emailVerificationToken: token });
            Model = Account;
        }

        if (!user) {
            user = await Contact.findOne({ emailVerificationToken: token });
            Model = Contact;
        }

        if (!user) {
            user = await Lead.findOne({ emailVerificationToken: token });
            Model = Lead;
        }

        if (!user) {
            return res.status(400).json({ error: "Invalid or expired token" });
        }

        await Model.updateOne(
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
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required" });
    }

    console.log(`[AUTH] Login attempt for: ${email}`);

    try {
        let user: any = await User.findOne({ email });
        let userType = "User";   
        
         if (!user) {
            user = await Account.findOne({ email });
            userType = "Account";
            if (user) console.log(`[AUTH] Found match in Accounts`);
        }

        if (!user) {
            user = await Contact.findOne({ email });
            userType = "Contact";
            if (user) console.log(`[AUTH] Found match in Contacts`);
        }

        if (!user) {
            user = await Lead.findOne({ email });
            userType = "Lead";
            if (user) console.log(`[AUTH] Found match in Leads`);
        }
    

        if (!user) {
            console.log(`[AUTH] No user found with email: ${email} in any collection`);
            return res.status(401).json({ error: "Invalid credentials" });
        }

        console.log(`[AUTH] User found in ${userType}. Verifying password...`);

        // Verify password
        const isMatch = await bcrypt.compare(password, user.password || "");
        if (!isMatch) {
             console.log(`[AUTH] Password mismatch for: ${email}`);
             return res.status(401).json({ error: "Incorrect Password" });
        }
        console.log(`[AUTH] Login successful for: ${email}`);

        // Generate Token
        const token = jwt.sign(
            { id: user._id, type: userType, email: user.email },
            process.env.JWT_SECRET || "your-secret-key-change-this",
            { expiresIn: "1h" }
        );

        res.json({ 
            token, 
            user: { 
                id: user._id, 
                type: userType, 
                email: user.email, 
                name: user.name || user.firstName || user.title,
                userNumber: user.userNumber,
                phone: user.phone,
                role: user.role,
                company: user.company,
                industry: user.industry,
                website: user.website
            } 
        });

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

        const { email, name, given_name, family_name, picture, phone_number } = payload;
        console.log(`[AUTH] Google login attempt for: ${email}`);

        let user: any = null;
        let userType = "";

        // 1. Unified Lookup: Search by Email
        user = await User.findOne({ email });
        if (user) userType = "User";

        if (!user) {
            user = await Account.findOne({ email });
            if (user) userType = "Account";
        }

        if (!user) {
            user = await Contact.findOne({ email });
            if (user) userType = "Contact";
        }

        if (!user) {
            user = await Lead.findOne({ email });
            if (user) userType = "Lead";
        }

        // 2. Fallback: Search by Phone
        if (!user && phone_number) {
            console.log(`[AUTH] Email match failed. Searching by phone: ${phone_number}`);
            user = await User.findOne({ phone: phone_number });
            if (user) userType = "User";

            if (!user) {
                user = await Account.findOne({ phone: phone_number });
                if (user) userType = "Account";
            }

            if (!user) {
                user = await Contact.findOne({ phone: phone_number });
                if (user) userType = "Contact";
            }

            if (!user) {
                user = await Lead.findOne({ phone: phone_number });
                if (user) userType = "Lead";
            }
        }

        // 3. Fallback: Search by Name
        if (!user && name) {
            console.log(`[AUTH] Phone match failed. Searching by name: ${name}`);
            const firstName = given_name || name.split(" ")[0];
            const lastName = family_name || name.split(" ").slice(1).join(" ") || "N/A";

            user = await User.findOne({ name }); // User model uses 'name'
            if (user) userType = "User";

            if (!user) {
                user = await Account.findOne({ name }); // Account model uses 'name'
                if (user) userType = "Account";
            }

            if (!user) {
                user = await Contact.findOne({ name }); // Contact uses 'name'
                if (user) userType = "Contact";
            }

            if (!user) {
                user = await Lead.findOne({ firstName, lastName }); // Lead model uses firstName/lastName
                if (user) userType = "Lead";
            }
        }

        // 4. Auto-creation: If still not found, create a new Lead
        if (!user) {
            console.log(`[AUTH] User not found. Creating new Lead for: ${email}`);
            const firstName = given_name || (name ? name.split(" ")[0] : "New");
            const lastName = family_name || (name ? name.split(" ").slice(1).join(" ") : "Google User");
            
            user = new Lead({
                firstName,
                lastName,
                email,
                password: crypto.randomBytes(16).toString("hex"),
                phone: phone_number,
                source: "Google Login",
                status: "New"
            });
            await user.save();
            userType = "Lead";
            console.log(`[AUTH] New Lead created successfully`);
        }

        console.log(`[AUTH] Google login successful for: ${email} (${userType})`);

        // Generate Token
        const jwtToken = jwt.sign(
            { id: user._id, type: userType, email: user.email },
            process.env.JWT_SECRET || "your-secret-key-change-this",
            { expiresIn: "1h" }
        );

        res.json({
            token: jwtToken,
            user: {
                id: user._id,
                type: userType,
                email: user.email,
                name: user.name || user.firstName || user.lastName || "User",
                userNumber: user.userNumber,
                phone: user.phone,
                role: user.role,
                company: user.company,
                industry: user.industry,
                website: user.website
            }
        });

    } catch (error: any) {
        console.error("Google login error:", error);
        res.status(500).json({ error: "Google login failed" });
    }
});


router.post("/forgot-password", async (req, res) => {
    const { email } = req.body;
    try {
        let user: any = await User.findOne({ email });
        let userType = "User";

        if (!user) {
            user = await Account.findOne({ email });
            userType = "Account";
        }

        if (!user) {
            user = await Contact.findOne({ email });
            userType = "Contact";
        }

        if (!user) {
            user = await Lead.findOne({ email });
            userType = "Lead";
        }

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        const token = crypto.randomBytes(20).toString("hex");
        
        let Model: any;
        if (userType === "User") Model = User;
        else if (userType === "Account") Model = Account;
        else if (userType === "Contact") Model = Contact;
        else Model = Lead;

        await Model.updateOne(
            { _id: user._id },
            { 
                $set: { 
                    resetPasswordToken: token, 
                    resetPasswordExpires: Date.now() + 3600000 // 1 hour
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
        let user: any = await User.findOne({
            resetPasswordToken: token,
            resetPasswordExpires: { $gt: Date.now() },
        });
        let userType = "User";

        if (!user) {
            user = await Account.findOne({
                resetPasswordToken: token,
                resetPasswordExpires: { $gt: Date.now() },
            });
            userType = "Account";
        }

        if (!user) {
            user = await Contact.findOne({
                resetPasswordToken: token,
                resetPasswordExpires: { $gt: Date.now() },
            });
            userType = "Contact";
        }

        if (!user) {
            user = await Lead.findOne({
                resetPasswordToken: token,
                resetPasswordExpires: { $gt: Date.now() },
            });
            userType = "Lead";
        }

        if (!user) {
            return res.status(400).json({ error: "Invalid or expired token" });
        }

        // We need to use the model specifically to trigger pre-save hooks if they exist
        let Model: any;
        if (userType === "User") Model = User;
        else if (userType === "Account") Model = Account;
        else if (userType === "Contact") Model = Contact;
        else Model = Lead;

        // Fetch the document again to ensure it's a Mongoose document for .save()
        const doc = await Model.findById(user._id);
        if (!doc) return res.status(404).json({ error: "User no longer exists" });

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
