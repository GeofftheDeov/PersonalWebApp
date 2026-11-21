/**
 * The dev environment, started alongside the run's stack for a test of the two
 * environments' cookies (#219, spec #69 stories 8 and 9).
 *
 *   dev backend   backend/server.ts with dev's cookie name (gtd_session_deov),
 *                 its own JWT secret and its own database, on the same parent
 *                 domain as the stack's prod-named cookie, as deployed
 *   dev Hearthside https://deov.hearthside.geoffthedeov.test:<port>, an edge
 *                 that sends /api to the dev backend and everything else to
 *                 the stack's Hearthside app server
 *
 * Hearthside's pages are the same in both environments; what decides who's
 * signed in is the backend behind /api, which is what this swaps. (A second
 * Hearthside dev server can't share the app's .next folder, and a production
 * build would take minutes.)
 *
 *   const dev = await startDevEnvironment(stack);
 *   try { … dev.hearthside … } finally { await dev.stop(); }
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import type { Duplex } from "node:stream";
import { DEV, PARENT_DOMAIN } from "./hosts";
import { BACKEND, TSX, cleanEnv, freePorts, kill, runBackendScript, startServer, waitFor, type Stack } from "./stack";

export interface DevEnvironment {
  /** Dev Hearthside's origin, e.g. https://deov.hearthside.geoffthedeov.test:51240. */
  hearthside: string;
  /** The dev backend, straight (http://127.0.0.1:<port>). */
  backend: string;
  /** Dev's session cookie name. */
  cookieName: string;
  stop(): Promise<void>;
}

export async function startDevEnvironment(stack: Stack): Promise<DevEnvironment> {
  const [backendPort, backendTlsPort, edgePort] = await freePorts(3);
  const hearthside = `https://${DEV.hearthside}:${edgePort}`;
  const backend = `http://127.0.0.1:${backendPort}`;
  const app = new URL(stack.hearthside);
  // Its own folder, as the stack's backend has, so no backend/.env reaches it.
  const logs = path.join(stack.logs, `dev-${crypto.randomBytes(3).toString("hex")}`);
  fs.mkdirSync(logs, { recursive: true });

  let databaseUrl = "";
  let server: ReturnType<typeof startServer> | null = null;
  let edge: https.Server | null = null;
  const stop = async () => {
    if (edge) await new Promise((r) => { edge!.closeAllConnections(); edge!.close(r); });
    if (server) kill(server);
    if (databaseUrl) await runBackendScript(["scripts/e2e-database.ts", "drop", databaseUrl]).catch(() => {});
  };

  try {
    databaseUrl = (await runBackendScript(["scripts/e2e-database.ts", "create"])).match(/^postgresql:\/\/\S+$/m)?.[0] ?? "";
    if (!databaseUrl) throw new Error("e2e-database.ts printed no database URL");
    server = startServer("dev-backend", [TSX, path.join(BACKEND, "server.ts")], logs, {
      ...cleanEnv(),
      NODE_ENV: "test",
      TSX_TSCONFIG_PATH: path.join(BACKEND, "tsconfig.json"),
      DATABASE_URL: databaseUrl,
      // Dev and prod sign with different secrets (spec #69).
      JWT_SECRET: crypto.randomBytes(32).toString("hex"),
      HTTP_PORT: String(backendPort),
      HTTPS_PORT: String(backendTlsPort),
      SESSION_COOKIE_NAME: DEV.cookieName,
      SESSION_COOKIE_DOMAIN: `.${PARENT_DOMAIN}`,
      SESSION_COOKIE_ORIGINS: hearthside,
      FRONTEND_URL: `https://${DEV.portfolio}:${edgePort}`,
      HEARTHSIDE_URL: hearthside,
    }, logs);

    const tls = { cert: fs.readFileSync(path.join(stack.logs, "cert.pem")), key: fs.readFileSync(path.join(stack.logs, "key.pem")) };
    /** Where a request goes: the dev backend for /api, else the app server. */
    const upstream = (req: http.IncomingMessage) => {
      const toBackend = (req.url ?? "").startsWith("/api/");
      const options = {
        hostname: "127.0.0.1",
        port: toBackend ? backendPort : Number(app.port),
        path: req.url,
        method: req.method,
        // As Next's rewrite proxy does, the browser's host goes along for the backend's links.
        headers: toBackend ? { ...req.headers, "x-forwarded-host": req.headers.host, "x-forwarded-proto": "https" } : req.headers,
        rejectUnauthorized: false,
      };
      return toBackend ? http.request(options) : https.request(options);
    };
    edge = https.createServer(tls, (req, res) => {
      const out = upstream(req);
      out.on("response", (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
      out.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(out);
    });
    // WebSockets too: the app's hot reloading, and the live channel.
    edge.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      const out = upstream(req);
      out.on("upgrade", (r, up, upHead) => {
        const lines = [`HTTP/1.1 ${r.statusCode} ${r.statusMessage}`];
        for (let i = 0; i < r.rawHeaders.length; i += 2) lines.push(`${r.rawHeaders[i]}: ${r.rawHeaders[i + 1]}`);
        socket.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (upHead.length) socket.write(upHead);
        if (head.length) up.write(head);
        up.pipe(socket).pipe(up);
        up.on("error", () => socket.destroy());
        socket.on("error", () => up.destroy());
      });
      out.on("response", (r) => { socket.end(`HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\n\r\n`); });
      out.on("error", () => socket.destroy());
      out.end();
    });
    await new Promise<void>((resolve, reject) => { edge!.once("error", reject); edge!.listen(edgePort, "127.0.0.1", resolve); });

    await waitFor(server, `${backend}/health`, 60_000);
    return { hearthside, backend, cookieName: DEV.cookieName, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}
