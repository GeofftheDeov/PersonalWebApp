/**
 * Live channel session cookie (#107, spec #58; cookie from #69): a browser
 * signed in by cookie opens the live channel with no first-frame token.
 *
 * Real WebSocket clients against a real HTTP server with the live channel
 * attached, the in-memory event bus (REDIS_URL unset). Covers:
 *   - this environment's cookie, from an allowed Origin, authenticates the
 *     upgrade with no auth frame, and the socket gets that person's threads;
 *   - only the other environment's cookie name: refused with 4001;
 *   - an expired cookie, a wrong-secret cookie and one naming no account:
 *     refused with 4001 at once, not after the auth timeout;
 *   - the Origin check: a valid cookie from an origin not in
 *     SESSION_COOKIE_ORIGINS, or with no Origin, or with the allowlist unset,
 *     is ignored (4001 on the auth timeout), while a first-frame token on the
 *     same upgrade still works;
 *   - SESSION_COOKIE_NAME unset: the cookie is off on upgrades too;
 *   - first-frame and query-string tokens still work with no cookie;
 *   - a cookie and an auth frame on one socket: one `ready`, as the cookie's person;
 *   - the shared client (frontend/src/lib/realtime/liveClient.ts): with
 *     `cookieAuth` and no token it connects and gets `ready`; without
 *     `cookieAuth` and no token it stays idle.
 *
 * Run against a throwaway database loaded from db/schema.sql (it refuses to run
 * against anything but localhost). It deletes every row it creates.
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-live-cookie.ts
 */
import "./use-test-jwt-secret.js";
import crypto from "crypto";
import http from "http";
import type { AddressInfo } from "net";
import WebSocket from "ws";
import pool from "../db/index.js";
import { signJwt } from "../utils/jwt.js";
import { attachLiveChannel, LIVE_PATH, CLOSE_UNAUTHORIZED, PROTOCOL_VERSION } from "../live/liveChannel.js";
import { campaignThreadKey } from "../services/threads.js";

type LiveClientLike = {
  status: string;
  onStatus(listener: (status: string) => void): () => void;
  subscribe(thread: string, handlers: { onMessage?: (m: unknown) => void }): () => void;
  threadStatus(thread: string): string;
  close(): void;
};
type LiveClientCtor = new (opts: {
  url: string; getToken: () => string | null; cookieAuth?: boolean; WebSocket: unknown;
}) => LiveClientLike;
/** Loaded by path at run time: the backend's Docker build sees only backend/. */
const LIVE_CLIENT = new URL("../../frontend/src/lib/realtime/liveClient.ts", import.meta.url).href;

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
  process.exit(2);
}

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? pass++ : fail++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
  return cond();
}

const RUN = Math.random().toString(36).slice(2, 8);
const NAME = "gtd_session_t107";
const OTHER_ENV_NAME = "gtd_session_t107_other";
const ORIGIN = "https://deov.example.test";
const SIBLING = "https://hearthside.example.test";
const AUTH_TIMEOUT_MS = 600;

type Person = { id: string; email: string };
const created = { accounts: [] as string[], campaigns: [] as string[] };

async function account(handle: string): Promise<Person> {
  const { rows } = await pool.query(
    `INSERT INTO accounts (id, handle, name, email, app_role)
     VALUES (gen_random_uuid(), $1, $2, $3, 'user') RETURNING id, email`,
    [`t107-${handle}-${RUN}`, `${handle} name`, `t107.${handle}.${RUN}@example.test`]);
  created.accounts.push(rows[0].id);
  return { id: rows[0].id, email: rows[0].email };
}

async function campaignWith(...people: Person[]): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO campaigns (title, status) VALUES ($1, 'In Progress') RETURNING id`, [`t107 ${RUN}`]);
  created.campaigns.push(rows[0].id);
  for (const p of people) {
    await pool.query(`INSERT INTO campaign_members (campaign_id, person_id, status) VALUES ($1, $2, 'Active')`,
      [rows[0].id, p.id]);
  }
  return rows[0].id;
}

async function cleanup() {
  const { accounts, campaigns } = created;
  await pool.query(`DELETE FROM campaigns WHERE id = ANY($1::uuid[])`, [campaigns]);
  await pool.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [accounts]);
}

const tokenFor = (p: Person) => signJwt({ id: p.id, email: p.email });
const expiredTokenFor = (p: Person) =>
  signJwt({ id: p.id, email: p.email, exp: Math.floor(Date.now() / 1000) - 60 });
function wrongSecretToken(p: Person): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ id: p.id, email: p.email, iat: Math.floor(Date.now() / 1000) })}`;
  return `${head}.${crypto.createHmac("sha256", "not-the-secret").update(head).digest("base64url")}`;
}

type Frame = { type: string; [k: string]: any };

/** A raw client: optional Cookie and Origin headers, an optional first frame. */
function client(url: string, opts: { cookie?: string; origin?: string; first?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.origin) headers.origin = opts.origin;
  const ws = new WebSocket(url, { headers });
  const frames: Frame[] = [];
  const opened = Date.now();
  let closeCode: number | null = null, closeReason = "", closedAfter = -1;
  ws.on("close", (code, reason) => { closeCode = code; closeReason = String(reason); closedAfter = Date.now() - opened; });
  ws.on("error", () => { /* surfaces as close */ });
  ws.on("open", () => { if (opts.first !== undefined) ws.send(JSON.stringify(opts.first)); });
  ws.on("message", (data) => {
    try { frames.push(JSON.parse(String(data))); } catch { /* not ours */ }
  });
  return {
    ws, frames,
    get closeCode() { return closeCode; },
    get closeReason() { return closeReason; },
    get closedAfter() { return closedAfter; },
    ready: () => until(() => frames.some((f) => f.type === "ready")),
    closed: () => until(() => closeCode !== null),
    readies: () => frames.filter((f) => f.type === "ready"),
  };
}

async function main() {
  process.env.SESSION_COOKIE_NAME = NAME;
  process.env.SESSION_COOKIE_ORIGINS = ` ${ORIGIN}/ , ${SIBLING.toUpperCase()}`;

  const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const live = await attachLiveChannel(server, { authTimeoutMs: AUTH_TIMEOUT_MS });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${LIVE_PATH}`;
  const opened: ReturnType<typeof client>[] = [];
  const open = (opts: Parameters<typeof client>[1] = {}) => { const c = client(wsUrl, opts); opened.push(c); return c; };

  try {
    const ann = await account("ann");
    const bob = await account("bob");
    const annCampaign = await campaignWith(ann);
    const bobCampaign = await campaignWith(bob);
    const cookie = (token: string, name = NAME) => `theme=dark; ${name}=${encodeURIComponent(token)}; other=1`;
    const auth = (p: Person) => ({ type: "auth", v: PROTOCOL_VERSION, token: tokenFor(p) });

    console.log("\n  this environment's cookie, allowed origin");
    {
      const c = open({ cookie: cookie(tokenFor(ann)), origin: ORIGIN });
      check("authenticated with no auth frame", await c.ready());
      const threads: string[] = c.readies()[0]?.threads ?? [];
      check("ready lists the cookie person's campaign", threads.includes(campaignThreadKey(annCampaign)), JSON.stringify(threads));
      check("and not someone else's", !threads.includes(campaignThreadKey(bobCampaign)));
      await sleep(AUTH_TIMEOUT_MS + 200);
      check("still open after the auth timeout", c.closeCode === null, `closed ${c.closeCode} ${c.closeReason}`);

      const s = open({ cookie: cookie(tokenFor(bob)), origin: SIBLING });
      check("a second allowed origin (case and spacing in the list ignored)", await s.ready());
    }

    console.log("\n  refused cookies");
    {
      const other = open({ cookie: cookie(tokenFor(ann), OTHER_ENV_NAME), origin: ORIGIN });
      check("only the other environment's cookie name: closed 4001", (await other.closed()) && other.closeCode === CLOSE_UNAUTHORIZED,
        `code ${other.closeCode}`);
      check("  (it was never read: the handshake waited for an auth frame)", other.closeReason === "auth timeout", other.closeReason);

      for (const [label, token] of [
        ["expired", expiredTokenFor(ann)],
        ["wrong secret", wrongSecretToken(ann)],
        ["names no account", signJwt({ id: crypto.randomUUID(), email: "nobody@example.test" })],
        ["not a JWT", "garbage"],
      ] as const) {
        const c = open({ cookie: cookie(token), origin: ORIGIN });
        await c.closed();
        check(`${label} cookie: closed 4001 at once`,
          c.closeCode === CLOSE_UNAUTHORIZED && c.closeReason === "unauthorized" && c.closedAfter < AUTH_TIMEOUT_MS,
          `code ${c.closeCode} "${c.closeReason}" after ${c.closedAfter} ms`);
        check(`${label} cookie: no ready`, c.readies().length === 0);
      }
    }

    console.log("\n  the Origin check");
    {
      const evil = open({ cookie: cookie(tokenFor(ann)), origin: "https://paperclip.example.test" });
      await evil.closed();
      check("valid cookie from an origin not in the list: ignored (4001, auth timeout)",
        evil.closeCode === CLOSE_UNAUTHORIZED && evil.closeReason === "auth timeout" && evil.readies().length === 0,
        `code ${evil.closeCode} "${evil.closeReason}"`);

      const prefix = open({ cookie: cookie(tokenFor(ann)), origin: `${ORIGIN}.attacker.test` });
      await prefix.closed();
      check("an origin that only starts with an allowed one: ignored", prefix.readies().length === 0);

      const none = open({ cookie: cookie(tokenFor(ann)) });
      await none.closed();
      check("valid cookie with no Origin header: ignored", none.closeReason === "auth timeout" && none.readies().length === 0,
        `"${none.closeReason}"`);

      const withFrame = open({ cookie: cookie(tokenFor(ann)), origin: "https://paperclip.example.test", first: auth(bob) });
      check("first-frame token still works when the cookie is ignored", await withFrame.ready());
      check("  as the token's person", (withFrame.readies()[0]?.threads ?? []).includes(campaignThreadKey(bobCampaign)));

      process.env.SESSION_COOKIE_ORIGINS = "";
      const unset = open({ cookie: cookie(tokenFor(ann)), origin: ORIGIN });
      await unset.closed();
      check("SESSION_COOKIE_ORIGINS unset: cookie ignored", unset.closeReason === "auth timeout" && unset.readies().length === 0,
        `"${unset.closeReason}"`);
      process.env.SESSION_COOKIE_ORIGINS = ORIGIN;

      delete process.env.SESSION_COOKIE_NAME;
      const off = open({ cookie: cookie(tokenFor(ann)), origin: ORIGIN });
      await off.closed();
      check("SESSION_COOKIE_NAME unset: cookie off on upgrades too", off.closeReason === "auth timeout" && off.readies().length === 0,
        `"${off.closeReason}"`);
      process.env.SESSION_COOKIE_NAME = NAME;
    }

    console.log("\n  token auth without a cookie");
    {
      const frame = open({ first: auth(ann) });
      check("first-frame token", await frame.ready());
      const q = client(`${wsUrl}?token=${encodeURIComponent(tokenFor(ann))}`);
      opened.push(q);
      check("query-string token", await q.ready());
      const silent = open({ origin: ORIGIN });
      await silent.closed();
      check("no cookie and no frame: 4001 on the auth timeout", silent.closeCode === CLOSE_UNAUTHORIZED && silent.closeReason === "auth timeout",
        `code ${silent.closeCode} "${silent.closeReason}"`);
    }

    console.log("\n  cookie and auth frame together");
    {
      const both = open({ cookie: cookie(tokenFor(ann)), origin: ORIGIN, first: auth(bob) });
      await both.ready();
      await sleep(300);
      check("exactly one ready", both.readies().length === 1, `${both.readies().length}`);
      check("as the cookie's person (the cookie started auth first)",
        (both.readies()[0]?.threads ?? []).includes(campaignThreadKey(annCampaign)));
      check("socket stays open", both.closeCode === null, `closed ${both.closeCode}`);
    }

    console.log("\n  the shared client");
    {
      const { LiveClient } = (await import(LIVE_CLIENT)) as { LiveClient: LiveClientCtor };
      /** What a browser does: the cookie and the page's Origin ride on the upgrade. */
      class BrowserSocket extends WebSocket {
        constructor(url: string) { super(url, { headers: { cookie: cookie(tokenFor(ann)), origin: ORIGIN } }); }
      }
      const thread = campaignThreadKey(annCampaign);

      const byCookie = new LiveClient({ url: wsUrl, getToken: () => null, cookieAuth: true, WebSocket: BrowserSocket });
      byCookie.subscribe(thread, {});
      check("cookieAuth, no token: opens", await until(() => byCookie.status === "open"), byCookie.status);
      check("cookieAuth, no token: the thread is live", await until(() => byCookie.threadStatus(thread) === "open"),
        byCookie.threadStatus(thread));
      byCookie.close();

      const plain = new LiveClient({ url: wsUrl, getToken: () => null, WebSocket: BrowserSocket });
      plain.subscribe(thread, {});
      await sleep(200);
      check("no cookieAuth, no token: stays idle", plain.status === "idle", plain.status);
      plain.close();

      class NoCookieSocket extends WebSocket {
        constructor(url: string) { super(url, { headers: { origin: ORIGIN } }); }
      }
      const signedOut = new LiveClient({ url: wsUrl, getToken: () => null, cookieAuth: true, WebSocket: NoCookieSocket });
      signedOut.subscribe(thread, {});
      check("cookieAuth with no cookie: stops as unauthorized", await until(() => signedOut.status === "unauthorized", AUTH_TIMEOUT_MS + 2_000),
        signedOut.status);
      signedOut.close();
    }
  } finally {
    for (const c of opened) c.ws.terminate();
    await live.close();
    await new Promise<void>((r) => server.close(() => r()));
    await cleanup();
    await pool.end();
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try { await cleanup(); await pool.end(); } catch { /* already closed */ }
  process.exit(1);
});
