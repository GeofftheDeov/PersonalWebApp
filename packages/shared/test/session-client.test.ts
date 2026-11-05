/**
 * The session client (#210, spec #69), against a stand-in backend that
 * behaves like the real one where it matters: login sets an HttpOnly session
 * cookie, the profile and capabilities reads answer only with it (401
 * without), and logout clears it.
 *
 * A fetch with a cookie jar plays the browser. Nothing here touches storage:
 * "a reload" is a brand-new session client sharing only the jar, which is all
 * a reloaded page has.
 *
 *   cd packages/shared && npm test
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApiClient } from "@gtd/shared/api";
import {
  canAdmin, canPaperclip, createSessionClient, safeReturnTo,
  type SessionClientOptions,
} from "@gtd/shared/session";

const COOKIE = "gtd_session_t210";
const PASSWORD = "correct horse";
const USER = { _id: "acc-1", email: "gm@example.test", name: "", firstName: "Geoff", handle: "deov", profilePicture: null, bio: "GM" };

let server: http.Server;
let origin = "";
let sessions = new Set<string>();
let calls: { method: string; url: string; cookie: string; csrf: string }[] = [];

function send(res: http.ServerResponse, status: number, body?: unknown, headers: Record<string, string | string[]> = {}) {
  res.writeHead(status, { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

function sessionOf(req: http.IncomingMessage): string | null {
  const m = (req.headers.cookie ?? "").match(new RegExp(`(?:^|; )${COOKIE}=([^;]*)`));
  return m && sessions.has(m[1]) ? m[1] : null;
}

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      calls.push({ method: req.method ?? "", url: req.url ?? "", cookie: req.headers.cookie ?? "", csrf: String(req.headers["x-requested-with"] ?? "") });
      const body = raw ? JSON.parse(raw) : undefined;
      const issue = () => {
        const id = `s${sessions.size + 1}-${Math.random().toString(36).slice(2)}`;
        sessions.add(id);
        return send(res, 200, { token: "bearer-only.jwt", user: { id: USER._id } },
          { "set-cookie": `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax` });
      };
      switch (`${req.method} ${req.url}`) {
        case "POST /api/users/login":
          if (body?.password === "needs reset") return send(res, 403, { error: "Password not set", requiresReset: true });
          return body?.password === PASSWORD ? issue() : send(res, 401, { error: "Incorrect Password" });
        case "POST /api/users/google-login":
          return body?.idToken === "google-ok" ? issue() : send(res, 500, { error: "Google login failed" });
        case "POST /api/users/login-without-cookie":
          return send(res, 200, { token: "x", user: {} });
        case "POST /api/users/logout": {
          const id = sessionOf(req);
          if (id) sessions.delete(id);
          return send(res, 204, undefined, { "set-cookie": `${COOKIE}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT` });
        }
        case "GET /api/users/profile":
          return sessionOf(req) ? send(res, 200, USER) : send(res, 401, { error: "Unauthorized: No token provided" });
        case "GET /api/users/me/capabilities":
          return sessionOf(req)
            ? send(res, 200, { appRole: "admin", accountTier: "free", recordType: null, handle: "deov", profilePicture: null, paperclip: true })
            : send(res, 401, { error: "Unauthorized: No token provided" });
        case "GET /api/campaigns":
          return sessionOf(req) ? send(res, 200, []) : send(res, 401, { error: "Unauthorized: Invalid token" });
        default:
          return send(res, 404, { error: "Not found" });
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => { sessions = new Set(); calls = []; });

/** A browser's cookie handling, as far as these tests need it. */
function browser() {
  const jar = new Map<string, string>();
  const fetchWithJar: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(input, { ...init, headers });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const [name, value] = pair.split("=");
      if (!value || attrs.some((a) => /^\s*expires=thu, 01 jan 1970/i.test(a))) jar.delete(name.trim());
      else jar.set(name.trim(), value.trim());
    }
    return res;
  };
  return { jar, fetch: fetchWithJar };
}

function page(b: ReturnType<typeof browser>, at = "/dashboard", extra: Partial<SessionClientOptions> = {}) {
  const visits: string[] = [];
  let here = at;
  const session = createSessionClient({
    baseUrl: origin,
    fetch: b.fetch,
    currentUrl: () => here,
    navigate: (url) => { visits.push(url); here = url; },
    ...extra,
  });
  const api = createApiClient({ baseUrl: origin, fetch: b.fetch, onUnauthorized: () => session.expire() });
  return { session, api, visits, goTo: (url: string) => { here = url; } };
}

test("it starts loading, and with no cookie the backend's answer is signed out", async () => {
  const { session, visits } = page(browser());
  assert.equal(session.getState().status, "loading");
  const state = await session.ensure();
  assert.equal(state.status, "signedOut");
  assert.equal(state.user, null);
  assert.deepEqual(visits, [], "asking who's signed in never redirects");
});

test("login confirms the session through the cookie, and drops the body's token", async () => {
  const b = browser();
  const { session } = page(b);
  const user = await session.login("gm@example.test", PASSWORD);
  assert.equal(user.id, "acc-1", "the profile's _id becomes id");
  assert.equal(user.name, "Geoff", "an empty name falls back to the first name");
  assert.equal(user.bio, "GM", "other profile fields come through");
  const state = session.getState();
  assert.equal(state.status, "signedIn");
  assert.ok(canAdmin(state.capabilities));
  assert.ok(canPaperclip(state.capabilities));
  assert.ok(b.jar.has(COOKIE), "the browser holds the cookie");
  assert.ok(!JSON.stringify(state).includes("bearer-only.jwt"), "the token isn't kept anywhere");
});

test("every session call sends the CSRF header and no bearer token", async () => {
  const { session } = page(browser());
  await session.login("gm@example.test", PASSWORD);
  await session.logout();
  assert.ok(calls.length >= 4);
  for (const c of calls) assert.equal(c.csrf, "gtd", `${c.method} ${c.url}`);
});

test("after login, a reload (a fresh client, the same cookies) is still signed in", async () => {
  const b = browser();
  await page(b).session.login("gm@example.test", PASSWORD);
  const reloaded = page(b).session;
  const state = await reloaded.ensure();
  assert.equal(state.status, "signedIn");
  assert.equal(state.user?.email, "gm@example.test");
});

test("Google login works the same way", async () => {
  const b = browser();
  const { session } = page(b);
  await session.loginWithGoogle("google-ok");
  assert.equal(session.getState().status, "signedIn");
  assert.equal((await page(b).session.ensure()).status, "signedIn");
});

test("a refused login rejects with the server's error and leaves the state signed out", async () => {
  const { session, visits } = page(browser(), "/login");
  await session.ensure();
  await assert.rejects(session.login("gm@example.test", "wrong"), /Incorrect Password/);
  await assert.rejects(session.login("gm@example.test", "needs reset"),
    (err: any) => err.status === 403 && err.body?.requiresReset === true);
  assert.equal(session.getState().status, "signedOut");
  assert.deepEqual(visits, [], "a wrong password is not an expired session");
});

test("a login whose reply sets no cookie says so, rather than looking signed in", async () => {
  const { session } = page(browser());
  // Stand-in for a backend with SESSION_COOKIE_NAME unset.
  const noCookie = createSessionClient({
    baseUrl: origin,
    fetch: (input, init) => fetch(String(input).replace("/login", "/login-without-cookie"), init),
  });
  await assert.rejects(noCookie.login("gm@example.test", PASSWORD), /no session cookie/);
  assert.equal(noCookie.getState().status, "signedOut");
  assert.equal(session.getState().status, "loading");
});

test("logout asks the backend to clear the cookie, then clears the client", async () => {
  const b = browser();
  const { session } = page(b);
  await session.login("gm@example.test", PASSWORD);
  let changes = 0;
  session.subscribe(() => { changes++; });
  await session.logout();
  assert.ok(calls.some((c) => c.method === "POST" && c.url === "/api/users/logout"));
  assert.equal(session.getState().status, "signedOut");
  assert.ok(changes > 0, "subscribers hear it");
  assert.ok(!b.jar.has(COOKIE), "the cookie is gone");
  assert.equal((await page(b).session.ensure()).status, "signedOut", "and a reload is signed out too");
});

test("logging out on one site logs the other out: they share the parent-domain cookie", async () => {
  const b = browser();
  const portfolio = page(b).session;
  const hearthside = page(b, "/campaigns").session;
  await portfolio.login("gm@example.test", PASSWORD);
  assert.equal((await hearthside.ensure()).status, "signedIn");
  await portfolio.logout();
  assert.equal((await hearthside.refresh()).status, "signedOut");
});

test("a 401 from any call signs out and sends the person to log in, coming back here", async () => {
  const b = browser();
  const { session, api, visits } = page(b, "/game-night/campaigns/42?tab=sessions#notice-board");
  await session.login("gm@example.test", PASSWORD);
  sessions.clear(); // the token expired
  await Promise.all([
    assert.rejects(api.get("/api/campaigns")),
    assert.rejects(api.get("/api/campaigns")),
  ]);
  assert.equal(session.getState().status, "signedOut");
  assert.deepEqual(visits, ["/login?redirect=%2Fgame-night%2Fcampaigns%2F42%3Ftab%3Dsessions%23notice-board"],
    "once, however many calls failed");
});

test("after logging in again, a later expiry redirects again", async () => {
  const b = browser();
  const { session, api, visits, goTo } = page(b, "/dashboard");
  await session.login("gm@example.test", PASSWORD);
  sessions.clear();
  await assert.rejects(api.get("/api/campaigns"));
  goTo("/profile");
  await session.login("gm@example.test", PASSWORD);
  sessions.clear();
  await assert.rejects(api.get("/api/campaigns"));
  assert.deepEqual(visits, ["/login?redirect=%2Fdashboard", "/login?redirect=%2Fprofile"]);
});

test("on the login page itself a 401 doesn't redirect", async () => {
  const { session, api, visits } = page(browser(), "/login?redirect=%2Fdashboard");
  await assert.rejects(api.get("/api/campaigns"));
  assert.equal(session.getState().status, "signedOut");
  assert.deepEqual(visits, []);
});

test("loginUrl carries a safe return URL, and only a safe one", () => {
  const { session } = page(browser(), "/profile");
  assert.equal(session.loginUrl(), "/login?redirect=%2Fprofile");
  assert.equal(session.loginUrl("/game-night/join/7"), "/login?redirect=%2Fgame-night%2Fjoin%2F7");
  assert.equal(session.loginUrl("https://evil.example/"), "/login");
  assert.equal(session.loginUrl("/login?redirect=%2Fx"), "/login");
});

test("safeReturnTo keeps paths on this site and refuses everything else", () => {
  assert.equal(safeReturnTo("/dashboard?x=1#y"), "/dashboard?x=1#y");
  for (const bad of [null, undefined, "", "dashboard", "//evil.example", "/\\evil.example",
    "https://evil.example", "javascript:alert(1)", "/ok\nSet-Cookie: x"]) {
    assert.equal(safeReturnTo(bad as any), null, String(bad));
  }
});

test("ensure asks once; refresh asks again", async () => {
  const { session } = page(browser());
  await Promise.all([session.ensure(), session.ensure(), session.ensure()]);
  await session.ensure();
  const profileReads = () => calls.filter((c) => c.url === "/api/users/profile").length;
  assert.equal(profileReads(), 1);
  await session.refresh();
  assert.equal(profileReads(), 2);
});

test("a backend that can't answer isn't 'signed out': it stays loading and asks again until it answers", async () => {
  const b = browser();
  await page(b).session.login("gm@example.test", PASSWORD);
  let down = 2;
  const visits: string[] = [];
  const session = createSessionClient({
    baseUrl: origin,
    fetch: (input, init) => (down-- > 0 ? Promise.reject(new TypeError("fetch failed")) : b.fetch(input, init)),
    navigate: (url) => { visits.push(url); },
    currentUrl: () => "/dashboard",
    retryDelayMs: () => 5,
  });
  await session.ensure();
  assert.equal(session.getState().status, "loading", "a deploy or an outage doesn't sign anyone out");
  const signedIn = new Promise<void>((resolve) => session.subscribe(() => {
    if (session.getState().status === "signedIn") resolve();
  }));
  await signedIn;
  assert.deepEqual(visits, []);
});

test("capabilities failing alone still leave the person signed in, with no extra links", async () => {
  const b = browser();
  await page(b).session.login("gm@example.test", PASSWORD);
  const session = createSessionClient({
    baseUrl: origin,
    fetch: (input, init) => (String(input).endsWith("/me/capabilities")
      ? Promise.resolve(new Response(JSON.stringify({ error: "boom" }), { status: 500 }))
      : b.fetch(input, init)),
  });
  const state = await session.ensure();
  assert.equal(state.status, "signedIn");
  assert.ok(!canAdmin(state.capabilities));
  assert.ok(!canPaperclip(state.capabilities));
});

test("logout signs out at once, before the backend answers", async () => {
  const b = browser();
  const { session } = page(b);
  await session.login("gm@example.test", PASSWORD);
  const done = session.logout();
  assert.equal(session.getState().status, "signedOut", "a page navigated to straight after logout sees nobody");
  await done;
});
