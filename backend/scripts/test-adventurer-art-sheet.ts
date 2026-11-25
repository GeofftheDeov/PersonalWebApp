/**
 * An adventurer's art (#273) and full sheet (#274), from spec #198. Seam: the
 * HTTP API.
 *
 * Installs the recording integrations fake, mounts the real tabletop router and
 * drives it over HTTP with real JWTs against a throwaway database loaded from
 * db/schema.sql. Nothing reaches AWS.
 *
 *   POST   /api/tabletop/characters/:id/art/upload-url   the player or an admin: a presigned PUT (JPEG/PNG/WebP, 5 MB)
 *   POST   /api/tabletop/characters/:id/art              save the uploaded key as a piece (the first is the portrait)
 *   PUT    /api/tabletop/characters/:id/portrait         { artId }
 *   DELETE /api/tabletop/characters/:id/art/:artId       the portrait moves to the next piece
 *   POST   /api/tabletop/characters/:id/sheet/upload-url  a PDF or picture, 10 MB
 *   PUT    /api/tabletop/characters/:id/sheet            { key, name, size }, replacing the old copy
 *   DELETE /api/tabletop/characters/:id/sheet
 *   PUT    /api/tabletop/characters/:id                  { sheetUrl }: http(s) only
 *   GET    /api/tabletop/characters[/:id]                portraitUrl; the page adds art and sheet
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-adventurer-art-sheet.ts
 */
import "./use-test-jwt-secret.js";
import express from "express";
import type { AddressInfo } from "net";
import crypto from "crypto";
import pool from "../db/index.js";
import tabletopRoutes from "../routes/tabletopRoutes.js";
import { signJwt } from "../utils/jwt.js";
import { UploadsNotConfiguredError } from "../utils/integrations.js";
import { createFakeIntegrations } from "../testing/fakeIntegrations.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
    console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
    process.exit(2);
}

const MB = 1024 * 1024;

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
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // The best-effort delete of a replaced object finishes on a later tick.
    const settle = () => new Promise((r) => setTimeout(r, 50));

    const tag = crypto.randomBytes(4).toString("hex");
    const who: Record<string, { id: string; token: string }> = {};
    const call = async (method: string, path: string, as?: string, body?: unknown) => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (as) headers.authorization = `Bearer ${who[as].token}`;
        const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        return { status: res.status, json };
    };
    const C = (id = "", rest = "") => `/api/tabletop/characters${id ? `/${id}` : ""}${rest}`;
    const deleted = () => fake.calls("uploads.deleteObject").map((c) => c.args[0]);

    try {
        // owner plays it; mate shares its campaign; friend is the owner's friend;
        // stranger has no tie at all; admin is an admin.
        for (const name of ["owner", "mate", "friend", "stranger", "admin"]) {
            const email = `art-${name}-${tag}@example.test`;
            const { rows: [r] } = await pool.query(
                `INSERT INTO accounts (id, handle, email, first_name, app_role, app_role_source)
                 VALUES (gen_random_uuid(), $1, $2, $3, $4, 'manual') RETURNING id`,
                [`${name}_${tag}`, email, name, name === "admin" ? "admin" : "user"]);
            who[name] = { id: r.id, token: signJwt({ id: r.id, email }, { expiresIn: "1h" }) };
        }
        await pool.query(`UPDATE accounts SET friends = ARRAY[$2::uuid] WHERE id = $1`, [who.friend.id, who.owner.id]);
        const { rows: [{ id: camp }] } = await pool.query(`INSERT INTO campaigns (title) VALUES ($1) RETURNING id`, [`Art ${tag}`]);
        for (const name of ["owner", "mate"]) {
            await pool.query(
                `INSERT INTO campaign_members (campaign_id, person_id, first_name, status, is_active) VALUES ($1, $2, $3, 'Player', true)`,
                [camp, who[name].id, name]);
        }
        const made = await call("POST", C(), "owner", { name: "Kestrel Vane", campaign: camp });
        const kid = made.json?._id as string;
        const other = (await call("POST", C(), "mate", { name: "Brother Odran", campaign: camp })).json?._id as string;
        check("a new adventurer has no portrait, art or sheet", made.status === 201 && made.json.portraitUrl === null
            && Array.isArray(made.json.art) && !made.json.art.length && made.json.sheet === null, made);

        console.log("\nArt — uploading\n");

        const up = await call("POST", C(kid, "/art/upload-url"), "owner", { contentType: "image/webp", size: 1000 });
        const key = up.json?.key as string;
        check("the player gets a presigned upload URL", up.status === 200 && typeof up.json?.url === "string", up);
        check("…under this adventurer's prefix", new RegExp(`^character-art/${kid}/[0-9a-f-]{36}\\.webp$`).test(key ?? ""), key);
        check("…signed for the type and size asked", (() => {
            const c = fake.calls("uploads.presignPut").at(-1)?.args[0];
            return c?.contentType === "image/webp" && c?.contentLength === 1000;
        })());

        for (const [what, body] of [
            ["a GIF", { contentType: "image/gif", size: 1000 }],
            ["a PDF", { contentType: "application/pdf", size: 1000 }],
            ["over 5 MB", { contentType: "image/png", size: 5 * MB + 1 }],
            ["no size", { contentType: "image/png" }],
        ] as const) {
            const res = await call("POST", C(kid, "/art/upload-url"), "owner", body);
            check(`art that's ${what} is refused (400)`, res.status === 400 && typeof res.json?.error === "string", res);
        }
        for (const name of ["mate", "friend", "stranger"]) {
            const res = await call("POST", C(kid, "/art/upload-url"), name, { contentType: "image/png", size: 10 });
            check(`${name} can't ask to upload art (403)`, res.status === 403, res);
        }
        check("no login, no upload (401)", (await call("POST", C(kid, "/art/upload-url"), undefined, { contentType: "image/png", size: 10 })).status === 401);

        const first = await call("POST", C(kid, "/art"), "owner", { key });
        check("saving the key adds a piece", first.status === 200 && first.json?.art?.length === 1, first);
        check("…which is the portrait", first.json?.art?.[0]?.isPortrait === true && typeof first.json?.portraitUrl === "string", first);
        const again = await call("POST", C(kid, "/art"), "owner", { key });
        check("saving the same key again adds nothing", again.status === 200 && again.json?.art?.length === 1, again);

        const key2 = (await call("POST", C(kid, "/art/upload-url"), "owner", { contentType: "image/png", size: 10 })).json.key;
        const second = await call("POST", C(kid, "/art"), "owner", { key: key2 });
        check("a second piece is added after the first", second.json?.art?.length === 2 && second.json.art[1].url.includes(key2), second);
        check("…and the portrait stays the first", second.json?.art?.[0]?.isPortrait && !second.json.art[1].isPortrait, second);

        const theirsKey = (await call("POST", C(other, "/art/upload-url"), "mate", { contentType: "image/png", size: 10 })).json.key;
        for (const [what, k] of [
            ["another adventurer's key", theirsKey],
            ["a key with another prefix", `campaign-banners/${kid}/${crypto.randomUUID()}.png`],
            ["a key with ..", `character-art/${kid}/../x.png`],
            ["no key", undefined],
        ] as const) {
            const res = await call("POST", C(kid, "/art"), "owner", { key: k });
            check(`saving ${what} is refused (400)`, res.status === 400, res);
        }
        check("mate can't save art on someone else's adventurer (403)",
            (await call("POST", C(kid, "/art"), "mate", { key: key2 })).status === 403);
        const byAdmin = await call("POST", C(kid, "/art/upload-url"), "admin", { contentType: "image/jpeg", size: 10 });
        check("an admin may upload art", byAdmin.status === 200, byAdmin);

        console.log("\nArt — the portrait and removing\n");

        const secondId = second.json.art[1]._id, firstId = second.json.art[0]._id;
        const made2 = await call("PUT", C(kid, "/portrait"), "owner", { artId: secondId });
        check("make this the portrait", made2.status === 200 && made2.json.art.find((a: any) => a.isPortrait)?._id === secondId, made2);
        check("…another's piece can't be (404)", (await call("PUT", C(kid, "/portrait"), "owner", { artId: crypto.randomUUID() })).status === 404);
        check("…nor can mate choose it (403)", (await call("PUT", C(kid, "/portrait"), "mate", { artId: firstId })).status === 403);

        const list = await call("GET", C(), "owner");
        check("the roster carries the portrait", list.json?.find((c: any) => c._id === kid)?.portraitUrl?.includes(key2), list.json);
        const party = await call("GET", C("", `?campaign=${camp}`), "mate");
        check("the party list carries it too", party.json?.find((c: any) => c._id === kid)?.portraitUrl?.includes(key2), party.json);
        check("…and no storage details", party.json?.every((c: any) => !("sheetKey" in c) && !("portraitArt" in c)), party.json);

        check("mate can't remove a piece (403)", (await call("DELETE", C(kid, `/art/${secondId}`), "mate")).status === 403);
        const before = deleted().length;
        const removed = await call("DELETE", C(kid, `/art/${secondId}`), "owner");
        await settle();
        check("removing the portrait moves it to the next piece",
            removed.status === 200 && removed.json.art.length === 1 && removed.json.art[0]._id === firstId && removed.json.art[0].isPortrait, removed);
        check("…and deletes its object", deleted().length === before + 1 && deleted().at(-1) === key2, deleted());
        check("removing it again is a 404", (await call("DELETE", C(kid, `/art/${secondId}`), "owner")).status === 404);
        const last = await call("DELETE", C(kid, `/art/${firstId}`), "owner");
        check("removing the last piece leaves no portrait", last.status === 200 && !last.json.art.length && last.json.portraitUrl === null, last);
        await call("POST", C(kid, "/art"), "owner", { key: (await call("POST", C(kid, "/art/upload-url"), "owner", { contentType: "image/png", size: 10 })).json.key });

        console.log("\nThe sheet — a link\n");

        const link = await call("PUT", C(kid), "owner", { sheetUrl: "  https://www.dndbeyond.com/characters/123  " });
        check("the player links the sheet", link.status === 200 && link.json?.sheetUrl === "https://www.dndbeyond.com/characters/123", link);
        for (const [what, url] of [
            ["a javascript: URL", "javascript:alert(1)"],
            ["a data: URL", "data:text/html,hi"],
            ["something that isn't a URL", "my sheet"],
            ["a number", 7],
            ["a link over 2,000 characters", `https://x.test/${"a".repeat(2000)}`],
        ] as const) {
            const res = await call("PUT", C(kid), "owner", { sheetUrl: url });
            check(`${what} is refused (400)`, res.status === 400, res);
        }
        check("mate can't change the link (403)", (await call("PUT", C(kid), "mate", { sheetUrl: "https://evil.test" })).status === 403);
        const madeWithLink = await call("POST", C(), "owner", { name: "Linked", sheetUrl: "http://sheets.test/1" });
        check("a link may be given when creating", madeWithLink.status === 201 && madeWithLink.json.sheetUrl === "http://sheets.test/1", madeWithLink);
        check("…and checked there too", (await call("POST", C(), "owner", { name: "Bad", sheetUrl: "ftp://x" })).status === 400);

        console.log("\nThe sheet — an uploaded copy\n");

        const sUp = await call("POST", C(kid, "/sheet/upload-url"), "owner", { contentType: "application/pdf", size: 2 * MB });
        check("the player gets an upload URL for a PDF", sUp.status === 200
            && new RegExp(`^character-sheets/${kid}/[0-9a-f-]{36}\\.pdf$`).test(sUp.json?.key ?? ""), sUp);
        check("…10 MB at most", (await call("POST", C(kid, "/sheet/upload-url"), "owner", { contentType: "application/pdf", size: 10 * MB + 1 })).status === 400);
        check("…a PDF or a picture only", (await call("POST", C(kid, "/sheet/upload-url"), "owner", { contentType: "text/html", size: 10 })).status === 400);
        check("mate can't upload one (403)", (await call("POST", C(kid, "/sheet/upload-url"), "mate", { contentType: "application/pdf", size: 10 })).status === 403);

        const saved = await call("PUT", C(kid, "/sheet"), "owner", { key: sUp.json.key, name: "C:\\fakepath\\Kestrel.pdf", size: 2 * MB });
        check("saving the copy keeps its name, type and size", saved.status === 200 && saved.json?.sheet?.name === "Kestrel.pdf"
            && saved.json.sheet.contentType === "application/pdf" && saved.json.sheet.size === 2 * MB && typeof saved.json.sheet.url === "string", saved);
        const read = fake.calls("uploads.readUrl").at(-1)?.args[0];
        check("…read through a private presigned GET that names the file",
            read?.private === true && /filename\*=UTF-8''Kestrel\.pdf/.test(read?.contentDisposition ?? ""), read);
        check("saving another adventurer's sheet key is refused (400)",
            (await call("PUT", C(kid, "/sheet"), "owner", { key: sUp.json.key.replace(kid, other), name: "x.pdf" })).status === 400);
        check("mate can't save one (403)", (await call("PUT", C(kid, "/sheet"), "mate", { key: sUp.json.key })).status === 403);

        const sUp2 = await call("POST", C(kid, "/sheet/upload-url"), "owner", { contentType: "image/png", size: 500 });
        const replaced = await call("PUT", C(kid, "/sheet"), "owner", { key: sUp2.json.key, name: "page1.png", size: 500 });
        await settle();
        check("a new copy replaces the old", replaced.json?.sheet?.name === "page1.png" && replaced.json.sheet.contentType === "image/png", replaced);
        check("…whose object is deleted", deleted().at(-1) === sUp.json.key, deleted());

        console.log("\nWho sees what\n");

        for (const name of ["owner", "mate", "friend", "admin"]) {
            const page = await call("GET", C(kid), name);
            check(`${name} reads the art, the portrait and the sheet`, page.status === 200 && page.json.art?.length === 1
                && typeof page.json.portraitUrl === "string" && page.json.sheetUrl === "https://www.dndbeyond.com/characters/123"
                && page.json.sheet?.name === "page1.png", page);
            check(`…without storage details (${name})`, page.json && !("sheetKey" in page.json) && !("portraitArt" in page.json), page.json);
        }
        const strangerRead = await call("GET", C(kid), "stranger");
        check("a stranger is refused, with no art or sheet", strangerRead.status === 403 && !("art" in (strangerRead.json ?? {})), strangerRead);

        const cleared = await call("DELETE", C(kid, "/sheet"), "owner");
        await settle();
        check("the player removes the copy", cleared.status === 200 && cleared.json.sheet === null && deleted().at(-1) === sUp2.json.key, cleared);
        const unlinked = await call("PUT", C(kid), "owner", { sheetUrl: "" });
        check("…and clears the link with \"\"", unlinked.status === 200 && unlinked.json.sheetUrl === null, unlinked);

        console.log("\nUploads switched off\n");

        fake.fail("uploads.presignPut", new UploadsNotConfiguredError());
        const off = await call("POST", C(kid, "/art/upload-url"), "owner", { contentType: "image/png", size: 10 });
        check("asking to upload says it isn't set up (503)", off.status === 503, off);
        fake.fail("uploads.readUrl", new UploadsNotConfiguredError(), { times: 5 });
        const noUrls = await call("GET", C(kid), "owner");
        check("the page still loads, without art URLs", noUrls.status === 200 && noUrls.json.art.length === 1 && noUrls.json.art[0].url === null, noUrls);
    } finally {
        uninstall();
        server.close();
        await pool.end();
    }

    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
