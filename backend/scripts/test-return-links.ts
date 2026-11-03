/**
 * Reset, verify and Google Calendar links return to the site you came from
 * (#215, part of #69).
 *
 * The portfolio and Hearthside proxy /api to this one backend, so a request
 * reaches it carrying the browser's host in X-Forwarded-Host (Next's rewrite
 * proxy sets it from Host). The backend sends people back to that site, and
 * only to a site on its per-environment allowlist (utils/frontendSites.ts):
 *   - reset-password and verify-email links use the originating host, and an
 *     unknown host gets the environment's portfolio host;
 *   - Google Calendar Connect carries the originating host in its signed OAuth
 *     `state`, and the callback returns to that site's profile page (/profile
 *     on the portfolio, /room on Hearthside). A state whose host isn't on the
 *     allowlist, or whose payload was altered, is refused;
 *   - verifying an email logs the person in: a token in the body and the
 *     session cookie, so a player who signed up on Hearthside is signed in on
 *     both sites.
 *
 * Mounts the real routers and drives them over HTTP. No mail leaves the
 * machine: nodemailer's transport is swapped for one that records what it was
 * handed, before emailService loads. No Google call is made: the OAuth client
 * id and secret are dummies, and the callbacks driven here never carry a code
 * that would be exchanged.
 *
 * Run against a throwaway database loaded from db/schema.sql (it inserts and
 * deletes its own rows, and refuses to run against anything but localhost):
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-return-links.ts
 */
import "./use-test-jwt-secret.js";
import express from "express";
import type { AddressInfo } from "net";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import nodemailer from "nodemailer";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
  process.exit(2);
}

// Every mail emailService "sends" lands here. It builds its transport when it
// loads, so the swap comes first and the route modules are imported after it.
type Mail = { to: string; subject: string; html: string };
const outbox: Mail[] = [];
(nodemailer as any).createTransport = () => ({
  sendMail: async (m: Mail) => { outbox.push(m); return { response: "250 recorded by test-return-links" }; },
});

const { default: pool } = await import("../db/index.js");
const { default: userRoutes } = await import("../routes/userRoutes.js");
const { default: googleCalendarRoutes } = await import("../routes/googleCalendarRoutes.js");
const { signJwt, verifyJwt } = await import("../utils/jwt.js");

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  const d = typeof detail === "string" ? detail : JSON.stringify(detail);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !d ? "" : `\n          ${d}`}`);
  ok ? pass++ : fail++;
}

/** The sites of each environment, as the deploy workflows configure them. */
const PROD = {
  FRONTEND_URL: "https://geoffthedeov.net",
  PORTFOLIO_ORIGINS: "https://www.geoffthedeov.net",
  HEARTHSIDE_URL: "https://hearthside.geoffthedeov.net",
};
const DEV = {
  FRONTEND_URL: "https://deov.geoffthedeov.net",
  PORTFOLIO_ORIGINS: "",
  HEARTHSIDE_URL: "https://deov.hearthside.geoffthedeov.net",
};
const useEnv = (env: typeof PROD) => Object.assign(process.env, env);

const COOKIE = "gtd_session_t215";

/** The link in the last mail sent to `to`. */
const linkTo = (to: string) => {
  const mail = [...outbox].reverse().find((m) => m.to === to);
  return mail?.html.match(/href="([^"]+)"/)?.[1] ?? null;
};

async function main() {
  const app = express();
  app.use(express.json());
  app.use("/api/users", userRoutes);
  app.use("/api/google-calendar", googleCalendarRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /** A request as a site's Next proxy forwards it: the browser's host in X-Forwarded-Host. */
  const call = async (method: string, path: string, opts: { from?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      redirect: "manual",
      headers: {
        ...(opts.body ? { "content-type": "application/json" } : {}),
        ...(opts.from ? { "x-forwarded-host": opts.from } : {}),
        ...opts.headers,
      },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    });
    return {
      status: res.status,
      location: res.headers.get("location"),
      setCookie: res.headers.getSetCookie(),
      json: await res.json().catch(() => ({})) as any,
    };
  };

  // Mail goes out (to the recording transport), and the run is treated as
  // prod: registration sends its verification email only outside development.
  process.env.EMAIL_PASS = "t215-recorded";
  process.env.NODE_ENV = "production";
  process.env.GOOGLE_CLIENT_ID = "t215-client-id.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "t215-client-secret";
  delete process.env.GOOGLE_REDIRECT_URI;
  delete process.env.SESSION_COOKIE_DOMAIN;
  process.env.SESSION_COOKIE_NAME = COOKIE;

  const tag = crypto.randomBytes(4).toString("hex");
  const emails: string[] = [];
  const { rows: [person] } = await pool.query(
    `INSERT INTO accounts (id, name, email, password, is_verified)
     VALUES (gen_random_uuid(), 'Return Links', $1, $2, true) RETURNING id, email`,
    [`t215-reset-${tag}@example.test`, await bcrypt.hash(crypto.randomBytes(12).toString("hex"), 10)]);
  emails.push(person.email);
  const bearer = { authorization: `Bearer ${signJwt({ id: person.id, email: person.email }, { expiresIn: "1h" })}` };

  try {
    // ── reset-password links ─────────────────────────────────────────────────
    console.log("\nreset-password links\n");
    for (const [envName, env, hosts] of [
      ["prod", PROD, ["geoffthedeov.net", "www.geoffthedeov.net", "hearthside.geoffthedeov.net"]],
      ["dev", DEV, ["deov.geoffthedeov.net", "deov.hearthside.geoffthedeov.net"]],
    ] as const) {
      useEnv(env);
      for (const host of hosts) {
        const res = await call("POST", "/api/users/forgot-password", { from: host, body: { email: person.email } });
        const link = linkTo(person.email);
        check(`${envName}: a reset requested on ${host} links to https://${host}/reset-password`,
          res.status === 200 && !!link?.startsWith(`https://${host}/reset-password?token=`), `${res.status} ${link}`);
      }
    }

    useEnv(PROD);
    for (const [label, from] of [
      ["an unknown host", "evil.example"],
      ["the other environment's Hearthside", "deov.hearthside.geoffthedeov.net"],
      ["a lookalike of an allowed host", "hearthside.geoffthedeov.net.evil.example"],
      ["no forwarded host (the backend's own Host)", undefined],
    ] as const) {
      const res = await call("POST", "/api/users/forgot-password", { from, body: { email: person.email } });
      const link = linkTo(person.email);
      check(`prod: a reset requested from ${label} links to the portfolio host`,
        res.status === 200 && !!link?.startsWith("https://geoffthedeov.net/reset-password?token="), `${res.status} ${link}`);
    }

    const chained = await call("POST", "/api/users/forgot-password", {
      from: "hearthside.geoffthedeov.net, geoffthedeov.net", body: { email: person.email } });
    check("the first host of a chained X-Forwarded-Host is the one used",
      chained.status === 200 && !!linkTo(person.email)?.startsWith("https://hearthside.geoffthedeov.net/reset-password?token="),
      `${chained.status} ${linkTo(person.email)}`);

    const upper = await call("POST", "/api/users/forgot-password", { from: "Hearthside.GeofftheDeov.net", body: { email: person.email } });
    check("hosts match case-insensitively, and the link uses the allowlist's spelling",
      upper.status === 200 && !!linkTo(person.email)?.startsWith("https://hearthside.geoffthedeov.net/reset-password?token="),
      `${upper.status} ${linkTo(person.email)}`);
  } finally {
    await pool.query(`DELETE FROM accounts WHERE email = ANY($1)`, [emails]);
    server.close();
    await pool.end();
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
