import dotenv from "dotenv";
dotenv.config();

const INSECURE_JWT_DEFAULT = "your-secret-key-change-this";
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret === INSECURE_JWT_DEFAULT) {
    if (process.env.NODE_ENV === "production") {
        throw new Error("FATAL: JWT_SECRET must be set to a strong secret in production");
    } else {
        console.warn("[SECURITY] WARNING: JWT_SECRET is missing or using the insecure default. Set a strong secret before deploying to production.");
    }
}

const vaultKey = process.env.VAULT_ENCRYPTION_KEY;
if (!vaultKey) {
    if (process.env.NODE_ENV === "production") {
        throw new Error("FATAL: VAULT_ENCRYPTION_KEY must be set in production");
    } else {
        console.warn("[SECURITY] WARNING: VAULT_ENCRYPTION_KEY is not set. The API Key Vault will not function.");
    }
}

import express from "express";
import pool from "./db/index.js";
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
import paperclipRoutes from "./routes/paperclipRoutes.js";
import apiKeyRoutes from "./routes/apiKeyRoutes.js";
import googleCalendarRoutes from "./routes/googleCalendarRoutes.js";
import messageRoutes from "./routes/messageRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import inviteRoutes from "./routes/inviteRoutes.js";
import { snapshotAlpacaNow } from "./routes/adminRoutes.js";
import { startEventBus, stopEventBus } from "./events/index.js";
import { startReadyCheckLoop } from "./utils/readyCheck.js";
import { startWorkers } from "./jobs/workers.js";
import { registerRepeatableJobs, closeBullConnection } from "./jobs/queues.js";

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

app.get("/health", async (req, res) => {
    let dbStatus = "connected";
    try {
        await pool.query("SELECT 1");
    } catch {
        dbStatus = "disconnected";
    }
    res.status(200).json({
        status: "ok",
        timestamp: new Date().toISOString(),
        postgres: dbStatus
    });
});
app.use((req, res, next) => {
    // req.url includes the query string, and /admin authenticates by ?token=.
    // This middleware runs before /admin mounts, so every admin page load used to
    // write a valid JWT into CloudWatch in plaintext, readable for the log
    // group's whole retention period (#39). Redact before logging, not after.
    console.log(`[BACKEND] ${req.method} ${req.url.replace(/([?&]token=)[^&]+/, "$1***")}`);
    next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
pool.query("SELECT 1")
  .then(() => {
    const uri = process.env.DATABASE_URL || "DEFAULT (localhost)";
    console.log(`[BACKEND] Postgres connected! ${uri.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@")}`);
  })
  .catch((err) => console.error("[BACKEND] Postgres connection failed:", err));
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
app.use("/api/paperclip", paperclipRoutes);
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

// BullMQ workers + repeatable jobs (no-op when REDIS_URL is unset).
const stopWorkers = startWorkers();
registerRepeatableJobs().catch((err) =>
    console.error("[BACKEND] Failed to register repeatable jobs:", err)
);

process.on("SIGTERM", () => {
    Promise.all([stopEventBus(), stopWorkers(), closeBullConnection()])
        .finally(() => process.exit(0));
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
