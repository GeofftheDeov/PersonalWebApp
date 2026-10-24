import fs from "fs";
import path from "path";
import { BRIEFS_DIR, briefDates, splitSay } from "../utils/briefs.js";

/**
 * Tier 2's vault context (spec #135 W3, #155): the allowlisted pages of the
 * local vault checkout (OBSIDIAN_VAULT_PATH) the model reads after the
 * overview, so it can answer about the brief, the trading book and projects.
 *
 *   vaultContext(vaultPath)   the <vault> section of the prompt; never throws
 *   isAllowedVaultPath(rel)   the allowlist, as a pure check on a vault-relative path
 *   readVaultPage(...)        one allowlisted page, bounded, through the guard
 *
 * The allowlist is three shapes, and nothing else is ever read:
 *
 *   outputs/briefs/YYYY-MM-DD.md                 the latest brief (its Say block dropped)
 *   projects/alpaca-trading-bot/market-state.md  the trading book's market state
 *   projects/<name>/index.md                     each project's index, one level only
 *
 * Never anything under private/ or raw/. That holds in code, not just by not
 * listing them: every path is checked against the allowlist both as asked and
 * after resolving it for real (symlinks, Windows junctions, the vault root's
 * own link), and must stay inside the vault. A link from an allowlisted path
 * into private/, raw/ or out of the vault is skipped, like a missing page.
 * (Between the check and the read a link could be swapped; that needs write
 * access to the checkout, which is pulled from git.)
 *
 * The section is capped at VAULT_CONTEXT_MAX_TOKENS, estimated at
 * CHARS_PER_TOKEN, so the whole prompt stays well under the rate card's 100K
 * long-prompt step. Pages go in a fixed order (brief, market state, projects
 * by folder name), each cut at VAULT_PAGE_MAX_CHARS; the page that crosses the
 * total cap is cut to fit and the rest are counted, not read. Same vault, same
 * section.
 *
 * Reads are synchronous and bounded: at most 2 + MAX_PROJECT_PAGES pages (plus
 * BRIEF_ATTEMPTS - 1 unreadable briefs), each read no further than its cap.
 */

/**
 * A conservative estimate: English prose runs about 4 characters per token,
 * and markdown with numbers and tables a little less; 3 over-counts tokens, so
 * the cap holds.
 */
export const CHARS_PER_TOKEN = 3;
/** The vault section's budget, about half the 100K-token price step. */
export const VAULT_CONTEXT_MAX_TOKENS = 50_000;
export const VAULT_CONTEXT_MAX_CHARS = VAULT_CONTEXT_MAX_TOKENS * CHARS_PER_TOKEN;
/** Per page, so one huge page can't crowd out the rest. */
export const VAULT_PAGE_MAX_CHARS = 30_000;
/** Project index pages read, in folder-name order. */
export const MAX_PROJECT_PAGES = 16;
/** The newest brief dates tried, in order, when the newest can't be read. */
export const BRIEF_ATTEMPTS = 3;
/** A page cut to fit the total keeps at least this much, or is left out. */
const MIN_CUT_CHARS = 1_000;

export const PROJECTS_DIR = "projects";
export const MARKET_STATE_PAGE = `${PROJECTS_DIR}/alpaca-trading-bot/market-state.md`;
/** Vault folders whose contents never leave the container. */
export const FORBIDDEN_ROOTS = ["private", "raw"] as const;

const ALLOWED: readonly RegExp[] = [
    /^outputs\/briefs\/\d{4}-\d{2}-\d{2}\.md$/i,
    /^projects\/alpaca-trading-bot\/market-state\.md$/i,
    /^projects\/[^/]+\/index\.md$/i,
];

/**
 * Whether a vault-relative path is one tier 2 may read: one of the three
 * allowlisted shapes, relative, with no empty, `.` or `..` segment, no drive
 * or stream colon, and never under private/ or raw/ (any case: the vault may
 * sit on a case-insensitive disk). Backslashes count as separators.
 */
export function isAllowedVaultPath(rel: string): boolean {
    if (typeof rel !== "string" || !rel || rel.includes("\0") || rel.includes(":")) return false;
    const p = rel.replace(/\\/g, "/");
    if (p.startsWith("/")) return false;
    const segments = p.split("/");
    if (segments.some((s) => s === "" || s === "." || s === "..")) return false;
    if ((FORBIDDEN_ROOTS as readonly string[]).includes(segments[0].toLowerCase())) return false;
    return ALLOWED.some((re) => re.test(p));
}

/** Cuts text to at most `max` UTF-16 units without splitting a surrogate pair. */
function cut(text: string, max: number): string {
    if (text.length <= max) return text;
    const end = /[\uD800-\uDBFF]/.test(text[max - 1] ?? "") ? max - 1 : max;
    return text.slice(0, Math.max(0, end));
}

export interface VaultPage {
    /** Vault-relative, with forward slashes. */
    path: string;
    text: string;
    /** The page was longer than its cap and was cut. */
    truncated: boolean;
}

/**
 * Reads one allowlisted page, at most `maxChars` of it. null when the path
 * isn't allowlisted, the page is missing or isn't a regular file, or it
 * resolves (through any link) outside the allowlist or the vault.
 */
export function readVaultPage(vaultPath: string, rel: string, maxChars = VAULT_PAGE_MAX_CHARS): VaultPage | null {
    if (!isAllowedVaultPath(rel)) return null;
    let fd: number | null = null;
    try {
        const root = fs.realpathSync.native(vaultPath);
        const real = fs.realpathSync.native(path.join(root, rel));
        const realRel = path.relative(root, real);
        if (!realRel || path.isAbsolute(realRel) || !isAllowedVaultPath(realRel)) return null;
        fd = fs.openSync(real, "r");
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) return null;
        // UTF-8 is at most 4 bytes a character: this many bytes hold maxChars + 1 characters.
        const buf = Buffer.alloc(Math.min(stat.size, (maxChars + 1) * 4));
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        const text = buf.subarray(0, n).toString("utf-8").replace(/^﻿/, "");
        return { path: rel.replace(/\\/g, "/"), text: cut(text, maxChars), truncated: text.length > maxChars };
    } catch {
        return null;
    } finally {
        if (fd !== null) try { fs.closeSync(fd); } catch { /* already closed */ }
    }
}

/** The allowlisted pages to try, in context order; each yields a page or null (skipped). */
function candidates(vaultPath: string): (() => VaultPage | null)[] {
    const brief = () => {
        for (const date of briefDates(vaultPath).slice(0, BRIEF_ATTEMPTS)) {
            const page = readVaultPage(vaultPath, `${BRIEFS_DIR}/${date}.md`);
            // The Say block repeats the Top 3 for speech: the body is enough.
            if (page) return { ...page, text: splitSay(page.text).body };
        }
        return null;
    };
    let projects: string[] = [];
    try {
        projects = fs.readdirSync(path.join(vaultPath, PROJECTS_DIR), { withFileTypes: true })
            .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith("."))
            .map((d) => d.name)
            .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
            .slice(0, MAX_PROJECT_PAGES);
    } catch { /* no projects folder */ }
    return [
        brief,
        () => readVaultPage(vaultPath, MARKET_STATE_PAGE),
        ...projects.map((name) => () => readVaultPage(vaultPath, `${PROJECTS_DIR}/${name}/index.md`)),
    ];
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Page text can't open or close a vault tag, so it can't end its page or the section early. */
const neutralise = (s: string) => s.replace(/<(\/?)(vault)/gi, "&lt;$1$2");

const OPEN = "<vault>\n";
const CLOSE = "\n</vault>";
const SEP = "\n\n";
const omittedNote = (n: number) => `(${n} more page${n === 1 ? "" : "s"} omitted: the vault context is capped)`;
/** Room kept for the omitted note: its longest form. */
const NOTE_ROOM = SEP.length + omittedNote(MAX_PROJECT_PAGES + 1).length;

function renderPage(page: VaultPage, text: string, truncated: boolean): string {
    return `<vault_page path="${escapeAttr(page.path)}"${truncated ? ' truncated="true"' : ""}>\n`
        + `${text}${truncated ? "\n[cut here]" : ""}\n</vault_page>`;
}

/**
 * The <vault> section of tier 2's context: the allowlisted pages that could
 * be read, within VAULT_CONTEXT_MAX_CHARS. Missing pages are skipped; with no
 * vault, or nothing readable, the section says so. Never throws.
 */
export function vaultContext(vaultPath: string | undefined): string {
    if (!vaultPath) return `<vault>(not configured: OBSIDIAN_VAULT_PATH is not set)</vault>`;
    try {
        if (!fs.existsSync(vaultPath)) return `<vault>(not available: the vault checkout isn't there)</vault>`;
        const parts: string[] = [];
        let room = VAULT_CONTEXT_MAX_CHARS - OPEN.length - CLOSE.length - NOTE_ROOM;
        const pending = candidates(vaultPath);
        let i = 0;
        for (; i < pending.length; i++) {
            const page = pending[i]();
            if (!page) continue;
            const text = neutralise(page.text);
            const whole = renderPage(page, text, page.truncated);
            const sep = parts.length ? SEP.length : 0;
            if (sep + whole.length <= room) {
                parts.push(whole);
                room -= sep + whole.length;
                continue;
            }
            // The page that crosses the cap is cut to fit, if enough of it would; the rest are counted.
            const overhead = sep + renderPage(page, "", true).length;
            if (room - overhead >= MIN_CUT_CHARS) {
                parts.push(renderPage(page, cut(text, room - overhead), true));
                i++;
            }
            break;
        }
        const omitted = pending.length - i;
        if (omitted > 0) parts.push(omittedNote(omitted));
        if (!parts.length) return `<vault>(no allowlisted vault pages could be read)</vault>`;
        return `${OPEN}${parts.join(SEP)}${CLOSE}`;
    } catch (err) {
        console.error("[os] tier 2 vault context failed:", (err as any)?.message ?? err);
        return `<vault>(not available: the vault couldn't be read)</vault>`;
    }
}
