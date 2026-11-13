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
 *     both sites. Only in the browser that signed up, though (#219): signing
 *     up sets a short-lived signup cookie bound to the new account, and verify
 *     signs in only when it carries that cookie. Anywhere else the link still
 *     verifies, and the person signs in next. Otherwise someone who signed up
 *     with your email could have you click their link into their account.
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
const { default: leadRoutes } = await import("../routes/leadRoutes.js");
const { default: googleCalendarRoutes } = await import("../routes/googleCalendarRoutes.js");
const { signJwt, verifyJwt } = await import("../utils/jwt.js");
const { signupCookieValue } = await import("../utils/signupCookie.js");

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  const d = typeof detail === "string" ? detail : JSON.stringify(detail);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !d ? "" : `\n          ${d}`}`);
  ok ? pass++ : fail++;
}

/**
 * The sites of each environment once Hearthside is deployed. The workflows set
 * FRONTEND_URL and (prod) PORTFOLIO_ORIGINS today; HEARTHSIDE_URL arrives with
 * Hearthside's deploy (#214, #217), and until then no host counts as Hearthside.
 */
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
const SIGNUP_COOKIE = `${COOKIE}_signup`;

/** `name=value` of the cookie called `name` in these Set-Cookie headers, or "". */
const cookiePair = (setCookie: string[], name: string) =>
  setCookie.find((c) => c.startsWith(`${name}=`))?.split(";")[0] ?? "";

/** The link in the last mail sent to `to`. */
const linkTo = (to: string) => {
  const mail = [...outbox].reverse().find((m) => m.to === to);
  return mail?.html.match(/href="([^"]+)"/)?.[1] ?? null;
};

async function main() {
  const app = express();
  app.use(express.json());
  app.use("/api/users", userRoutes);
  app.use("/api/leads", leadRoutes);
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

    // ── verify-email links ───────────────────────────────────────────────────
    console.log("\nverify-email links\n");
    /** Sign up through `route` from `from`; returns the email and the link it was sent. */
    const signUp = async (route: "register" | "leads", from: string | undefined) => {
      const email = `t215-${route}-${crypto.randomBytes(4).toString("hex")}@example.test`;
      emails.push(email);
      const password = crypto.randomBytes(12).toString("hex");
      const res = route === "register"
        ? await call("POST", "/api/users/register", { from, body: { name: "Signup", email, password } })
        : await call("POST", "/api/leads", { from, body: { firstName: "Sign", lastName: "Up", email, password } });
      return {
        status: res.status, email, password, link: linkTo(email),
        token: new URL(linkTo(email) ?? "http://x/").searchParams.get("token") ?? "",
        /** The Set-Cookie header for the signup cookie, as the browser that signed up received it. */
        signupSetCookie: res.setCookie.find((c) => c.startsWith(`${SIGNUP_COOKIE}=`)) ?? "",
        /** What that browser sends back. */
        signupCookie: cookiePair(res.setCookie, SIGNUP_COOKIE),
      };
    };

    for (const [envName, env, hosts] of [
      ["prod", PROD, ["geoffthedeov.net", "www.geoffthedeov.net", "hearthside.geoffthedeov.net"]],
      ["dev", DEV, ["deov.geoffthedeov.net", "deov.hearthside.geoffthedeov.net"]],
    ] as const) {
      useEnv(env);
      for (const host of hosts) {
        const r = await signUp("register", host);
        check(`${envName}: signing up on ${host} sends a verify link to https://${host}/verify-email`,
          r.status === 201 && !!r.link?.startsWith(`https://${host}/verify-email?token=`), `${r.status} ${r.link}`);
      }
    }
    useEnv(PROD);
    const leadOnHearthside = await signUp("leads", "hearthside.geoffthedeov.net");
    check("the create-account signup (/api/leads) links back to its site too",
      leadOnHearthside.status === 201 && !!leadOnHearthside.link?.startsWith("https://hearthside.geoffthedeov.net/verify-email?token="),
      `${leadOnHearthside.status} ${leadOnHearthside.link}`);
    const unknownSignup = await signUp("register", "evil.example");
    check("prod: signing up from an unknown host sends a verify link to the portfolio host",
      unknownSignup.status === 201 && !!unknownSignup.link?.startsWith("https://geoffthedeov.net/verify-email?token="),
      `${unknownSignup.status} ${unknownSignup.link}`);

    // ── verify-email logs you in, in the browser that signed up ──────────────
    console.log("\nverify-email logs you in, only in the browser that signed up (#219)\n");
    const issuesSession = (r: { setCookie: string[] }) => r.setCookie.some((c) => c.startsWith(`${COOKIE}=`) && !/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c));
    /** Verify `token`, sending `cookie` as the browser would (or nothing, as another browser would). */
    const verify = (token: string, cookie?: string) =>
      call("POST", "/api/users/verify-email", { from: "hearthside.geoffthedeov.net", body: { token }, headers: cookie ? { cookie } : {} });
    const isVerified = async (email: string) =>
      (await pool.query(`SELECT is_verified FROM accounts WHERE email = $1`, [email])).rows[0]?.is_verified === true;

    const player = await signUp("register", "hearthside.geoffthedeov.net");
    const attrs = player.signupSetCookie.split(";").map((p) => p.trim().toLowerCase());
    const maxAge = Number(attrs.find((a) => a.startsWith("max-age="))?.slice(8));
    check("signing up sets a signup cookie: HttpOnly, Secure, SameSite=Lax, on this host only, for /api/users",
      !!player.signupCookie && attrs.includes("httponly") && attrs.includes("secure") && attrs.includes("samesite=lax")
        && !attrs.some((a) => a.startsWith("domain=")) && attrs.includes("path=/api/users"),
      player.signupSetCookie || "(none)");
    check("...short-lived: gone within the day the verify email promises",
      maxAge > 0 && maxAge <= 24 * 60 * 60, player.signupSetCookie);
    check("...and it isn't the session: signing up signs nobody in", !issuesSession({ setCookie: [player.signupSetCookie] }));

    const verified = await verify(player.token, player.signupCookie);
    const issued = verified.setCookie.find((c) => c.startsWith(`${COOKIE}=`)) ?? "";
    check("verifying in the browser that signed up returns a token and the person, as login does",
      verified.status === 200 && typeof verified.json.token === "string" && verified.json.user?.email === player.email,
      `${verified.status} ${JSON.stringify(verified.json).slice(0, 160)}`);
    // The cookie holds its own token, not the body's (#212: it's marked so it works only as the cookie).
    const cookieToken = decodeURIComponent(issued.slice(COOKIE.length + 1).split(";")[0] ?? "");
    check("...and sets the session cookie, marked as the cookie's own (#212)",
      cookieToken.split(".").length === 3 && cookieToken !== verified.json.token
        && (verifyJwt(cookieToken, { fromCookie: true }) as any).cookie === true && !("cookie" in verifyJwt(verified.json.token)),
      issued || "(none)");
    const me = await call("GET", "/api/users/profile", { headers: { cookie: `${COOKIE}=${cookieToken}` } });
    check("...which signs the new player in", me.status === 200 && me.json.email === player.email, `${me.status}`);
    check("...and clears the signup cookie, which has done its job",
      verified.setCookie.some((c) => c.startsWith(`${SIGNUP_COOKIE}=;`) || (c.startsWith(`${SIGNUP_COOKIE}=`) && /Expires=Thu, 01 Jan 1970/i.test(c))),
      JSON.stringify(verified.setCookie));

    const again = await verify(player.token, player.signupCookie);
    check("a verify link works once: used again it issues no token and no cookie",
      again.status === 400 && !again.json.token && !issuesSession(again),
      `${again.status} ${JSON.stringify(again.json)} ${JSON.stringify(again.setCookie)}`);

    // The attack this closes: someone signs up with your email and their own
    // password, and you click the real link. You'd be signed into their account.
    const victim = await signUp("register", "hearthside.geoffthedeov.net");
    const elsewhere = await verify(victim.token);
    check("verifying in another browser (no signup cookie) verifies the email...",
      elsewhere.status === 200 && await isVerified(victim.email), `${elsewhere.status} ${JSON.stringify(elsewhere.json)}`);
    check("...but returns only the message: no token, no person, no session cookie",
      typeof elsewhere.json.message === "string" && !elsewhere.json.token && !elsewhere.json.user && !issuesSession(elsewhere),
      `${JSON.stringify(elsewhere.json)} ${JSON.stringify(elsewhere.setCookie)}`);

    // Signup cookies that aren't this account's, or aren't genuine.
    const other = await signUp("register", "hearthside.geoffthedeov.net");
    const target = await signUp("register", "hearthside.geoffthedeov.net");
    const theirs = await verify(target.token, other.signupCookie);
    check("a signup cookie bound to another account signs nobody in (the email is still verified)",
      theirs.status === 200 && !theirs.json.token && !theirs.json.user && !issuesSession(theirs) && await isVerified(target.email),
      `${theirs.status} ${JSON.stringify(theirs.json)}`);

    const { rows: [targetRow] } = await pool.query(`SELECT id FROM accounts WHERE email = $1`, [target.email]);
    const { rows: [otherRow] } = await pool.query(`SELECT id FROM accounts WHERE email = $1`, [other.email]);
    const forgedTarget = await signUp("register", "hearthside.geoffthedeov.net");
    const { rows: [forgedRow] } = await pool.query(`SELECT id FROM accounts WHERE email = $1`, [forgedTarget.email]);
    const otherValue = decodeURIComponent(other.signupCookie.slice(SIGNUP_COOKIE.length + 1));
    const swapped = otherValue.split(String(otherRow.id)).join(String(forgedRow.id));
    const forgedVerify = await verify(forgedTarget.token, `${SIGNUP_COOKIE}=${encodeURIComponent(swapped)}`);
    check("a signup cookie edited to name another account is refused",
      swapped !== otherValue && forgedVerify.status === 200 && !forgedVerify.json.token && !issuesSession(forgedVerify),
      `${swapped} ${forgedVerify.status} ${JSON.stringify(forgedVerify.json)}`);

    const expiredFor = await signUp("register", "hearthside.geoffthedeov.net");
    const { rows: [expiredRow] } = await pool.query(`SELECT id FROM accounts WHERE email = $1`, [expiredFor.email]);
    const expired = await verify(expiredFor.token, `${SIGNUP_COOKIE}=${encodeURIComponent(signupCookieValue(String(expiredRow.id), Date.now() - 1000))}`);
    check("an expired signup cookie (genuinely signed, past its time) signs nobody in",
      expired.status === 200 && !expired.json.token && !issuesSession(expired), `${expired.status} ${JSON.stringify(expired.json)}`);

    const sessionAsSignup = await signUp("register", "hearthside.geoffthedeov.net");
    const { rows: [sessionRow] } = await pool.query(`SELECT id FROM accounts WHERE email = $1`, [sessionAsSignup.email]);
    const aJwt = signJwt({ id: sessionRow.id, email: sessionAsSignup.email, cookie: true }, { expiresIn: "1h" });
    const jwtSignup = await verify(sessionAsSignup.token, `${SIGNUP_COOKIE}=${encodeURIComponent(aJwt)}`);
    check("a session token passed off as the signup cookie signs nobody in",
      jwtSignup.status === 200 && !jwtSignup.json.token && !issuesSession(jwtSignup), `${jwtSignup.status} ${JSON.stringify(jwtSignup.json)}`);

    // The signup cookie names an account, so it must be good for nothing else.
    const fresh = await signUp("register", "hearthside.geoffthedeov.net");
    const freshValue = decodeURIComponent(fresh.signupCookie.slice(SIGNUP_COOKIE.length + 1));
    const asBearer = await call("GET", "/api/users/profile", { headers: { authorization: `Bearer ${freshValue}` } });
    const asSession = await call("GET", "/api/users/profile", { headers: { cookie: `${COOKIE}=${encodeURIComponent(freshValue)}` } });
    check("the signup cookie is no login: refused as a bearer and as the session cookie",
      asBearer.status === 401 && asSession.status === 401, `${asBearer.status} ${asSession.status}`);
    let notAJwt = false;
    try { verifyJwt(freshValue, { fromCookie: true }); } catch { notAJwt = true; }
    check("...and isn't a JWT at all, so nothing that takes one can take it", notAJwt, freshValue);

    const lead = await signUp("leads", "hearthside.geoffthedeov.net");
    const leadVerified = await verify(lead.token, lead.signupCookie);
    check("the create-account signup (/api/leads) sets the signup cookie too, and its verify signs in",
      !!lead.signupCookie && leadVerified.status === 200 && leadVerified.json.user?.email === lead.email && issuesSession(leadVerified),
      `${lead.signupSetCookie || "(no signup cookie)"} ${leadVerified.status}`);

    // A verify link from long ago still verifies, but signs nobody in, even in
    // the browser that signed up: the token has no expiry of its own, so it
    // mustn't become a standing login.
    const late = await signUp("register", "hearthside.geoffthedeov.net");
    await pool.query(`UPDATE accounts SET created_at = now() - interval '25 hours' WHERE email = $1`, [late.email]);
    const lateVerify = await verify(late.token, late.signupCookie);
    check("a verify link used over a day after signing up verifies, with no token and no cookie",
      lateVerify.status === 200 && await isVerified(late.email) && !lateVerify.json.token && !issuesSession(lateVerify),
      `${lateVerify.status} ${JSON.stringify(lateVerify.json)}`);

    const loginAfter = await call("POST", "/api/users/login", { body: { email: player.email, password: player.password } });
    check("the verified player can log in with their password", loginAfter.status === 200, `${loginAfter.status}`);
    const victimLogin = await call("POST", "/api/users/login", { body: { email: victim.email, password: victim.password } });
    check("...and so can one who verified in another browser", victimLogin.status === 200, `${victimLogin.status}`);

    // With the session cookie off (bearer-only), there's no signup cookie, and verify signs nobody in.
    delete process.env.SESSION_COOKIE_NAME;
    const noCookies = await signUp("register", "hearthside.geoffthedeov.net");
    const noCookiesVerify = await verify(noCookies.token);
    process.env.SESSION_COOKIE_NAME = COOKIE;
    check("with the session cookie off, signup sets no signup cookie and verify returns only the message",
      noCookies.signupSetCookie === "" && noCookies.status === 201 && noCookiesVerify.status === 200 && !noCookiesVerify.json.token,
      `${noCookies.signupSetCookie} ${JSON.stringify(noCookiesVerify.json)}`);

    // ── Google Calendar Connect ──────────────────────────────────────────────
    console.log("\nGoogle Calendar Connect\n");
    /** Start Connect from `from` and return the signed state it hands Google. */
    const startConnect = async (from: string | undefined, query = "") => {
      const res = await call("GET", `/api/google-calendar/auth-url${query}`, { from, headers: bearer });
      return { status: res.status, state: res.json.url ? new URL(res.json.url).searchParams.get("state") ?? "" : "" };
    };
    /** Google sending the person back. `error=access_denied` keeps the run away from Google's token endpoint. */
    const callback = (state: string, extra = "error=access_denied") =>
      call("GET", `/api/google-calendar/callback?state=${encodeURIComponent(state)}&${extra}`);

    for (const [envName, env, from, back] of [
      ["prod", PROD, "hearthside.geoffthedeov.net", "https://hearthside.geoffthedeov.net/room"],
      ["prod", PROD, "geoffthedeov.net", "https://geoffthedeov.net/profile"],
      ["prod", PROD, "www.geoffthedeov.net", "https://www.geoffthedeov.net/profile"],
      ["dev", DEV, "deov.hearthside.geoffthedeov.net", "https://deov.hearthside.geoffthedeov.net/room"],
      ["dev", DEV, "deov.geoffthedeov.net", "https://deov.geoffthedeov.net/profile"],
    ] as const) {
      useEnv(env);
      const started = await startConnect(from);
      const done = await callback(started.state);
      check(`${envName}: Connect started on ${from} comes back to ${back}`,
        started.status === 200 && done.status === 302 && done.location === `${back}?gcal=denied`,
        `${started.status} ${done.status} ${done.location}`);
    }

    useEnv(PROD);
    const fromUnknown = await startConnect("evil.example");
    const unknownBack = await callback(fromUnknown.state);
    check("prod: Connect started from an unknown host comes back to the portfolio's /profile",
      unknownBack.location === "https://geoffthedeov.net/profile?gcal=denied", `${unknownBack.status} ${unknownBack.location}`);

    const portfolioTab = await callback((await startConnect("www.geoffthedeov.net", "?return=availability")).state);
    check("the portfolio's availability tab rides along to its /profile",
      portfolioTab.location === "https://www.geoffthedeov.net/profile?gcal=denied&tab=availability", `${portfolioTab.location}`);

    const withTab = await startConnect("hearthside.geoffthedeov.net", "?return=availability");
    const tabBack = await callback(withTab.state);
    check("...but not to Hearthside's /room, which has no such tab",
      tabBack.location === "https://hearthside.geoffthedeov.net/room?gcal=denied", `${tabBack.location}`);

    const noCode = await callback(withTab.state, "");
    check("a callback with neither code nor error is an error on the site it started from",
      noCode.location === "https://hearthside.geoffthedeov.net/room?gcal=error", `${noCode.location}`);

    const authUrl = await call("GET", "/api/google-calendar/auth-url", { from: "hearthside.geoffthedeov.net", headers: bearer });
    check("Google still comes back through the portfolio's one redirect URI",
      new URL(authUrl.json.url).searchParams.get("redirect_uri") === "https://geoffthedeov.net/api/google-calendar/callback",
      `${authUrl.json.url}`);

    // Tampering: a state's host must be one we'd have put there ourselves. These
    // callbacks say the person declined, which an accepted state would answer
    // with gcal=denied on its site; a refused one is gcal=error on the portfolio.
    const forged = signJwt({ id: person.id, purpose: "gcal-connect", host: "evil.example" }, { expiresIn: "10m" });
    const forgedBack = await callback(forged);
    check("a signed state naming a host off the allowlist is refused: an error on the portfolio",
      forgedBack.location === "https://geoffthedeov.net/profile?gcal=error", `${forgedBack.status} ${forgedBack.location}`);

    const [h, payload, sig] = (await startConnect("geoffthedeov.net")).state.split(".");
    const altered = JSON.parse(Buffer.from(payload, "base64url").toString());
    altered.host = "hearthside.geoffthedeov.net";
    const tampered = `${h}.${Buffer.from(JSON.stringify(altered)).toString("base64url")}.${sig}`;
    const tamperedBack = await callback(tampered);
    check("a state whose host was edited after signing is refused: an error on the portfolio",
      tamperedBack.location === "https://geoffthedeov.net/profile?gcal=error", `${tamperedBack.status} ${tamperedBack.location}`);

    const otherEnv = signJwt({ id: person.id, purpose: "gcal-connect", host: "deov.hearthside.geoffthedeov.net" }, { expiresIn: "10m" });
    const otherEnvBack = await callback(otherEnv);
    check("prod refuses a state naming the dev Hearthside host",
      otherEnvBack.location === "https://geoffthedeov.net/profile?gcal=error", `${otherEnvBack.location}`);

    const legacy = signJwt({ id: person.id, purpose: "gcal-connect" }, { expiresIn: "10m" });
    const legacyBack = await callback(legacy);
    check("a state from before this change (no host) still comes back to the portfolio",
      legacyBack.location === "https://geoffthedeov.net/profile?gcal=denied", `${legacyBack.location}`);

    const hearthsideState = (await startConnect("hearthside.geoffthedeov.net")).state;
    check("the state carries the originating host",
      (verifyJwt(hearthsideState) as any).host === "hearthside.geoffthedeov.net", JSON.stringify(verifyJwt(hearthsideState)));
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
