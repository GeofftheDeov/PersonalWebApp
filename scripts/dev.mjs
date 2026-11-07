#!/usr/bin/env node
/**
 * Runs the backend and both frontends locally, in one terminal (#216):
 *
 *   npm run dev            (from the repo root)
 *
 *   backend     http://localhost:5000   backend/ `npm run dev`, with backend/.env
 *   portfolio   http://localhost:3000   frontend/ `npm run dev`
 *   Hearthside  http://localhost:3002   hearthside/ `npm run dev` (its own server, so the
 *                                       live channel's WebSocket goes through it as deployed)
 *
 * Both frontends proxy /api to the backend, so the browser stays same-origin on each, and
 * one login (the session cookie, host-only on localhost) works on both. Needs, once: a root
 * `npm install`, `npm install` in backend/, and backend/.env (see backend/.env.example; for
 * Letters on Hearthside, SESSION_COOKIE_ORIGINS must list http://localhost:3002).
 *
 * Each line of output is prefixed with where it came from. Ctrl+C, or any of the three
 * stopping, stops them all.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * backend/.env as variables. The backend loads it itself too, but only after its modules
 * (the database pool among them) have been imported, so it's passed in up front as well.
 */
function backendEnv() {
  const file = path.join(ROOT, "backend", ".env");
  if (!fs.existsSync(file)) {
    console.error("[dev] backend/.env is missing: copy backend/.env.example and fill it in.");
    process.exit(1);
  }
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}

const fromBackend = backendEnv();
const backendPort = fromBackend.HTTP_PORT || "5000";
const backendUrl = `http://localhost:${backendPort}`;

const apps = [
  { name: "backend", cwd: "backend", env: fromBackend },
  { name: "portfolio", cwd: "frontend", env: { BACKEND_URL: backendUrl } },
  { name: "hearthside", cwd: "hearthside", env: { BACKEND_URL: backendUrl, PORT: "3002" } },
];

const children = [];
let stopping = false;

function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    // npm runs each app under a shell; on Windows only taskkill takes the whole tree down.
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  }
  process.exitCode = code;
}

for (const app of apps) {
  const child = spawn("npm", ["run", "dev"], {
    cwd: path.join(ROOT, app.cwd),
    env: { ...process.env, ...app.env },
    shell: process.platform === "win32",
  });
  children.push(child);
  const tag = `[${app.name}]`.padEnd(13);
  for (const stream of [child.stdout, child.stderr]) {
    let rest = "";
    stream.on("data", (chunk) => {
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop() ?? "";
      for (const line of lines) process.stdout.write(`${tag}${line}\n`);
    });
  }
  child.on("exit", (code) => {
    if (stopping) return;
    console.log(`[dev] ${app.name} stopped (exit ${code}); stopping the rest.`);
    stopAll(code ?? 1);
  });
}

console.log(`[dev] backend ${backendUrl} · portfolio http://localhost:3000 · Hearthside http://localhost:3002`);
process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
