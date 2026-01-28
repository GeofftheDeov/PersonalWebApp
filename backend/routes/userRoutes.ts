import express from "express";
const router = express.Router();
import User from "../models/User.js";
import Lead from "../models/Lead.js";
import Account from "../models/Account.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { sendResetPasswordEmail } from "../services/emailService.js";

router.post("/register", async (req, res) => {
  const { name, email, password } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);
  const user = new User({ name, email, password: hashedPassword });
  await user.save();
  res.send("User registered successfully!");
});

router.post("/login", async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required" });
    }

    try {
        let user: any = await User.findOne({ email });
        let userType = "User";

        if (!user) {
            user = await Lead.findOne({ email });
            userType = "Lead";
        }

        if (!user) {
            user = await Account.findOne({ email });
            userType = "Account";
        }

        if (!user) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        // Verify password
        const isMatch = await bcrypt.compare(password, user.password || "");
        if (!isMatch) {
             return res.status(401).json({ error: "Invalid credentials" });
        }

        // Generate Token
        const token = jwt.sign(
            { id: user._id, type: userType, email: user.email },
            process.env.JWT_SECRET || "your-secret-key-change-this",
            { expiresIn: "1h" }
        );

        res.json({ token, user: { id: user._id, type: userType, email: user.email, name: user.name || user.firstName || user.title } });

    } catch (error: any) {
        console.error("Login error:", error);
        res.status(500).json({ error: "Login failed" });
    }
});

router.post("/forgot-password", async (req, res) => {
    const { email } = req.body;
    try {
        let user: any = await User.findOne({ email });
        let userType = "User";

        if (!user) {
            user = await Lead.findOne({ email });
            userType = "Lead";
        }

        if (!user) {
            user = await Account.findOne({ email });
            userType = "Account";
        }

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        const token = crypto.randomBytes(20).toString("hex");
        user.resetPasswordToken = token;
        user.resetPasswordExpires = Date.now() + 3600000; // 1 hour

        await user.save();

        await sendResetPasswordEmail(user.email, token);

        res.json({ message: "Password reset email sent", mockToken: token }); // Return mockToken just in case
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

        if (!user) {
            user = await Lead.findOne({
                resetPasswordToken: token,
                resetPasswordExpires: { $gt: Date.now() },
            });
        }

        if (!user) {
            user = await Account.findOne({
                resetPasswordToken: token,
                resetPasswordExpires: { $gt: Date.now() },
            });
        }

        if (!user) {
            return res.status(400).json({ error: "Invalid or expired token" });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        user.password = hashedPassword;
        user.resetPasswordToken = undefined;
        user.resetPasswordExpires = undefined;

        await user.save();

        res.json({ message: "Password reset successfully" });
    } catch (error) {
        console.error("Reset Password Error:", error);
        res.status(500).json({ error: "Error resetting password" });
    }
});

export default router;

