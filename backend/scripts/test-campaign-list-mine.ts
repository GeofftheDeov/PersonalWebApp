/**
 * `GET /api/campaigns?mine=1` lists only the campaigns you were added to, for
 * admins too (#251, part of #69): Hearthside's Campaigns tab in the social
 * menu. Without `mine`, an admin still gets every campaign, as before, and a
 * player gets their own either way.
 *
 * An admin, a player and a GM: the GM runs two campaigns, the admin and the
 * player join one, and the admin also starts one of their own. A deactivated
 * membership doesn't count. Mounts the real router and drives it over HTTP
 * with a real JWT.
 *
 * Run against a throwaway database loaded from db/schema.sql (it refuses to run
 * against anything but localhost, and deletes what it makes):
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-campaign-list-mine.ts
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
const { default: campaignRoutes } = await import("../routes/campaignRoutes.js");

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
    const d = typeof detail === "string" ? detail : JSON.stringify(detail);
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !d ? "" : `\n          ${d}`}`);
    ok ? pass++ : fail++;
}

async function main() {
    const app = express();
    app.use(express.json());
    app.use("/api/campaigns", campaignRoutes);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const tag = crypto.randomBytes(4).toString("hex");
    const accounts: string[] = [];
    const campaigns: string[] = [];
    const person = async (name: string, role: "user" | "admin" = "user") => {
        const email = `t251-${name}-${tag}@example.test`;
        const { rows: [acct] } = await pool.query(
            `INSERT INTO accounts (id, handle, email, app_role, app_role_source) VALUES (gen_random_uuid(), $1, $2, $3, 'manual') RETURNING id`,
            [`t251_${name}_${tag}`, email, role]);
        accounts.push(acct.id);
        return { id: acct.id as string, token: signJwt({ id: acct.id, email }, { expiresIn: "1h" }) };
    };
    const call = async (method: string, urlPath: string, token: string, body?: unknown) => {
        const res = await fetch(`${base}${urlPath}`, {
            method,
            headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        return { status: res.status, json };
    };
    const campaign = async (owner: { token: string }, title: string) => {
        const r = await call("POST", "/api/campaigns", owner.token, {
            title: `${title} ${tag}`, description: "For ?mine=1 (#251).", status: "In Progress", startDate: "2026-03-14",
        });
        if (r.status !== 201) throw new Error(`create ${title}: ${r.status} ${JSON.stringify(r.json)}`);
        campaigns.push(String(r.json.campaign.id));
        return String(r.json.campaign.id);
    };
    const ids = (r: { json: any }) => new Set<string>((Array.isArray(r.json) ? r.json : []).map((c: any) => String(c._id)));
    const same = (got: Set<string>, want: string[]) => got.size === want.length && want.every((id) => got.has(id));

    try {
        const admin = await person("admin", "admin");
        const player = await person("player");
        const gm = await person("gm");

        const joined = await campaign(gm, "Joined");
        const elsewhere = await campaign(gm, "Elsewhere");
        const left = await campaign(gm, "Left");
        for (const who of [admin, player]) {
            const r = await call("POST", `/api/campaigns/${joined}/join`, who.token);
            if (r.status >= 300) throw new Error(`join: ${r.status} ${JSON.stringify(r.json)}`);
        }
        const r = await call("POST", `/api/campaigns/${left}/join`, admin.token);
        if (r.status >= 300) throw new Error(`join left: ${r.status} ${JSON.stringify(r.json)}`);
        // Made inactive in that one (#37): it grants nothing.
        await pool.query(`UPDATE campaign_members SET is_active = false WHERE campaign_id = $1 AND person_id = $2`, [left, admin.id]);
        const own = await campaign(admin, "Own");

        const mine = await call("GET", "/api/campaigns?mine=1", admin.token);
        check("an admin's ?mine=1 lists the campaigns they joined or started",
            mine.status === 200 && same(ids(mine), [joined, own]), { status: mine.status, got: [...ids(mine)], want: [joined, own] });
        check("...and not one they're not in, or were made inactive in",
            !ids(mine).has(elsewhere) && !ids(mine).has(left));
        const mineTrue = await call("GET", "/api/campaigns?mine=true", admin.token);
        check("?mine=true is the same", same(ids(mineTrue), [joined, own]), [...ids(mineTrue)]);

        const all = await call("GET", "/api/campaigns", admin.token);
        check("without mine, an admin still gets every campaign",
            all.status === 200 && [joined, elsewhere, left, own].every((id) => ids(all).has(id)), [...ids(all)]);
        const notMine = await call("GET", "/api/campaigns?mine=0", admin.token);
        check("mine=0 is the same as leaving it out", [joined, elsewhere, left, own].every((id) => ids(notMine).has(id)));

        const playerMine = await call("GET", "/api/campaigns?mine=1", player.token);
        const playerAll = await call("GET", "/api/campaigns", player.token);
        check("a player gets their own campaigns either way",
            same(ids(playerMine), [joined]) && same(ids(playerAll), [joined]), { mine: [...ids(playerMine)], all: [...ids(playerAll)] });
        check("?mine=1 rows are whole campaigns, banner link included",
            (mine.json ?? []).every((c: any) => typeof c.title === "string" && "bannerUrl" in c), mine.json?.[0]);
    } finally {
        if (campaigns.length) await pool.query(`DELETE FROM campaigns WHERE id = ANY($1::uuid[])`, [campaigns]);
        if (accounts.length) await pool.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [accounts]);
        server.close();
    }

    console.log(`\n  ${pass} passed, ${fail} failed\n`);
    await pool.end();
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
