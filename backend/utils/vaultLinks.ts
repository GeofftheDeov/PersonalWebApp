import fs from 'fs';
import path from 'path';
import { isServableVaultName, vaultBrowserHref } from './vaultPath.js';

/** Every note the vault browser lists, by vault-relative `/`-separated path, e.g. `projects/salesforce/index.md`. */
export function listVaultNotes(dir: string, base = ''): string[] {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    return entries.flatMap(e => {
        if (!isServableVaultName(e.name)) return [];  // the same names the vault tree leaves out
        const rel = (base ? base + '/' : '') + e.name;
        if (e.isDirectory()) return listVaultNotes(path.join(dir, e.name), rel);
        return e.name.endsWith('.md') ? [rel] : [];
    });
}

/**
 * Resolves wikilink targets the way Obsidian does for the forms the vault
 * uses: a full path (`projects/salesforce/index`), a partial path or bare
 * note name matched against the end of a path (shortest path wins), with any
 * `#heading` / `^block` suffix ignored. Case-insensitive. Returns the note's
 * vault-relative path, or null when nothing matches.
 */
export function wikiLinkResolver(vaultPath: string): (target: string) => string | null {
    const notes = listVaultNotes(vaultPath);
    const byLower = new Map(notes.map(n => [n.toLowerCase(), n]));
    return (target: string) => {
        let t = target.split('#')[0].trim().replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '').toLowerCase();
        if (!t) return null;
        if (!t.endsWith('.md')) t += '.md';
        const exact = byLower.get(t);
        if (exact) return exact;
        const suffix = '/' + t;
        let best: string | null = null;
        for (const [lower, note] of byLower) {
            if (lower.endsWith(suffix) && (!best || note.length < best.length)) best = note;
        }
        return best;
    };
}

/** renderMarkdown's wikiLinkHref: each wikilink opens its note in the admin vault browser. */
export function vaultWikiLinkHref(vaultPath: string, token: string): (target: string) => string | null {
    const resolve = wikiLinkResolver(vaultPath);
    return (target) => {
        const note = resolve(target);
        return note ? vaultBrowserHref(note, token) : null;
    };
}
