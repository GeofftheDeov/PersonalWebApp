/**
 * One run's stack: a database, the backend and both apps, on ports of its own,
 * so runs in two worktrees at once don't meet (#218).
 *
 *   database    pwae2e_<time>_<random> on the private test cluster (127.0.0.1:5439),
 *               built from backend/db/schema.sql by backend/scripts/e2e-database.ts
 *   backend     backend/server.ts under tsx, on 127.0.0.1:<port>, as prod would run
 *               it for cookies: Secure, on the parent domain, prod's cookie name
 *   portfolio   https://geoffthedeov.test:<port>             frontend/https-server.js
 *   Hearthside  https://hearthside.geoffthedeov.test:<port>  hearthside/https-server.js
 *
 * The apps run in development mode (`next dev` behind their own servers), which
 * reads BACKEND_URL and NEXT_PUBLIC_PORTFOLIO_URL as it starts; a production
 * build bakes them in, and the ports change every run. They serve HTTPS with a
 * certificate made for the run (TLS_CERT_FILE, TLS_KEY_FILE), so the browser
 * keeps the backend's Secure cookie.
 *
 * The backend runs from the run's own folder, so a developer's backend/.env
 * (Redis, mail, API keys) can't reach it: it sees only what's set here.
 * Its logs, and the apps', are in e2e/.stack/<run>/ (kept a day).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { generate } from "selfsigned";
import { ALL_HOSTS, PARENT_DOMAIN, PROD } from "./hosts";
import { seedParty, type Party } from "./party";

export const REPO = path.resolve(__dirname, "..", "..");
export const BACKEND = path.join(REPO, "backend");
const RUNS = path.join(REPO, "e2e", ".stack");
export const TSX = path.join(BACKEND, "node_modules", "tsx", "dist", "cli.mjs");

/** What the tests get (through the E2E_STACK environment variable; see fixtures.ts). */
export interface Stack {
  runId: string;
  /** The portfolio's origin, e.g. https://geoffthedeov.test:51234. */
  portfolio: string;
  /** Hearthside's origin, e.g. https://hearthside.geoffthedeov.test:51236. */
  hearthside: string;
  /** The backend, straight (http://127.0.0.1:<port>): for seeding through the API from Node. */
  backend: string;
  /** The session cookie as the backend issues it. */
  cookie: { name: string; domain: string };
  databaseUrl: string;
  party: Party;
  /** Where the servers' logs are. */
  logs: string;
}

export const STACK_ENV = "E2E_STACK";

/** How long an app may take to start and compile its first page, in development mode. */
const APP_READY_MS = 240_000;
const BACKEND_READY_MS = 60_000;

export interface Server {
  name: string;
  child: ChildProcess;
  log: string;
  /** Its exit code once it has exited (-1 for a signal), else null. */
  exited: number | null;
}

const running = new Set<Server>();

/** Kills a server and everything it started (Next starts workers). */
export function kill(server: Server) {
  running.delete(server);
  const { pid } = server.child;
  if (!pid || server.child.exitCode !== null || server.child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

// However the runner ends (Ctrl+C included), leave no server behind.
process.once("exit", () => { for (const s of [...running]) kill(s); });

export function startServer(name: string, script: string[], cwd: string, env: NodeJS.ProcessEnv, logs: string): Server {
  const log = path.join(logs, `${name}.log`);
  const fd = fs.openSync(log, "a");
  const child = spawn(process.execPath, script, {
    cwd,
    env,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
    // Its own process group off Windows, so kill() takes its workers too.
    detached: process.platform !== "win32",
  });
  fs.closeSync(fd);
  const server: Server = { name, child, log, exited: null };
  // Recorded from the start: a server can die long before anyone waits for it.
  child.once("exit", (code) => { server.exited = code ?? -1; });
  running.add(server);
  return server;
}

function tail(file: string, lines = 40): string {
  try {
    return fs.readFileSync(file, "utf8").trimEnd().split(/\r?\n/).slice(-lines).map((l) => `    ${l}`).join("\n");
  } catch {
    return "    (no log)";
  }
}

/** Distinct free ports, held open together so this run can't get the same one twice. */
export async function freePorts(count: number): Promise<number[]> {
  const servers = await Promise.all(Array.from({ length: count }, () => new Promise<net.Server>((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => resolve(s));
  })));
  const ports = servers.map((s) => (s.address() as net.AddressInfo).port);
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  return ports;
}

/** A certificate for every test host, good for two days. The browser is told to accept it (playwright.config.ts). */
async function makeCertificate(dir: string): Promise<{ cert: string; key: string }> {
  const pems = await generate([{ name: "commonName", value: PARENT_DOMAIN }], {
    algorithm: "sha256",
    notAfterDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      {
        name: "subjectAltName",
        altNames: [...ALL_HOSTS.map((value) => ({ type: 2 as const, value })), { type: 7 as const, ip: "127.0.0.1" }],
      },
    ],
  });
  const cert = path.join(dir, "cert.pem");
  const key = path.join(dir, "key.pem");
  fs.writeFileSync(cert, pems.cert);
  fs.writeFileSync(key, pems.private);
  return { cert, key };
}

/** Runs a backend script; resolves with its stdout. */
export function runBackendScript(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX, ...args], { cwd: BACKEND, windowsHide: true });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`backend ${args.join(" ")} failed:\n${out}${err}`))));
  });
}

/** One GET; resolves with the status, or 0 if nothing answered. */
function probe(url: string, host?: string): Promise<number> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.get({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      headers: host ? { host } : {},
      rejectUnauthorized: false,
      timeout: 120_000,
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(0));
  });
}

/** Waits for a server to answer 200, failing early (with its log) if it exits. */
export async function waitFor(server: Server, url: string, ms: number, host?: string) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (server.exited !== null) throw new Error(`${server.name} exited (${server.exited}) before it was ready. Its log, ${server.log}:\n${tail(server.log)}`);
    if ((await probe(url, host)) === 200) return;
    if (Date.now() > deadline) throw new Error(`${server.name} wasn't ready at ${url} after ${ms / 1000}s. Its log, ${server.log}:\n${tail(server.log)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Runs older than a day: their logs and certificates. A live run is never that old. */
function pruneOldRuns() {
  if (!fs.existsSync(RUNS)) return;
  const dayAgo = Date.now() / 1000 - 24 * 60 * 60;
  for (const name of fs.readdirSync(RUNS)) {
    const started = Number(name.split("-")[0]);
    if (Number.isFinite(started) && started < dayAgo) fs.rmSync(path.join(RUNS, name), { recursive: true, force: true });
  }
}

function checkInstalled() {
  const missing = [
    [TSX, "cd backend && npm ci"],
    [path.join(REPO, "node_modules", "next"), "npm ci (at the repo root)"],
  ].filter(([file]) => !fs.existsSync(file)).map(([, fix]) => fix);
  if (missing.length) throw new Error(`The stack's dependencies aren't installed. Run: ${missing.join("; ")}`);
}

/** The environment without the backend's own settings, which a shell or CI job may carry. */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const backendSettings = /^(DATABASE_URL|REDIS_URL|EVENT_BUS_|EMAIL_|ALPACA_|ANTHROPIC_|GOOGLE_|PAPERCLIP_|UPLOADS_|SF_|DISCORD_|OBSIDIAN_|VAULT_|SYNC_API_KEY|RUNNER_|AWS_|OS_ASK_|JWT_SECRET|SESSION_COOKIE_|FRONTEND_URL|HEARTHSIDE_URL|PORTFOLIO_ORIGINS|BACKEND_URL|NEXT_PUBLIC_|NODE_ENV|PORT$|HOSTNAME$|DEV_HOST$|SECONDARY_PORT$|TLS_)/;
  for (const key of Object.keys(env)) if (backendSettings.test(key)) delete env[key];
  return env;
}

/** Starts a stack, seeds the party, and returns it with the function that stops it. */
export async function startStack(): Promise<{ stack: Stack; stop: () => Promise<void> }> {
  checkInstalled();
  pruneOldRuns();
  const runId = `${Math.floor(Date.now() / 1000)}-${crypto.randomBytes(3).toString("hex")}`;
  const logs = path.join(RUNS, runId);
  fs.mkdirSync(logs, { recursive: true });

  const servers: Server[] = [];
  let databaseUrl = "";
  const stop = async () => {
    for (const s of servers) kill(s);
    if (databaseUrl) await runBackendScript(["scripts/e2e-database.ts", "drop", databaseUrl]).catch((e) => console.error(e.message));
  };

  try {
    const [backendPort, backendTlsPort, portfolioPort, portfolioSecondPort, hearthsidePort] = await freePorts(5);
    const portfolio = `https://${PROD.portfolio}:${portfolioPort}`;
    const hearthside = `https://${PROD.hearthside}:${hearthsidePort}`;
    const backend = `http://127.0.0.1:${backendPort}`;
    const tls = await makeCertificate(logs);
    const base = cleanEnv();
    const appEnv = { ...base, BACKEND_URL: backend, TLS_CERT_FILE: tls.cert, TLS_KEY_FILE: tls.key, NEXT_TELEMETRY_DISABLED: "1" };

    // The apps first: compiling takes longest, and they need nothing but the backend's address.
    const portfolioServer = startServer("portfolio", ["https-server.js"], path.join(REPO, "frontend"), {
      ...appEnv,
      PORT: String(portfolioPort),
      // The portfolio's container has a second listener (3001); here it's another free port.
      SECONDARY_PORT: String(portfolioSecondPort),
      HOSTNAME: "127.0.0.1",
    }, logs);
    servers.push(portfolioServer);
    const hearthsideServer = startServer("hearthside", ["https-server.js"], path.join(REPO, "hearthside"), {
      ...appEnv,
      PORT: String(hearthsidePort),
      DEV_HOST: "127.0.0.1",
      NEXT_PUBLIC_PORTFOLIO_URL: portfolio,
    }, logs);
    servers.push(hearthsideServer);

    const created = await runBackendScript(["scripts/e2e-database.ts", "create"]);
    databaseUrl = created.match(/^postgresql:\/\/\S+$/m)?.[0] ?? "";
    if (!databaseUrl) throw new Error(`e2e-database.ts printed no database URL:\n${created}`);
    const cookie = { name: PROD.cookieName, domain: `.${PARENT_DOMAIN}` };
    const backendServer = startServer("backend", [TSX, path.join(BACKEND, "server.ts")], logs, {
      ...base,
      // Not "development": the cookie is Secure and signup wants the email verified, as deployed.
      NODE_ENV: "test",
      TSX_TSCONFIG_PATH: path.join(BACKEND, "tsconfig.json"),
      DATABASE_URL: databaseUrl,
      JWT_SECRET: crypto.randomBytes(32).toString("hex"),
      HTTP_PORT: String(backendPort),
      // Only listened on if the folder has key.pem and cert.pem, which the run's folder hasn't; kept off 5001 anyway.
      HTTPS_PORT: String(backendTlsPort),
      SESSION_COOKIE_NAME: cookie.name,
      SESSION_COOKIE_DOMAIN: cookie.domain,
      SESSION_COOKIE_ORIGINS: [portfolio, hearthside].join(","),
      FRONTEND_URL: portfolio,
      HEARTHSIDE_URL: hearthside,
    }, logs);
    servers.push(backendServer);

    await waitFor(backendServer, `${backend}/health`, BACKEND_READY_MS);
    const party = await seedParty(backend);
    await Promise.all([
      waitFor(portfolioServer, `https://127.0.0.1:${portfolioPort}/`, APP_READY_MS, `${PROD.portfolio}:${portfolioPort}`),
      waitFor(hearthsideServer, `https://127.0.0.1:${hearthsidePort}/`, APP_READY_MS, `${PROD.hearthside}:${hearthsidePort}`),
    ]);

    return { stack: { runId, portfolio, hearthside, backend, cookie, databaseUrl, party, logs }, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}
