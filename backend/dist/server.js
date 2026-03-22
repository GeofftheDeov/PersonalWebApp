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
import campaignRoutes from "./routes/campaignRoutes.js";
import taskRoutes from "./routes/taskRoutes.js";
import eventRoutes from "./routes/eventRoutes.js";
import https from "https";
import http from "http";
import fs from "fs";
const app = express();
const httpsPort = Number(process.env.HTTPS_PORT) || 5001;
const httpPort = Number(process.env.HTTP_PORT) || 5000;
const hostname = '0.0.0.0'; // Bind to all interfaces for Fargate internal networking 
// Helper to check for certs
const hasCerts = fs.existsSync("./key.pem") && fs.existsSync("./cert.pem");
let credentials = {};
if (hasCerts) {
    console.log("[BACKEND] SSL certificates found. Preparing HTTPS...");
    credentials = {
        key: fs.readFileSync("./key.pem"),
        cert: fs.readFileSync("./cert.pem"),
    };
}
else {
    console.log("[BACKEND] No SSL certificates found. Skipping HTTPS server initialization.");
}
app.use(cors());
app.get("/", (req, res) => {
    res.json({ message: "Personal Web App Backend API is Running", version: "1.2.0" });
});
app.get("/health", (req, res) => {
    const mongoStatus = mongoose.connection.readyState;
    // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
    const statusMap = { 0: "disconnected", 1: "connected", 2: "connecting", 3: "disconnecting" };
    res.status(200).json({
        status: "ok",
        timestamp: new Date().toISOString(),
        mongodb: statusMap[mongoStatus] || "unknown"
    });
});
app.use((req, res, next) => {
    console.log(`[BACKEND] ${req.method} ${req.url}`);
    next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/personal_web_app")
    .then(() => console.log("MongoDB Connected"))
    .catch((err) => console.error(err));
app.use("/db", dbRoutes);
app.use("/admin", adminRoutes);
app.use("/api/users", userRoutes);
app.use("/api/leads", leadRoutes);
app.use("/api/accounts", accountRoutes);
app.use("/api/campaigns", campaignRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/events", eventRoutes);
if (hasCerts) {
    const httpsServer = https.createServer(credentials, app);
    httpsServer.listen(httpsPort, () => {
        console.log(`HTTPS server listening on https://localhost:${httpsPort}`);
    });
}
const httpServer = http.createServer(app);
httpServer.listen(httpPort, hostname, () => {
    console.log(`[BACKEND] HTTP server listening on http://${hostname}:${httpPort}`);
});
// Global Error Handler
app.use((err, req, res, next) => {
    console.error("!!! [BACKEND] UNHANDLED EXCEPTION:", err);
    console.error("!!! Error stack:", err.stack);
    res.status(500).json({
        error: "Internal Server Error",
        message: err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
});
