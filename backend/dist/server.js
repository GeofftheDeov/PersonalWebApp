import dotenv from "dotenv";
dotenv.config();
import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import userRoutes from "./routes/userRoutes.js";
import leadRoutes from "./routes/leadRoutes.js";
import accountRoutes from "./routes/accountRoutes.js";
import dbRoutes from "./routes/dbRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
const app = express();
app.use(cors());
app.use((req, res, next) => {
    console.log(`[BACKEND] ${req.method} ${req.url}`);
    next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/personal_web_app")
    .then(() => console.log("MongoDB Connected"))
    .catch((err) => console.error(err));
app.listen(5000, () => console.log("Server running on port 5000"));
app.use("/api/users", userRoutes);
app.use("/api/leads", leadRoutes);
app.use("/api/accounts", accountRoutes);
app.use("/db", dbRoutes);
app.use("/admin", adminRoutes);
