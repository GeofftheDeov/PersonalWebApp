import express from "express";
const router = express.Router();
import User from "../models/User.js";
import Lead from "../models/Lead.js";
import Account from "../models/Account.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

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

export default router;

