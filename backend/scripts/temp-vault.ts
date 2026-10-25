import fs from "fs";
import os from "os";
import path from "path";
import { BRIEFS_DIR } from "../utils/briefs.js";

/**
 * A throwaway vault checkout for the test scripts: the spec's tests point
 * OBSIDIAN_VAULT_PATH at a temporary directory, never the real vault.
 *
 *   const vault = createTempVault("t142");
 *   process.env.OBSIDIAN_VAULT_PATH = vault.dir;
 *   vault.writeBrief("2026-10-12", { status: "partial", failed: "[email]" });
 *   ...
 *   vault.remove();
 *
 * Brief frontmatter is written as given, one `key: value` line per field, the
 * way the vault's /morning-brief skill writes it (utils/briefs.ts).
 */
export interface TempVault {
    dir: string;
    /** Writes outputs/briefs/<date>.md; `date` is added to the frontmatter unless given. */
    writeBrief(date: string, fields?: Record<string, string>, body?: string): string;
    /** Writes any file under the vault, creating its folders. */
    writeFile(relPath: string, content: string): string;
    /** Deletes one file under the vault, if it's there. */
    removeFile(relPath: string): void;
    /** Deletes every brief, leaving an empty outputs/briefs/. */
    clearBriefs(): void;
    /** Deletes the whole vault directory. */
    remove(): void;
}

export function createTempVault(prefix: string): TempVault {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-vault-`));
    const briefs = path.join(dir, BRIEFS_DIR);
    fs.mkdirSync(briefs, { recursive: true });

    const writeFile = (relPath: string, content: string) => {
        const file = path.join(dir, relPath);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, "utf-8");
        return file;
    };

    return {
        dir,
        writeBrief(date, fields = {}, body = "## Top 3\n\n1. Something\n") {
            const front = Object.entries({ date, ...fields }).map(([k, v]) => `${k}: ${v}`).join("\n");
            return writeFile(path.join(BRIEFS_DIR, `${date}.md`), `---\n${front}\n---\n\n${body}`);
        },
        writeFile,
        removeFile(relPath) {
            fs.rmSync(path.join(dir, relPath), { force: true });
        },
        clearBriefs() {
            for (const name of fs.readdirSync(briefs)) fs.rmSync(path.join(briefs, name), { force: true });
        },
        remove() {
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}
