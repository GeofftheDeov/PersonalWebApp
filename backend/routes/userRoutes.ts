import express from "express";
const router = express.Router();
import User from "../models/User.ts";
router.post("/register", async (req, res) => {
  const { name, email, password } = req.body;
  const user = new User({ name, email, password });
  await user.save();
  res.send("User registered successfully!");
});
module.exports = router;
