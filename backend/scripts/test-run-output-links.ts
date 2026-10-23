/**
 * Run output paths open in the vault browser (spec #135, ticket #158).
 *
 * Mounts the real admin router (which carries /admin/briefs and the vault
 * browser at /admin/obsidian) and drives it over HTTP with an admin JWT, the
 * way the admin's browser does. Finished agent_runs rows are inserted with
 * output paths good and bad; the test follows the links the briefs page
 * renders into the vault browser, and asks the vault browser for paths that
 * escape the vault directly.
 *
 * agent_runs.output_path is whatever the runner sent, so it is untrusted: a
 * link is rendered only for a path that resolves to a file inside the vault.
 *
 * Run against a throwaway database loaded from db/schema.sql (it inserts and
 * deletes its own rows, and refuses to run against anything but localhost):
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-run-output-links.ts
 *
 * The briefs page lists the newest six runs, so give it a database no other
 * test is adding runs to at the same time.
 */
import "./use-test-jwt-secret.js";
import express from "express";
import type { AddressInfo } from "net";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pool from "../db/index.js";
import adminRoutes from "../routes/adminRoutes.js";
import { SKILLS } from "../services/agentRuns.js";
import { signJwt } from "../utils/jwt.js";
import { createTempVault } from "./temp-vault.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
    console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
    process.exit(2);
}

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
    const d = typeof detail === "string" ? detail : JSON.stringify(detail);
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !d ? "" : `\n          ${d}`}`);
    ok ? pass++ : fail++;
}

const htmlEscape = (s: string) => s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const unescapeHtml = (s: string) => s
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Every deep link into the vault browser on a page, as { href, path } (the nav's plain /admin/obsidian link is not one). */
function vaultLinks(html: string): { href: string; path: string }[] {
    return [...html.matchAll(/href="(\/admin\/obsidian\?[^"]*)"/g)]
        .map((m) => {
            const href = unescapeHtml(m[1]);
            return { href, path: new URL(href, "http://x").searchParams.get("path") as string };
        })
        .filter((l) => l.path !== null);
}

async function main() {
    const t158Vault = createTempVault("t158");
    process.env.OBSIDIAN_VAULT_PATH = t158Vault.dir;
    // A folder beside the vault whose name starts with the vault's: a prefix
    // check (startsWith) would let ../<vault>-sibling/ through.
    const t158Sibling = `${t158Vault.dir}-sibling`;
    const t158Outside = fs.mkdtempSync(path.join(os.tmpdir(), "t158-outside-"));
    const SECRET = `t158-outside-secret-${crypto.randomBytes(6).toString("hex")}`;
    const PRIVATE = `t158-private-note-${crypto.randomBytes(6).toString("hex")}`;

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use("/admin", adminRoutes);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const tag = crypto.randomBytes(4).toString("hex");
    let t158AdminId = "";
    let t158Token = "";
    const t158RunIds: number[] = [];

    const get = async (p: string) => {
        const sep = p.includes("?") ? "&" : "?";
        const res = await fetch(`${base}${p}${p.includes("token=") ? "" : `${sep}token=${encodeURIComponent(t158Token)}`}`, { redirect: "manual" });
        const text = await res.text();
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* html */ }
        return { status: res.status, text, json };
    };
    const fileApi = (rel: string) => get(`/admin/obsidian/api/file?path=${encodeURIComponent(rel)}`);
    const browser = (rel: string) => get(`/admin/obsidian?path=${encodeURIComponent(rel)}`);

    /** Replaces the run history with finished runs carrying these output paths, newest first. */
    const t158SetRuns = async (rows: { skill: string; output: string | null }[]) => {
        if (t158RunIds.length) await pool.query(`DELETE FROM agent_runs WHERE id = ANY($1)`, [t158RunIds.splice(0)]);
        // In the future, so they are the newest six whatever else the database holds.
        for (const [i, r] of rows.entries()) {
            const { rows: [run] } = await pool.query(
                `INSERT INTO agent_runs (skill, status, requested_at, claimed_at, finished_at, runner, summary, output_path, trigger)
                 VALUES ($1, 'succeeded', now() + interval '1 day' - $2 * interval '1 minute', now(), now(), $3, $4, $5, 'manual')
                 RETURNING id`,
                [r.skill, i, `t158-${tag}`, `t158 run ${i}`, r.output]);
            t158RunIds.push(Number(run.id));
        }
    };

    try {
        if (rowsLimitGuard(SKILLS.length)) throw new Error("more skills than the briefs page lists runs");
        const { rows: [admin] } = await pool.query(
            `INSERT INTO accounts (id, handle, email, app_role, app_role_source) VALUES (gen_random_uuid(), $1, $2, 'admin', 'manual') RETURNING id`,
            [`t158_${tag}`, `t158-admin-${tag}@example.test`]);
        t158AdminId = admin.id;
        t158Token = signJwt({ id: t158AdminId, email: `t158-admin-${tag}@example.test` }, { expiresIn: "1h" });

        // ── the vault ─────────────────────────────────────────────────────────
        const day = "2031-04-07";
        const t158Files: Record<string, string> = {};
        for (const k of SKILLS) {
            const rel = k.output(day);
            t158Files[rel] = `# ${k.label} output\n\nt158 ${k.id} ${tag}\n`;
            t158Vault.writeFile(rel, t158Files[rel]);
        }
        // Characters a URL must encode (? is not a legal Windows file name character).
        const awkward = "outputs/lint/t158 a&b #c=e+f;g'h.md";
        t158Vault.writeFile(awkward, `# awkward\n\nt158 awkward ${tag}\n`);
        t158Vault.writeFile("private/t158-secret.md", PRIVATE);
        fs.writeFileSync(path.join(t158Outside, "secret.md"), SECRET);
        fs.mkdirSync(t158Sibling, { recursive: true });
        fs.writeFileSync(path.join(t158Sibling, "secret.md"), SECRET);
        // A junction (no admin rights needed on Windows; a plain symlink elsewhere)
        // inside the vault whose real path is outside it, and one into private/.
        fs.symlinkSync(t158Outside, path.join(t158Vault.dir, "outputs", "t158-escape"), "junction");
        fs.symlinkSync(path.join(t158Vault.dir, "private"), path.join(t158Vault.dir, "outputs", "t158-private-link"), "junction");

        // ── every skill's output links to its file in the vault browser ───────
        {
            await t158SetRuns([...SKILLS.map((k) => ({ skill: k.id, output: k.output(day) })),
                { skill: "lint-wiki", output: awkward }]);
            const page = await get("/admin/briefs");
            check("the briefs page renders", page.status === 200, page.status);
            const links = vaultLinks(page.text);
            for (const rel of [...SKILLS.map((k) => k.output(day)), awkward]) {
                const link = links.find((l) => l.path === rel);
                check(`run output ${rel} is a vault-browser link`, !!link, links);
                if (!link) continue;
                check(`  its link carries the admin's token`,
                    new URL(link.href, base).searchParams.get("token") === t158Token, link.href);
                const opened = await get(link.href);
                check(`  following it opens the vault browser on that file`,
                    opened.status === 200 && opened.text.includes(`const INITIAL_PATH = ${JSON.stringify(rel)}`), opened.status);
                const unparsable = [...opened.text.matchAll(/<script>([\s\S]*?)<\/script>/g)].filter((m) => {
                    try { new Function(m[1]); return false; } catch { return true; }
                });
                check(`  and the page's scripts parse`, unparsable.length === 0, unparsable.map((m) => m[1].slice(0, 120)));
                const file = await fileApi(rel);
                const expected = rel === awkward ? `t158 awkward ${tag}` : t158Files[rel];
                check(`  and the vault browser serves that file's contents`,
                    file.status === 200 && file.json?.path === rel && file.json?.content.includes(expected.trim()),
                    { status: file.status, json: file.json });
            }
            check("each run output is linked once", links.length === SKILLS.length + 1, links);
        }

        // ── paths that escape the vault are rejected, and shown as plain text ─
        const escapes: [string, string][] = [
            ["dot-dot", "../t158-outside/secret.md"],
            ["dot-dot into a sibling sharing the vault's prefix", `../${path.basename(t158Sibling)}/secret.md`],
            ["dot-dot after a real folder", "outputs/briefs/../../../secret.md"],
            ["an absolute path", path.join(t158Outside, "secret.md")],
            ["an absolute path, forward slashes", path.join(t158Outside, "secret.md").replace(/\\/g, "/")],
            ["a root path", "/etc/passwd"],
            ["a drive-relative path", "C:secret.md"],
            ["a UNC path", "\\\\server\\share\\secret.md"],
            ["backslash traversal", "outputs\\..\\..\\secret.md"],
            ["encoded traversal", "%2e%2e/%2e%2e/secret.md"],
            ["encoded slash", "..%2Fsecret.md"],
            ["double-encoded traversal", "%252e%252e%252fsecret.md"],
            ["a junction out of the vault", "outputs/t158-escape/secret.md"],
            ["private/", "private/t158-secret.md"],
            ["Private/ in another case", "Private/t158-secret.md"],
            ["private. (Windows drops trailing dots)", "private./t158-secret.md"],
            ["a junction into private/", "outputs/t158-private-link/t158-secret.md"],
            ["a dot folder", ".git/config"],
        ];
        for (let i = 0; i < escapes.length; i += 6) {
            const batch = escapes.slice(i, i + 6);
            await t158SetRuns(batch.map(([, rel]) => ({ skill: "lint-wiki", output: rel })));
            const page = await get("/admin/briefs");
            const links = vaultLinks(page.text);
            for (const [label, rel] of batch) {
                check(`${label}: the run history shows it as text, not a link`,
                    page.status === 200 && !links.some((l) => l.path === rel)
                    && page.text.includes(`<span class="run-output muted" title="not a file in the vault">${htmlEscape(rel)}</span>`),
                    { links, rel });
            }
            check(`batch ${i / 6 + 1}: no links at all`, links.length === 0, links);
        }
        for (const [label, rel] of escapes) {
            const file = await fileApi(rel);
            check(`${label}: the vault browser's file API refuses it`,
                file.status === 400 && !file.text.includes(SECRET) && !file.text.includes(PRIVATE),
                { status: file.status, body: file.text.slice(0, 200) });
            const page = await browser(rel);
            check(`${label}: the deep link is refused`,
                page.status === 400 && !page.text.includes("const INITIAL_PATH = \"") && !page.text.includes(SECRET),
                { status: page.status });
        }
        {
            const nul = await fileApi("outputs/briefs/2031-04-07.md\u0000.png");
            check("a NUL byte in the path is refused", nul.status === 400, nul.status);
            const twice = await get(`/admin/obsidian/api/file?path=a.md&path=b.md`);
            check("a path given twice is refused", twice.status === 400, twice.status);
            const twicePage = await get(`/admin/obsidian?path=a.md&path=b.md`);
            check("a deep link given twice is refused", twicePage.status === 400, twicePage.status);
        }

        // ── a well-formed path whose file isn't in the checkout (yet) ─────────
        {
            const later = "outputs/lint/2031-04-08.md";
            // Legal on Linux, where the vault lives; it can't be made on Windows, so it is missing here too.
            const markup = `outputs/"><script>alert(1)</script>.md`;
            await t158SetRuns([{ skill: "lint-wiki", output: later }, { skill: "lint-wiki", output: markup },
                { skill: "lint-wiki", output: null }]);
            const page = await get("/admin/briefs");
            const missingSpan = (rel: string) => `<span class="run-output muted" title="not in the vault checkout (yet)">${htmlEscape(rel)}</span>`;
            check("a missing output is shown as text, not a link",
                page.status === 200 && vaultLinks(page.text).length === 0 && page.text.includes(missingSpan(later)), vaultLinks(page.text));
            check("an output path carrying markup is escaped, not rendered",
                page.text.includes(missingSpan(markup)) && !page.text.includes("<script>alert(1)</script>"));
            const markupDeep = await browser(markup);
            check("a deep link carrying markup is not found, and not echoed raw",
                markupDeep.status === 404 && !markupDeep.text.includes("<script>alert(1)</script>"), markupDeep.status);
            const file = await fileApi(later);
            check("the file API says a missing file is not found", file.status === 404, file.status);
            const deep = await browser(later);
            check("a deep link to a missing file is not found", deep.status === 404, deep.status);
            const folder = await fileApi("outputs/lint");
            check("a folder is not a file", folder.status === 404, folder.status);
        }

        // ── on Windows, an 8.3 short name for private/ is still private/ ──────
        {
            const short = await fileApi("PRIVAT~1/t158-secret.md");
            check("an 8.3 short name for private/ is not served",
                short.status !== 200 && !short.text.includes(PRIVATE), { status: short.status });
        }

        // ── what the tree lists, the browser opens ───────────────────────────
        {
            const percent = "outputs/lint/t158 image%20(1).md";
            const encodedDots = "outputs/lint/t158 %2e%2e.md";
            t158Vault.writeFile(percent, `t158 percent ${tag}`);
            t158Vault.writeFile(encodedDots, `t158 encoded dots ${tag}`);
            const tree = await get("/admin/obsidian/api/tree");
            const listed: string[] = [];
            const walk = (nodes: any[]) => nodes.forEach((n) => n.type === "file" ? listed.push(n.path) : walk(n.children ?? []));
            walk(tree.json?.tree ?? []);
            check("a name with an ordinary %-sequence is listed and opens",
                listed.includes(percent) && (await fileApi(percent)).status === 200, listed);
            check("a name with an encoded dot is neither listed nor opened",
                !listed.includes(encodedDots) && (await fileApi(encodedDots)).status === 400, listed);
            const unopenable = [];
            for (const rel of listed) if ((await fileApi(rel)).status !== 200) unopenable.push(rel);
            check("every note the tree lists opens", listed.length > 0 && unopenable.length === 0, unopenable);
        }

        // ── no vault configured ───────────────────────────────────────────────
        {
            delete process.env.OBSIDIAN_VAULT_PATH;
            const deep = await browser(SKILLS[0].output(day));
            process.env.OBSIDIAN_VAULT_PATH = t158Vault.dir;
            check("with no vault configured, a deep link says so (503)",
                deep.status === 503 && deep.text.includes("OBSIDIAN_VAULT_PATH is not set"), deep.status);
        }

        // ── the browser without a deep link, and the tree, are as before ──────
        {
            const plain = await get("/admin/obsidian");
            check("the vault browser still opens without a deep link",
                plain.status === 200 && plain.text.includes("const INITIAL_PATH = null"), plain.status);
            const tree = await get("/admin/obsidian/api/tree");
            const flat = JSON.stringify(tree.json);
            check("the tree still hides private/", tree.status === 200 && !flat.includes("t158-secret"), flat.slice(0, 300));
        }
    } finally {
        if (t158RunIds.length) await pool.query(`DELETE FROM agent_runs WHERE id = ANY($1)`, [t158RunIds]);
        if (t158AdminId) await pool.query(`DELETE FROM accounts WHERE id = $1`, [t158AdminId]);
        server.close();
        await pool.end();
        // Unlink the junctions first so removing the vault can't reach through them.
        for (const link of ["t158-escape", "t158-private-link"]) {
            try { fs.unlinkSync(path.join(t158Vault.dir, "outputs", link)); } catch { /* never made */ }
        }
        t158Vault.remove();
        fs.rmSync(t158Outside, { recursive: true, force: true });
        fs.rmSync(t158Sibling, { recursive: true, force: true });
    }

    console.log(`\n  ${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
}

/** The briefs page lists the newest six runs; the good-path batch needs every skill plus one. */
function rowsLimitGuard(skills: number) { return skills + 1 > 6; }

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
