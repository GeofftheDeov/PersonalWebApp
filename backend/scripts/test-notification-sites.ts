/**
 * The bell on Hearthside shows only Hearthside's notifications (#220, part of #69).
 *
 * `GET /api/notifications?site=hearthside` lists, and counts as unread, only:
 *   - campaign invites and friend requests;
 *   - notifications whose link is a Game Night page: a relative
 *     `/game-night/...` path (every row made without HEARTHSIDE_URL), or an
 *     absolute link on this environment's Hearthside host (#214).
 * `PUT /api/notifications/read-all?site=hearthside` marks only those read.
 * Without `site` (or with `site=portfolio`) every route behaves as before: the
 * portfolio's bell shows everything. An unknown `site` is a 400.
 *
 * Seeds one person's bell with every kind of row (and a near miss for each
 * rule), mounts the real router and drives it over HTTP with a real JWT,
 * with HEARTHSIDE_URL set and then unset.
 *
 * Run against a throwaway database loaded from db/schema.sql (it inserts and
 * deletes its own rows, and refuses to run against anything but localhost):
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-notification-sites.ts
 */
import "./use-test-jwt-secret.js";
import express from "express";
import type { AddressInfo } from "net";
import crypto from "crypto";
import { signJwt } from "../utils/jwt.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
    console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
    process.exit(2);
}

const { default: pool } = await import("../db/index.js");
const { default: notificationRoutes } = await import("../routes/notificationRoutes.js");

const HEARTHSIDE = "https://hearthside.geoffthedeov.net";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
    const d = typeof detail === "string" ? detail : JSON.stringify(detail);
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !d ? "" : `\n          ${d}`}`);
    ok ? pass++ : fail++;
}

/** One bell row: its title names it, so the checks can compare lists of titles. */
interface Row { title: string; type: string; link?: string; read?: boolean }

/** What the bell holds, oldest first. `hearthside` says whether Hearthside's bell shows it with HEARTHSIDE_URL set. */
const ROWS: (Row & { hearthside: boolean })[] = [
    { title: "invite", type: "campaign_invite", hearthside: true },
    { title: "friend request", type: "friend_request", hearthside: true },
    { title: "quest reminder", type: "system", link: `${HEARTHSIDE}/sessions/s1#quests`, hearthside: true },
    { title: "table talk", type: "message", link: `${HEARTHSIDE}/campaigns/c1`, hearthside: true },
    { title: "hearthside home", type: "system", link: HEARTHSIDE, hearthside: true },
    { title: "old notice board", type: "system", link: "/game-night/campaigns/c1#notice-board", hearthside: true },
    { title: "old game night", type: "system", link: "/game-night", hearthside: true },
    { title: "old game night query", type: "system", link: "/game-night?tab=sessions", hearthside: true },
    { title: "read old session", type: "system", link: "/game-night/sessions/s1", read: true, hearthside: true },
    { title: "friend accepted", type: "system", hearthside: false },
    { title: "dm", type: "message", hearthside: false },
    { title: "portfolio page", type: "system", link: "/profile?tab=friends", hearthside: false },
    { title: "lookalike path", type: "system", link: "/game-nightly/c1", hearthside: false },
    { title: "lookalike host", type: "system", link: `${HEARTHSIDE}.evil.test/campaigns/c1`, hearthside: false },
    { title: "other site", type: "system", link: "https://example.test/game-night/c1", hearthside: false },
    { title: "read portfolio", type: "system", read: true, hearthside: false },
];

async function main() {
    const app = express();
    app.use(express.json());
    app.use("/api/notifications", notificationRoutes);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    process.env.FRONTEND_URL = "https://geoffthedeov.net";
    delete process.env.PORTFOLIO_ORIGINS;

    const tag = crypto.randomBytes(4).toString("hex");
    const accounts: string[] = [];
    const person = async (name: string) => {
        const email = `t220-${name}-${tag}@example.test`;
        const { rows: [acct] } = await pool.query(
            `INSERT INTO accounts (id, handle, email, app_role, app_role_source) VALUES (gen_random_uuid(), $1, $2, 'user', 'manual') RETURNING id`,
            [`t220_${name}_${tag}`, email]);
        accounts.push(acct.id);
        return { id: acct.id as string, token: signJwt({ id: acct.id, email }, { expiresIn: "1h" }) };
    };

    const call = async (method: string, urlPath: string, token: string) => {
        const res = await fetch(`${base}${urlPath}`, { method, headers: { authorization: `Bearer ${token}` } });
        const text = await res.text();
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        return { status: res.status, json };
    };
    const titles = (r: { json: any }) => (r.json?.notifications ?? []).map((n: any) => n.title);
    const seed = async (userId: string, rows: Row[]) => {
        const t0 = Date.now() - rows.length * 60_000;
        for (const [i, r] of rows.entries()) {
            await pool.query(
                `INSERT INTO notifications (user_id, type, title, link, read, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
                [userId, r.type, r.title, r.link ?? null, !!r.read, new Date(t0 + i * 60_000)]);
        }
    };
    const newestFirst = (rows: Row[]) => rows.map((r) => r.title).reverse();
    const unread = (rows: Row[]) => rows.filter((r) => !r.read).length;

    try {
        // ── HEARTHSIDE_URL set ─────────────────────────────────────────────
        process.env.HEARTHSIDE_URL = HEARTHSIDE;
        console.log(`\nHEARTHSIDE_URL=${HEARTHSIDE}\n`);
        const me = await person("me");
        const other = await person("other");
        await seed(me.id, ROWS);
        // Someone else's invite never reaches my bell, on either site.
        await seed(other.id, [{ title: "their invite", type: "campaign_invite" }]);
        const mine = ROWS.filter((r) => r.hearthside);

        const hs = await call("GET", "/api/notifications?limit=100&site=hearthside", me.token);
        check("site=hearthside lists only invites, friend requests and Game Night links, newest first",
            hs.status === 200 && JSON.stringify(titles(hs)) === JSON.stringify(newestFirst(mine)),
            { status: hs.status, got: titles(hs), want: newestFirst(mine) });
        check("site=hearthside's unread count counts only those",
            hs.json?.unreadCount === unread(mine), { got: hs.json?.unreadCount, want: unread(mine) });

        const all = await call("GET", "/api/notifications?limit=100", me.token);
        check("without site, the bell lists everything, as before",
            all.status === 200 && JSON.stringify(titles(all)) === JSON.stringify(newestFirst(ROWS)),
            { got: titles(all) });
        check("without site, the unread count counts everything", all.json?.unreadCount === unread(ROWS), all.json?.unreadCount);
        const pf = await call("GET", "/api/notifications?limit=100&site=portfolio", me.token);
        check("site=portfolio is the same as no site",
            JSON.stringify(titles(pf)) === JSON.stringify(titles(all)) && pf.json?.unreadCount === all.json?.unreadCount);

        const limited = await call("GET", "/api/notifications?limit=2&site=hearthside", me.token);
        check("the limit applies after the filter",
            JSON.stringify(titles(limited)) === JSON.stringify(newestFirst(mine).slice(0, 2)) && limited.json?.unreadCount === unread(mine),
            titles(limited));

        for (const bad of ["site=bogus", "site=hearthside&site=portfolio", "site="]) {
            const r = await call("GET", `/api/notifications?${bad}`, me.token);
            check(`an unknown site (${bad}) is a 400`, r.status === 400, r);
        }
        const badRead = await call("PUT", "/api/notifications/read-all?site=bogus", me.token);
        check("read-all with an unknown site is a 400, and marks nothing", badRead.status === 400
            && (await call("GET", "/api/notifications?limit=100", me.token)).json?.unreadCount === unread(ROWS), badRead);

        const readAll = await call("PUT", "/api/notifications/read-all?site=hearthside", me.token);
        const afterHs = await call("GET", "/api/notifications?limit=100&site=hearthside", me.token);
        const afterAll = await call("GET", "/api/notifications?limit=100", me.token);
        const stillUnread = (afterAll.json?.notifications ?? []).filter((n: any) => !n.read).map((n: any) => n.title).sort();
        const wantUnread = ROWS.filter((r) => !r.hearthside && !r.read).map((r) => r.title).sort();
        check("read-all?site=hearthside clears Hearthside's bell",
            readAll.status === 200 && afterHs.json?.unreadCount === 0 && (afterHs.json?.notifications ?? []).every((n: any) => n.read),
            { status: readAll.status, unread: afterHs.json?.unreadCount });
        check("...and leaves the portfolio-only notifications unread",
            JSON.stringify(stillUnread) === JSON.stringify(wantUnread) && afterAll.json?.unreadCount === wantUnread.length,
            { stillUnread, wantUnread });
        const theirs = await call("GET", "/api/notifications?site=hearthside", other.token);
        check("...and nobody else's", theirs.json?.unreadCount === 1 && titles(theirs)[0] === "their invite", theirs.json);

        const readEverything = await call("PUT", "/api/notifications/read-all", me.token);
        check("read-all without site still marks everything read",
            readEverything.status === 200 && (await call("GET", "/api/notifications", me.token)).json?.unreadCount === 0);

        // ── HEARTHSIDE_URL unset ───────────────────────────────────────────
        delete process.env.HEARTHSIDE_URL;
        console.log("\nHEARTHSIDE_URL unset: no host is Hearthside's, and Game Night links are relative\n");
        const later = await person("later");
        await seed(later.id, ROWS);
        const noHost = await call("GET", "/api/notifications?limit=100&site=hearthside", later.token);
        const want = ROWS.filter((r) => r.hearthside && !r.link?.startsWith("http"));
        check("site=hearthside still lists invites, friend requests and /game-night/... links",
            noHost.status === 200 && JSON.stringify(titles(noHost)) === JSON.stringify(newestFirst(want)),
            { got: titles(noHost), want: newestFirst(want) });
        check("...and counts them", noHost.json?.unreadCount === unread(want), noHost.json?.unreadCount);
    } finally {
        if (accounts.length) {
            await pool.query(`DELETE FROM notifications WHERE user_id = ANY($1::uuid[])`, [accounts]);
            await pool.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [accounts]);
        }
        server.close();
    }

    console.log(`\n  ${pass} passed, ${fail} failed\n`);
    await pool.end();
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
