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
import https from "https";
import http from "http";
import fs from "fs";

const app = express();
const httpsPort = process.env.HTTPS_PORT || 5001;
const httpPort = process.env.HTTP_PORT || 5000;

const credentials = {
    key: fs.readFileSync("./key.pem"),
    cert: fs.readFileSync("./cert.pem"),
};


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

app.use("/api/users", userRoutes);
app.use("/api/leads", leadRoutes);
app.use("/api/accounts", accountRoutes);
app.use("/db", dbRoutes);
app.use("/admin", adminRoutes);
const httpsServer = https.createServer(credentials, app);
const httpServer = http.createServer(app);

httpsServer.listen(httpsPort, () => {
  console.log(`HTTPS server listening on https://localhost:${httpsPort}`);
});

httpServer.listen(httpPort, () => {
  console.log(`HTTP server listening on http://localhost:${httpPort}`);
});



