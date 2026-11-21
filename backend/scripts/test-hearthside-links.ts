/**
 * HEARTHSIDE_URL builds every backend-generated Game Night link (#214, part of #69).
 *
 * With HEARTHSIDE_URL set, the links the backend hands out point straight at
 * Hearthside, on Hearthside's paths (no /game-night prefix):
 *   - bell notifications: the Notice Board, a campaign, a session and its
 *     quests (a campaign invite still has no link: it's answered in the bell);
 *   - the quest-reminder email;
 *   - the ready check's bell and its Table Talk post;
 *   - Discord and Google Calendar event descriptions, and the shareable Google
 *     link's `details`: the session's Hearthside page, which players keep
 *     (scrubCalendarLink drops anything else, such as an old agenda; see
 *     test-prep-notes).
 * With it unset, every link is what the backend generated before: relative
 * /game-night/... paths, the reminder email on FRONTEND_URL, no event
 * description (a night move clears it).
 *
 * Runs the same party through both modes. Installs the integrations fake
 * (testing/fakeIntegrations.ts), mounts the real routers (the planner on the
 * real ExternalEvents, the planning announcements subscribed as in server.ts)
 * and drives them over HTTP with real JWTs. Each person reads their bell
 * through /api/notifications. The reminder and ready-check jobs are run
 * directly, as their schedulers would; the reminder email goes to a stub.
 *
 * Run against a throwaway database loaded from db/schema.sql (it inserts and
 * deletes its own rows, and refuses to run against anything but localhost):
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-hearthside-links.ts
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
// The API Key Vault encrypts with this; a fresh throwaway key for this run.
process.env.VAULT_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

const { default: pool } = await import("../db/index.js");
const { default: tabletopRoutes } = await import("../routes/tabletopRoutes.js");
const { default: campaignRoutes } = await import("../routes/campaignRoutes.js");
const { default: apiKeyRoutes } = await import("../routes/apiKeyRoutes.js");
const { default: questRoutes } = await import("../routes/questRoutes.js");
const { default: messageRoutes } = await import("../routes/messageRoutes.js");
const { default: notificationRoutes } = await import("../routes/notificationRoutes.js");
const { default: inviteRoutes } = await import("../routes/inviteRoutes.js");
const { buildPlanningRouter } = await import("../routes/planningRoutes.js");
const { createPlanner } = await import("../planning/planner.js");
const { startPlanningAnnouncements } = await import("../planning/announcements.js");
const { runQuestReminders } = await import("../planning/questReminders.js");
const { runReadyCheckSweep } = await import("../utils/readyCheck.js");
const { createFakeIntegrations } = await import("../testing/fakeIntegrations.js");

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const PORTFOLIO = "https://geoffthedeov.net";
const HEARTHSIDE = "https://hearthside.geoffthedeov.net";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
    const d = typeof detail === "string" ? detail : JSON.stringify(detail);
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !d ? "" : `\n          ${d}`}`);
    ok ? pass++ : fail++;
}

async function main() {
    const fake = createFakeIntegrations();
    const uninstall = fake.install();

    const app = express();
    app.use(express.json());
    app.use("/api/tabletop", tabletopRoutes);
    app.use("/api/campaigns", campaignRoutes);
    app.use("/api/api-keys", apiKeyRoutes);
    app.use("/api/quests", questRoutes);
    app.use("/api/messages", messageRoutes);
    app.use("/api/notifications", notificationRoutes);
    app.use("/api/campaign-invites", inviteRoutes);
    app.use("/api/planning", buildPlanningRouter(createPlanner()));   // the real ExternalEvents
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const announcer = startPlanningAnnouncements();

    process.env.FRONTEND_URL = PORTFOLIO;
    delete process.env.PORTFOLIO_ORIGINS;

    const tag = crypto.randomBytes(4).toString("hex");
    const accounts: string[] = [], campaigns: string[] = [];

    const t0 = Math.ceil((Date.now() + 7 * DAY) / HOUR) * HOUR;
    const slot = (dayOffset: number, hours = 4) => ({
        start: new Date(t0 + dayOffset * DAY).toISOString(), end: new Date(t0 + dayOffset * DAY + hours * HOUR).toISOString(),
    });
    const until = async (cond: () => Promise<boolean>, ms = 3000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 25)); }
        return cond();
    };

    /** One party (GM, a player, and a friend of the GM's to invite) through every kind of link. */
    async function scenario(mode: "unset" | "set") {
        if (mode === "set") process.env.HEARTHSIDE_URL = HEARTHSIDE;
        else delete process.env.HEARTHSIDE_URL;
        const on = mode === "set";
        /** What a link should be: Hearthside's path on HEARTHSIDE_URL, or what the backend built before (#214). */
        const want = (hearthsidePath: string, before: string | undefined) => (on ? `${HEARTHSIDE}${hearthsidePath}` : before);
        console.log(on ? `\nHEARTHSIDE_URL=${HEARTHSIDE}\n` : "\nHEARTHSIDE_URL unset: links as before\n");

        const who: Record<string, { id: string; token: string; email: string }> = {};
        for (const name of ["gm", "p1", "friend"]) {
            const email = `t214-${mode}-${name}-${tag}@example.test`;
            const { rows: [acct] } = await pool.query(
                `INSERT INTO accounts (id, handle, email, app_role, app_role_source) VALUES (gen_random_uuid(), $1, $2, 'user', 'manual') RETURNING id`,
                [`t214_${mode}_${name}_${tag}`, email]);
            accounts.push(acct.id);
            who[name] = { id: acct.id, token: signJwt({ id: acct.id, email }, { expiresIn: "1h" }), email };
        }
        await pool.query(`UPDATE accounts SET friends = ARRAY[$2]::uuid[] WHERE id = $1`, [who.gm.id, who.friend.id]);
        await pool.query(`UPDATE accounts SET friends = ARRAY[$2]::uuid[] WHERE id = $1`, [who.friend.id, who.gm.id]);
        const { rows: [camp] } = await pool.query(
            `INSERT INTO campaigns (title, owner_id, discord_guild_id) VALUES ('Ashen Crown', $1, '555000214') RETURNING id`, [who.gm.id]);
        const C: string = camp.id;
        campaigns.push(C);
        for (const [i, [name, status]] of ([["gm", "Game Master"], ["p1", "Player"]] as const).entries()) {
            await pool.query(`INSERT INTO campaign_members (campaign_id, person_id, status, joined_at) VALUES ($1, $2, $3, $4)`,
                [C, who[name].id, status, new Date(Date.UTC(2026, 0, 1 + i))]);
        }

        const call = async (method: string, urlPath: string, as: string, body?: unknown) => {
            const res = await fetch(`${base}${urlPath}`, {
                method,
                headers: { "content-type": "application/json", authorization: `Bearer ${who[as].token}` },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            const text = await res.text();
            let json: any = null;
            try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
            return { status: res.status, json };
        };
        /** The first bell entry for `as` matching `pred`, waiting for side effects that land after the response. */
        const bellEntry = async (as: string, pred: (n: any) => boolean) => {
            let hit: any = null;
            await until(async () => {
                await announcer.idle();
                const r = await call("GET", "/api/notifications?limit=100", as);
                hit = (r.json?.notifications ?? []).find(pred) ?? null;
                return hit !== null;
            });
            return hit;
        };
        const row = async (id: string) => (await pool.query(`SELECT * FROM game_sessions WHERE id = $1`, [id])).rows[0];
        const P = (sid: string, action = "") => `/api/planning/sessions/${sid}${action ? `/${action}` : ""}`;
        const detailsOf = (link: string | null | undefined) => (link ? new URL(link).searchParams.get("details") : null);

        for (const [provider, secret] of [["discord", `bot-${tag}`], ["google_calendar", `refresh-${tag}`]]) {
            await call("PUT", `/api/api-keys/${provider}`, "gm", { keyId: `${provider}-id`, secret });
        }

        // ── the Notice Board ────────────────────────────────────────────────
        const kicked = await call("POST", `/api/planning/campaigns/${C}/kickoff`, "gm", { title: "Night one", isOnline: true });
        const pid: string = kicked.json?.session?.id;
        const kickBell = await bellEntry("p1", (n) => n.meta?.sessionId === pid && /Planning started/.test(n.title));
        check("planning's party bell links to the Notice Board",
            kicked.status === 200 && kickBell?.link === want(`/campaigns/${C}#notice-board`, `/game-night/campaigns/${C}#notice-board`),
            { status: kicked.status, link: kickBell?.link });

        // ── confirming the night: the events, and the GM's bell when one fails ──
        fake.clear();
        fake.fail("discord.createScheduledEvent", new Error("Discord API 500"));
        const A = slot(1), B = slot(2);
        const sl = await call("POST", P(pid, "shortlist"), "gm", { options: [A, B] });
        const optA = sl.json?.night?.options?.find((o: any) => o.start === A.start)?.id;
        for (const as of ["gm", "p1"]) await call("POST", P(pid, "vote"), as, { optionIds: [optA] });
        await until(async () => Boolean((await row(pid)).google_event_id));
        const [dPub] = fake.calls("discord.createScheduledEvent"), [gPub] = fake.calls("google.createCalendarEvent");
        check("confirming the night: the Discord event's description is the session's page",
            dPub !== undefined && dPub.args[0].description === want(`/sessions/${pid}`, undefined), dPub?.args[0]);
        check("...and so is the Google event's",
            gPub !== undefined && gPub.args[1].description === want(`/sessions/${pid}`, undefined), gPub?.args[1]);
        const confirmedLink = (await row(pid)).google_calendar_link;
        check("...and the shareable Google link's details",
            detailsOf(confirmedLink) === (want(`/sessions/${pid}`, undefined) ?? null), confirmedLink);
        const gmWarn = await bellEntry("gm", (n) => n.meta?.sessionId === pid && /with a problem/.test(n.title));
        check("the GM's bell about the failed Discord event links to the Notice Board",
            gmWarn?.link === want(`/campaigns/${C}#notice-board`, `/game-night/campaigns/${C}#notice-board`), gmWarn);

        // ── moving the night ────────────────────────────────────────────────
        fake.clear();
        const D = slot(3), E = slot(4);
        const ro = await call("POST", P(pid, "reopen"), "gm", { options: [D, E] });
        const optD = ro.json?.night?.options?.find((o: any) => o.start === D.start)?.id;
        for (const as of ["gm", "p1"]) await call("POST", P(pid, "vote"), as, { optionIds: [optD] });
        await until(async () => fake.calls("google.updateCalendarEvent").length > 0);
        const [dUpd] = fake.calls("discord.updateScheduledEvent"), [gUpd] = fake.calls("google.updateCalendarEvent");
        check(on ? "moving the night sends the session's page as both events' description"
                 : "moving the night clears both events' description, as before",
            gUpd?.args[2].description === want(`/sessions/${pid}`, "") &&
                (dUpd === undefined || dUpd.args[0].description === want(`/sessions/${pid}`, "")),
            { discord: dUpd?.args[0], google: gUpd?.args[2] });
        const movedBell = await bellEntry("p1", (n) => n.meta?.sessionId === pid && /moved/.test(n.title));
        check("...and the party's bell about it links to the Notice Board",
            movedBell?.link === want(`/campaigns/${C}#notice-board`, `/game-night/campaigns/${C}#notice-board`), movedBell);

        // ── adding a session with events ────────────────────────────────────
        fake.clear();
        const S = slot(5);
        const created = await call("POST", "/api/tabletop/sessions", "gm", {
            title: "One-shot", campaign: C, date: S.start, endDate: S.end, isOnline: true, agenda: "The lich is the innkeeper",
            createDiscordEvent: true, createGoogleEvent: true,
        });
        const sid: string = created.json?._id;
        const [dNew] = fake.calls("discord.createScheduledEvent"), [gNew] = fake.calls("google.createCalendarEvent");
        check("adding a session: the Discord event's description is the session's page",
            created.status === 201 && dNew?.args[0].description === want(`/sessions/${sid}`, undefined), { status: created.status, d: dNew?.args[0] });
        check("...and so is the Google event's", gNew?.args[1].description === want(`/sessions/${sid}`, undefined), gNew?.args[1]);
        check("...and the shareable link's details", detailsOf(created.json?.googleCalendarLink) === (want(`/sessions/${sid}`, undefined) ?? null),
            created.json?.googleCalendarLink);
        const asPlayer = await call("GET", `/api/tabletop/sessions/${sid}`, "p1");
        check(on ? "a player's copy of the shareable link keeps the session's page (and no agenda)"
                 : "a player's copy of the shareable link has no details",
            asPlayer.status === 200 && detailsOf(asPlayer.json?.googleCalendarLink) === (want(`/sessions/${sid}`, undefined) ?? null),
            asPlayer.json?.googleCalendarLink);

        // ── quests ──────────────────────────────────────────────────────────
        const quest = await call("POST", `/api/quests/sessions/${sid}`, "gm", { title: "Print the handout", assigneeId: who.p1.id });
        const questBell = await bellEntry("p1", (n) => n.meta?.questId === quest.json?.id && /New quest/.test(n.title));
        check("a new quest's bell links to the session's quests",
            quest.status === 201 && questBell?.link === want(`/sessions/${sid}#quests`, `/game-night/sessions/${sid}#quests`),
            { status: quest.status, link: questBell?.link });

        // ── quest reminders ─────────────────────────────────────────────────
        const now = new Date();
        const { rows: [due] } = await pool.query(
            `INSERT INTO session_tasks (session_id, assignee_id, kind, title, due_at, reminder_offsets)
             VALUES ($1, $2, 'custom', 'Bring dice', $3, '{120}') RETURNING id`, [sid, who.p1.id, new Date(+now + HOUR)]);
        const mails: { to: string; text: string; html: string }[] = [];
        await runQuestReminders(pool, now, { sendEmail: async (m) => { if (m.to === who.p1.email) mails.push(m); } });
        const reminder = await bellEntry("p1", (n) => n.meta?.questId === due.id && /Reminder/.test(n.title));
        check("a quest reminder's bell links to the session's quests",
            reminder?.link === want(`/sessions/${sid}#quests`, `/game-night/sessions/${sid}#quests`), reminder);
        const mailUrl = want(`/sessions/${sid}#quests`, `${PORTFOLIO}/game-night/sessions/${sid}#quests`)!;
        check(`...and its email links to ${on ? "Hearthside" : "the portfolio (FRONTEND_URL)"}`,
            mails.length === 1 && mails[0].text.includes(mailUrl) && mails[0].html.includes(`href="${mailUrl}"`), mails);

        // ── the ready check ─────────────────────────────────────────────────
        const { rows: [soon] } = await pool.query(
            `INSERT INTO game_sessions (title, campaign_id, date) VALUES ('Tonight', $1, $2) RETURNING id`, [C, new Date(+now + 10 * MIN)]);
        await runReadyCheckSweep();
        const ready = await bellEntry("p1", (n) => n.meta?.sessionId === soon.id && /Ready check/.test(n.title));
        check("the ready check's bell links to the session", ready?.link === want(`/sessions/${soon.id}`, `/game-night/sessions/${soon.id}`), ready);
        const talk = await call("GET", `/api/messages/campaign/${C}`, "p1");
        const post = (talk.json ?? []).find((m: any) => /READY CHECK/.test(m.body ?? ""));
        check("...and so does its Table Talk post",
            typeof post?.body === "string" && post.body.includes(`(${want(`/sessions/${soon.id}`, `/game-night/sessions/${soon.id}`)})`), post);

        // ── Table Talk ──────────────────────────────────────────────────────
        await call("POST", `/api/messages/campaign/${C}`, "gm", { body: "Roll for initiative" });
        const msg = await bellEntry("p1", (n) => n.type === "message" && n.meta?.campaignId === C);
        check("a Table Talk message's bell links to the campaign", msg?.link === want(`/campaigns/${C}`, `/game-night/campaigns/${C}`), msg);

        // ── invites ─────────────────────────────────────────────────────────
        const invited = await call("POST", "/api/campaign-invites", "gm", { campaignId: C, toUserId: who.friend.id });
        const inviteBell = await bellEntry("friend", (n) => n.type === "campaign_invite" && n.meta?.campaignId === C);
        // It's answered in the bell, which a link would navigate away from.
        check("an invite's bell has no link, as before",
            invited.status === 201 && inviteBell !== null && inviteBell.link == null,
            { status: invited.status, inviteBell });
        const accepted = await call("PUT", `/api/campaign-invites/${invited.json?.invite?._id}/respond`, "friend", { action: "accept" });
        const acceptBell = await bellEntry("gm", (n) => /accepted your invite/.test(n.title));
        check("the inviter's bell when it's accepted links to the campaign",
            accepted.status === 200 && acceptBell?.link === want(`/campaigns/${C}`, `/game-night/campaigns/${C}`), acceptBell);

        // ── the torch ───────────────────────────────────────────────────────
        const passed = await call("POST", `/api/campaigns/${C}/torch`, "gm", { to: who.p1.id });
        const torch = await bellEntry("p1", (n) => /now$/.test(n.title) && n.meta?.campaignId === C);
        check("passing the torch: the new GM's bell links to the campaign",
            passed.status === 200 && torch?.link === want(`/campaigns/${C}`, `/game-night/campaigns/${C}`), torch);
    }

    try {
        await scenario("unset");
        await scenario("set");
    } finally {
        uninstall();
        announcer.stop();
        if (campaigns.length) await pool.query(`DELETE FROM campaigns WHERE id = ANY($1::uuid[])`, [campaigns]);
        if (accounts.length) {
            await pool.query(`DELETE FROM api_key_vault WHERE user_id = ANY($1::uuid[])`, [accounts]);
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
