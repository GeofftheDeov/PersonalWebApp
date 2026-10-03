/**
 * Session planning (#57), ticket #81: campaign banners. Seam 1, the HTTP API.
 *
 * Installs the recording integrations fake (testing/fakeIntegrations.ts), mounts
 * the real campaign and membership routers, and drives them over HTTP with real
 * JWTs against a throwaway database loaded from db/schema.sql. Checks what's
 * visible from outside: responses, rows, bus events and the uploads calls the
 * fake received. Nothing here reaches AWS: the last block signs URLs with the
 * real presigner, which is local crypto with made-up credentials.
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-campaign-banner-api.ts
 */
import express from "express";
import type { AddressInfo } from "net";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import pool from "../db/index.js";
import { bus } from "../events/index.js";
import campaignRoutes from "../routes/campaignRoutes.js";
import campaignMemberRoutes from "../routes/campaignMemberRoutes.js";
import { realIntegrations, UploadsNotConfiguredError } from "../utils/integrations.js";
import { createFakeIntegrations } from "../testing/fakeIntegrations.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
    console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
    process.exit(2);
}

const SECRET = process.env.JWT_SECRET || "your-secret-key-change-this";
const MB5 = 5 * 1024 * 1024;

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
    app.use("/api/campaigns", campaignRoutes);
    app.use("/api/campaign-members", campaignMemberRoutes);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const changed: { campaignId: string; action: string }[] = [];
    bus.subscribe("campaign.changed", (payload: any) => { changed.push(payload); });
    // The in-memory bus, and the best-effort delete of a replaced banner, finish on a later tick.
    const settle = () => new Promise((r) => setTimeout(r, 50));

    const tag = crypto.randomBytes(4).toString("hex");
    const who: Record<string, { id: string; token: string }> = {};
    const campaignIds: string[] = [];

    const call = async (method: string, path: string, as?: string, body?: unknown) => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (as) headers.authorization = `Bearer ${who[as].token}`;
        const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        return { status: res.status, json };
    };
    const bannerKey = async (id: string) => (await pool.query(`SELECT banner_key FROM campaigns WHERE id = $1`, [id])).rows[0]?.banner_key;
    const create = async (as: string) => {
        const res = await call("POST", "/api/campaigns", as,
            { title: `Banner ${tag}`, description: "d", status: "In Progress", startDate: "2026-10-01" });
        campaignIds.push(res.json.campaign.id);
        return res.json.campaign.id as string;
    };
    const uploadUrl = (as: string, cid: string, body: unknown) => call("POST", `/api/campaigns/${cid}/banner/upload-url`, as, body);
    const setBanner = (as: string, cid: string, key: unknown) => call("PUT", `/api/campaigns/${cid}/banner`, as, { key });
    const clearBanner = (as: string, cid: string) => call("DELETE", `/api/campaigns/${cid}/banner`, as);

    try {
        for (const name of ["owner", "gm", "player", "outsider", "admin"]) {
            const email = `t81-${name}-${tag}@example.test`;
            const { rows: [r] } = await pool.query(
                `INSERT INTO accounts (id, handle, email, first_name, app_role, app_role_source)
                 VALUES (gen_random_uuid(), $1, $2, $3, $4, 'manual') RETURNING id`,
                [`${name}_${tag}`, email, name, name === "admin" ? "admin" : "user"]);
            who[name] = { id: r.id, token: jwt.sign({ id: r.id, email }, SECRET, { expiresIn: "1h" }) };
        }

        console.log("\n#81 — campaign banners\n");

        // The owner creates the campaign, then hands the Game Master role to
        // someone else and stays on as a player. The banner stays theirs.
        const cid = await create("owner");
        const other = await create("owner");
        const { rows: [ownerMember] } = await pool.query(
            `SELECT id FROM campaign_members WHERE campaign_id = $1 AND person_id = $2`, [cid, who.owner.id]);
        await call("POST", "/api/campaign-members", "owner", { campaign: cid, person: who.gm.id, status: "Game Master", firstName: "gm" });
        await call("POST", "/api/campaign-members", "owner", { campaign: cid, person: who.player.id, status: "Player", firstName: "player" });
        const demote = await call("PUT", `/api/campaign-members/${ownerMember.id}`, "gm", { status: "Player" });
        check("setup: the Game Master role belongs to someone other than the owner", demote.status === 200, demote.json);

        // ── requesting an upload URL ────────────────────────────────────────
        fake.clear();
        const up = await uploadUrl("owner", cid, { contentType: "image/webp", size: 123_456 });
        const [presign] = fake.calls("uploads.presignPut");
        const keyShape = new RegExp(`^campaign-banners/${cid}/[0-9a-f-]{36}\\.webp$`);
        check("the owner gets a presigned PUT for a WebP banner",
            up.status === 200 && up.json.method === "PUT" && /^https:\/\//.test(up.json.url) &&
                up.json.headers?.["Content-Type"] === "image/webp" && keyShape.test(up.json.key) && up.json.maxBytes === MB5, up.json);
        check("...signed through the uploads module for exactly that type and size, for 5 minutes, under a key the server chose",
            fake.calls().length === 1 && presign?.args[0].contentType === "image/webp" && presign.args[0].contentLength === 123_456 &&
                presign.args[0].expiresInSeconds === 300 && presign.args[0].key === up.json.key, fake.calls());
        const second = await uploadUrl("owner", cid, { contentType: "image/webp", size: 123_456 });
        check("every upload gets a fresh key, so it can't overwrite an earlier one", second.json.key !== up.json.key, [up.json.key, second.json.key]);

        const jpeg = await uploadUrl("owner", cid, { contentType: "image/jpeg", size: MB5 });
        const png = await uploadUrl("owner", cid, { contentType: "IMAGE/PNG", size: 1 });
        check("JPEG (exactly 5 MB) and PNG are accepted, stored as .jpg and .png",
            jpeg.status === 200 && jpeg.json.key.endsWith(".jpg") && png.status === 200 && png.json.key.endsWith(".png"), [jpeg.json, png.json]);

        fake.clear();
        const rejected: [string, unknown, string][] = [
            ["a GIF", { contentType: "image/gif", size: 1000 }, "JPEG, PNG or WebP"],
            ["an SVG", { contentType: "image/svg+xml", size: 1000 }, "JPEG, PNG or WebP"],
            ["an HTML page", { contentType: "text/html", size: 1000 }, "JPEG, PNG or WebP"],
            ["no type", { size: 1000 }, "JPEG, PNG or WebP"],
            ["one byte over 5 MB", { contentType: "image/webp", size: MB5 + 1 }, "at most 5 MB"],
            ["an empty file", { contentType: "image/webp", size: 0 }, "size in bytes"],
            ["a fractional size", { contentType: "image/webp", size: 10.5 }, "size in bytes"],
            ["a size sent as text", { contentType: "image/webp", size: "1000" }, "size in bytes"],
            ["no size", { contentType: "image/webp" }, "size in bytes"],
        ];
        for (const [what, body, says] of rejected) {
            const r = await uploadUrl("owner", cid, body);
            check(`${what} is refused with a 400`, r.status === 400 && r.json?.error?.includes(says), r);
        }
        check("...and none of the refused requests reached S3", fake.calls().length === 0, fake.calls());

        // ── setting the banner ──────────────────────────────────────────────
        changed.length = 0;
        fake.clear();
        const set1 = await setBanner("owner", cid, up.json.key);
        check("the owner saves the uploaded key as the banner, and gets a URL to show it",
            set1.status === 200 && set1.json.bannerKey === up.json.key && set1.json.bannerUrl === `https://fake-uploads.test/${up.json.key}?read=fake`, set1.json);
        check("...stored on the campaign", (await bannerKey(cid)) === up.json.key);
        await settle();
        check("...publishing campaign.changed", changed.some((e) => e.campaignId === cid && e.action === "updated"), changed);
        check("...and the first banner deletes nothing", fake.calls("uploads.deleteObject").length === 0, fake.calls());

        const asPlayer = await call("GET", `/api/campaigns/${cid}`, "player");
        check("a party member reading the campaign gets the banner URL, read through the uploads module",
            asPlayer.status === 200 && asPlayer.json.bannerUrl === `https://fake-uploads.test/${up.json.key}?read=fake` &&
                fake.calls("uploads.readUrl").some((c) => c.args[0].key === up.json.key), asPlayer.json);
        const list = await call("GET", "/api/campaigns", "owner");
        const inList = list.json?.find((c: any) => c._id === cid), otherInList = list.json?.find((c: any) => c._id === other);
        check("the campaign list carries each campaign's banner URL, null where there is none",
            list.status === 200 && inList?.bannerUrl === set1.json.bannerUrl && otherInList && otherInList.bannerUrl === null, list.json);

        // ── replacing it ────────────────────────────────────────────────────
        fake.clear();
        const set2 = await setBanner("owner", cid, second.json.key);
        await settle();
        check("the owner replaces the banner with a newer upload",
            set2.status === 200 && set2.json.bannerKey === second.json.key && (await bannerKey(cid)) === second.json.key, set2.json);
        check("...and the replaced image is deleted from S3",
            fake.calls("uploads.deleteObject").length === 1 && fake.calls("uploads.deleteObject")[0].args[0] === up.json.key, fake.calls());
        fake.clear();
        const same = await setBanner("owner", cid, second.json.key);
        await settle();
        check("saving the same key again is a no-op that deletes nothing",
            same.status === 200 && fake.calls("uploads.deleteObject").length === 0, fake.calls());

        // A failed delete leaves an orphan object, not a failed request.
        fake.fail("uploads.deleteObject", new Error("S3 AccessDenied"));
        const set3 = await setBanner("owner", cid, jpeg.json.key);
        await settle();
        check("if deleting the old image fails, the new banner is still saved",
            set3.status === 200 && (await bannerKey(cid)) === jpeg.json.key, set3.json);

        // ── keys the server didn't mint for this campaign ───────────────────
        const otherUp = await uploadUrl("owner", other, { contentType: "image/png", size: 10 });
        const uuid = crypto.randomUUID();
        const badKeys: [string, unknown][] = [
            ["another campaign's banner", otherUp.json.key],
            ["a path that climbs out of the prefix", `campaign-banners/${cid}/../${other}/${uuid}.png`],
            ["another prefix", `profile-pictures/${uuid}.png`],
            ["a key with an unknown extension", `campaign-banners/${cid}/${uuid}.gif`],
            ["a key with something after it", `campaign-banners/${cid}/${uuid}.png/x`],
            ["a non-uuid file name", `campaign-banners/${cid}/banner.png`],
            ["nothing", undefined],
            ["a number", 42],
        ];
        for (const [what, key] of badKeys) {
            const r = await setBanner("owner", cid, key);
            check(`${what} can't be set as the banner (400)`, r.status === 400, r);
        }
        check("...and the banner is unchanged", (await bannerKey(cid)) === jpeg.json.key);

        // ── non-owners ──────────────────────────────────────────────────────
        fake.clear();
        changed.length = 0;
        for (const as of ["gm", "player", "outsider"]) {
            const label = as === "gm" ? "the Game Master (not the owner)" : as === "player" ? "a party member" : "someone outside the party";
            const a = await uploadUrl(as, cid, { contentType: "image/webp", size: 100 });
            const b = await setBanner(as, cid, second.json.key);
            const c = await clearBanner(as, cid);
            check(`${label} gets 403 requesting an upload URL, setting and clearing the banner`,
                a.status === 403 && b.status === 403 && c.status === 403, [a, b, c]);
        }
        await settle();
        check("...those requests reached S3 not once, changed nothing and published nothing",
            fake.calls().length === 0 && (await bannerKey(cid)) === jpeg.json.key && changed.length === 0, { calls: fake.calls(), changed });
        check("with no token at all it's a 401", (await call("DELETE", `/api/campaigns/${cid}/banner`)).status === 401);
        const adminSet = await setBanner("admin", cid, second.json.key);
        check("an admin can manage a campaign's banner", adminSet.status === 200 && (await bannerKey(cid)) === second.json.key, adminSet.json);

        // ── clearing it ─────────────────────────────────────────────────────
        fake.clear();
        const cleared = await clearBanner("owner", cid);
        await settle();
        check("the owner clears the banner",
            cleared.status === 200 && cleared.json.bannerKey === null && cleared.json.bannerUrl === null && (await bannerKey(cid)) === null, cleared.json);
        check("...and its image is deleted from S3",
            fake.calls("uploads.deleteObject").length === 1 && fake.calls("uploads.deleteObject")[0].args[0] === second.json.key, fake.calls());
        const afterClear = await call("GET", `/api/campaigns/${cid}`, "player");
        check("a party member then reads no banner URL (the page shows its fallback)", afterClear.json.bannerUrl === null, afterClear.json);
        fake.clear();
        const again = await clearBanner("owner", cid);
        check("clearing when there's no banner is fine and deletes nothing",
            again.status === 200 && fake.calls("uploads.deleteObject").length === 0, again.json);

        // ── unknown campaigns, uploads switched off, unreadable banners ─────
        check("an unknown campaign is a 404", (await uploadUrl("owner", crypto.randomUUID(), { contentType: "image/png", size: 1 })).status === 404);
        check("a malformed campaign id is a 404", (await setBanner("owner", "not-a-uuid", "x")).status === 404);

        fake.fail("uploads.presignPut", new UploadsNotConfiguredError());
        const off = await uploadUrl("owner", cid, { contentType: "image/png", size: 10 });
        check("with no bucket configured, asking for an upload URL is a clear 503",
            off.status === 503 && /aren't set up/.test(off.json?.error), off);

        await setBanner("owner", cid, png.json.key);
        fake.fail("uploads.readUrl", new Error("credentials expired"));
        const unreadable = await call("GET", `/api/campaigns/${cid}`, "player");
        check("if a banner can't be read right now, the campaign still loads, with no banner URL",
            unreadable.status === 200 && unreadable.json.bannerUrl === null && unreadable.json.title, unreadable);

        // ── the real S3 seam (signing only; no network) ─────────────────────
        const saved = { ...process.env };
        try {
            delete process.env.UPLOADS_BUCKET;
            let offError: unknown = null;
            try { await realIntegrations.uploads.presignPut({ key: "k", contentType: "image/png", contentLength: 1 }); }
            catch (err) { offError = err; }
            check("real: with UPLOADS_BUCKET unset, uploads refuse with UploadsNotConfiguredError",
                offError instanceof UploadsNotConfiguredError && /not configured/.test((offError as Error).message), String(offError));

            Object.assign(process.env, {
                UPLOADS_BUCKET: "pwa-uploads-test", UPLOADS_REGION: "us-east-2",
                AWS_ACCESS_KEY_ID: "AKIAEXAMPLEEXAMPLE00", AWS_SECRET_ACCESS_KEY: "not-a-real-secret",
            });
            delete process.env.AWS_SESSION_TOKEN;
            delete process.env.AWS_PROFILE;
            delete process.env.UPLOADS_CDN_URL;
            const key = `campaign-banners/${cid}/${uuid}.webp`;
            const put = await realIntegrations.uploads.presignPut({ key, contentType: "image/webp", contentLength: 2048 });
            const u = new URL(put.url);
            check("real: the PUT URL targets the bucket and key, for 5 minutes",
                u.hostname === "pwa-uploads-test.s3.us-east-2.amazonaws.com" && u.pathname === `/${key}` &&
                    u.searchParams.get("X-Amz-Expires") === "300" && put.method === "PUT" && put.key === key, put.url);
            check("real: Content-Type and Content-Length are signed, so S3 refuses any other type or size",
                u.searchParams.get("X-Amz-SignedHeaders") === "content-length;content-type;host" &&
                    put.headers["Content-Type"] === "image/webp", u.searchParams.get("X-Amz-SignedHeaders"));
            check("real: no checksum of an empty body is baked into the URL (it would fail the browser's upload)",
                ![...u.searchParams.keys()].some((k) => /checksum/i.test(k)), [...u.searchParams.keys()]);

            const read = await realIntegrations.uploads.readUrl({ key });
            const r = new URL(read.url);
            check("real: without CloudFront, reads are a presigned GET for an hour",
                r.hostname === "pwa-uploads-test.s3.us-east-2.amazonaws.com" && r.searchParams.get("X-Amz-Expires") === "3600" &&
                    !!r.searchParams.get("X-Amz-Signature") && read.expiresAt instanceof Date, read.url);
            process.env.UPLOADS_CDN_URL = "https://d1234.cloudfront.net/";
            const viaCdn = await realIntegrations.uploads.readUrl({ key });
            check("real: with UPLOADS_CDN_URL set, reads go through CloudFront", viaCdn.url === `https://d1234.cloudfront.net/${key}` && viaCdn.expiresAt === null, viaCdn);
        } finally {
            for (const k of ["UPLOADS_BUCKET", "UPLOADS_REGION", "UPLOADS_CDN_URL", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE"]) {
                if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
            }
        }
    } finally {
        uninstall();
        const ids = Object.values(who).map((p) => p.id);
        if (campaignIds.length) await pool.query(`DELETE FROM campaigns WHERE id = ANY($1)`, [campaignIds]);
        if (ids.length) {
            await pool.query(`DELETE FROM campaigns WHERE owner_id = ANY($1)`, [ids]);
            await pool.query(`DELETE FROM accounts WHERE id = ANY($1)`, [ids]);
        }
        server.close();
    }

    console.log(`\n  ${pass} passed, ${fail} failed\n`);
    await pool.end();
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
