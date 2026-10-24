/**
 * Cloud-Claw's vault tools stay inside the vault (#180).
 *
 * readNote and searchVault take paths and queries from the model, so they are
 * untrusted. Builds a throwaway vault with a private/ folder, a dot folder, a
 * sibling folder named like the vault, and symlinks pointing out of it, then
 * checks neither tool reaches any of them. Needs no database:
 *   npx tsx scripts/test-cloudclaw-vault.ts
 */
import fs from "fs";
import path from "path";
import { readVaultNote, searchVaultNotes } from "../utils/vaultNotes.js";
import { createTempVault } from "./temp-vault.js";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
    const d = typeof detail === "string" ? detail : JSON.stringify(detail);
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !d ? "" : `\n          ${d}`}`);
    ok ? pass++ : fail++;
}

const SECRET = "zz-secret-marker";
const vault = createTempVault("t180");
const sibling = `${vault.dir}-sibling`;
fs.mkdirSync(sibling, { recursive: true });
fs.writeFileSync(path.join(sibling, "leak.md"), `${SECRET} sibling`, "utf-8");

try {
    vault.writeFile("projects/plan.md", "# Plan\n\nThe public plan mentions zz-public-marker.\n");
    vault.writeFile("private/.env", `ALPACA_SECRET_KEY=${SECRET}`);
    vault.writeFile("private/notes.md", `${SECRET} private note`);
    vault.writeFile(".obsidian/workspace.md", `${SECRET} dot folder`);

    // Links out of the vault and into private/. Junctions on Windows need no
    // privilege; a file symlink may, so that case is skipped when refused.
    let fileLink = false;
    try { fs.symlinkSync(path.join(sibling, "leak.md"), path.join(vault.dir, "link.md"), "file"); fileLink = true; } catch { /* no privilege */ }
    fs.symlinkSync(sibling, path.join(vault.dir, "outside"), "junction");
    fs.symlinkSync(path.join(vault.dir, "private"), path.join(vault.dir, "shadow"), "junction");

    const read = (rel: unknown) => readVaultNote(vault.dir, rel) as { content?: string; error?: string };
    const leaks = (r: { content?: string }) => (r.content ?? "").includes(SECRET);

    console.log("\nreadNote");
    const ok = read("projects/plan.md");
    check("reads a note in the vault", (ok.content ?? "").includes("zz-public-marker"), ok);
    for (const rel of [
        "private/notes.md", "private/.env", "Private/notes.md", "PRIVATE/notes.md", "private./notes.md",
        ".obsidian/workspace.md",
        "../" + path.basename(sibling) + "/leak.md", "projects/../private/notes.md",
        "outside/leak.md", "shadow/notes.md", ...(fileLink ? ["link.md"] : []),
        path.join(vault.dir, "private", "notes.md"), "private\\notes.md", "./projects/plan.md",
        "", 42, undefined,
    ]) {
        const r = read(rel);
        check(`refuses ${JSON.stringify(rel)}`, !leaks(r) && !!r.error, r);
    }
    const missing = read("projects/none.md");
    check("a missing note says so without its absolute path", missing.error === "Note not found", missing);
    if (!fileLink) console.log("  SKIP  file symlink (no privilege to create one)");

    console.log("\nsearchVault");
    const found = searchVaultNotes(vault.dir, "zz-public-marker") as { results: { path: string }[] };
    check("finds a note in the vault", found.results.some((r) => r.path === "projects/plan.md"), found);
    const hidden = searchVaultNotes(vault.dir, SECRET) as { results: { path: string; excerpt: string }[] };
    check("finds nothing under private/, dot folders or links out", hidden.results.length === 0, hidden);
    const byName = searchVaultNotes(vault.dir, "leak") as { results: unknown[] };
    check("a linked note isn't found by name either", byName.results.length === 0, byName);

    for (let i = 0; i < 15; i++) vault.writeFile(`many/a${i}/n.md`, "zz-many");
    const many = searchVaultNotes(vault.dir, "zz-many") as { results: unknown[] };
    check("stops at 10 results across folders", many.results.length === 10, many.results.length);
} finally {
    vault.remove();
    fs.rmSync(sibling, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
