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
import tabletopRoutes from "./routes/tabletopRoutes.js";
import syncRoutes from "./routes/syncRoutes.js";
import campaignMemberRoutes from "./routes/campaignMemberRoutes.js";
import friendRoutes from "./routes/friendRoutes.js";
import cloudClawRoutes from "./routes/cloudClawRoutes.js";
import apiKeyRoutes from "./routes/apiKeyRoutes.js";
import googleCalendarRoutes from "./routes/googleCalendarRoutes.js";
import messageRoutes from "./routes/messageRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import inviteRoutes from "./routes/inviteRoutes.js";
import { snapshotAlpacaNow } from "./routes/adminRoutes.js";
import { startEventBus, stopEventBus } from "./events/index.js";
import { startReadyCheckLoop } from "./utils/readyCheck.js";

import https from "https";
import http from "http";
import fs from "fs";
import path from "path";

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
} else {
    console.log("[BACKEND] No SSL certificates found. Skipping HTTPS server initialization.");
}


app.use(cors());
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));
app.get("/", (req, res) => {
    res.json({ message: "Personal Web App Backend API is Running", version: "1.2.0" });
});

app.get("/health", (req, res) => {
    const mongoStatus = mongoose.connection.readyState;
    // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
    const statusMap: any = { 0: "disconnected", 1: "connected", 2: "connecting", 3: "disconnecting" };

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
  .then(() => {
    const uri = process.env.MONGO_URI || 'DEFAULT (localhost)';
    console.log(`[BACKEND] MongoDB Connected! URI: ${uri.replace(/:([^@]+)@/, ':***@')}`);
  })
  .catch((err) => console.error(err));
app.use("/db", dbRoutes);
app.use("/admin", adminRoutes);
app.use("/api/users", userRoutes);
app.use("/api/leads", leadRoutes);
app.use("/api/accounts", accountRoutes);
app.use("/api/campaigns", campaignRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/tabletop", tabletopRoutes);
app.use("/api/sync", syncRoutes);
app.use("/api/campaign-members", campaignMemberRoutes);
app.use("/api/friends", friendRoutes);
app.use("/api/cloud-claw", cloudClawRoutes);
app.use("/api/api-keys", apiKeyRoutes);
app.use("/api/google-calendar", googleCalendarRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/campaign-invites", inviteRoutes);

// Event bus (Redis Streams when REDIS_URL is set; in-memory otherwise).
// Started after routes are imported so module-level subscriptions are registered.
startEventBus()
    .then(() => console.log("[BACKEND] Event bus started."))
    .catch((err) => console.error("[BACKEND] Event bus failed to start:", err));

// Ready-up checks: ping campaign members 30 minutes before each session.
startReadyCheckLoop();

process.on("SIGTERM", () => {
    stopEventBus().finally(() => process.exit(0));
});


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

// Alpaca snapshots: capture account + positions every 5 minutes so the dashboard
// can chart per-symbol position values over time. Only runs when keys are set.
if (process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY) {
    const FIVE_MIN = 5 * 60 * 1000;
    setTimeout(() => snapshotAlpacaNow(), 30_000); // first one shortly after boot
    setInterval(() => snapshotAlpacaNow(), FIVE_MIN);
    console.log('[BACKEND] Alpaca snapshot loop scheduled (every 5 min).');
}

// Global Error Handler.
app.use((err: any, req: any, res: any, next: any) => {
    console.error("!!! [BACKEND] UNHANDLED EXCEPTION:", err);
    console.error("!!! Error stack:", err.stack);

    res.status(500).json({
        error: "Internal Server Error",
        message: err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
});
