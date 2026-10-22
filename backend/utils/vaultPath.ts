import fs from 'fs';
import path from 'path';

/**
 * Resolving a vault-relative path to a file inside the vault checkout, for the
 * admin vault browser (/admin/obsidian) and the links into it (#158).
 *
 * The paths come from query strings and from agent_runs.output_path, which is
 * whatever the PC runner sent, so they are untrusted. Only a canonical,
 * forward-slash relative path is accepted; nothing is normalised into shape,
 * so the path that is checked is the path that is shown and linked:
 *   - no absolute paths, drive letters (any `:`), backslashes, NUL or other
 *     control characters, or %-escapes (no encoded traversal to decode later);
 *   - no empty, `.` or `..` segments, and no segment ending in `.` or a space
 *     (Windows drops those, so `private.` would open `private`);
 *   - nothing the vault tree hides: dot entries (.git, .obsidian) and the
 *     VAULT_HIDDEN folders, `private/` above all, matched in any case;
 *   - and the file's real path, after symlinks and junctions, must still be
 *     inside the vault's real path and outside the hidden folders.
 */

/** Folders the vault browser never lists or serves (besides dot entries). */
export const VAULT_HIDDEN = new Set(['private', 'node_modules']);

export type VaultFile =
    | { ok: true; rel: string; full: string }
    /** invalid: not a canonical relative path, or it names something hidden or outside the vault. missing: no such file in the checkout. */
    | { ok: false; reason: 'invalid' | 'missing' };

const MAX_LENGTH = 1024;

/** A dot entry or a hidden folder: what the vault tree leaves out. */
export const isHiddenVaultName = (name: string) => name.startsWith('.') || VAULT_HIDDEN.has(name.toLowerCase());

/** The path's segments if it is a canonical vault-relative path the browser may serve, else null. */
function vaultSegments(rel: unknown): string[] | null {
    if (typeof rel !== 'string' || rel.length === 0 || rel.length > MAX_LENGTH) return null;
    if (/[\u0000-\u001f\u007f\\:]|%[0-9a-f]{2}/i.test(rel)) return null;
    const segments = rel.split('/');
    for (const s of segments) {
        if (s === '' || s === '.' || s === '..' || /[. ]$/.test(s) || isHiddenVaultName(s)) return null;
    }
    return segments;
}

/** Whether `p` is strictly inside `root` (both absolute); not a prefix test, so /vault-sibling is outside /vault. */
function isInside(root: string, p: string): boolean {
    const r = path.relative(root, p);
    return r !== '' && r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r);
}

/** Resolves `rel` to a file inside the vault at `vaultRoot`, or says why not. Reads the filesystem (realpath, stat). */
export function resolveVaultFile(vaultRoot: string, rel: unknown): VaultFile {
    const segments = vaultSegments(rel);
    if (!segments) return { ok: false, reason: 'invalid' };
    let root: string;
    try { root = fs.realpathSync(vaultRoot); } catch { return { ok: false, reason: 'missing' }; }
    const full = path.join(root, ...segments);
    if (!isInside(root, full)) return { ok: false, reason: 'invalid' };
    let real: string;
    try { real = fs.realpathSync(full); } catch { return { ok: false, reason: 'missing' }; }
    // A symlink or junction may lead out of the vault, or into a hidden folder.
    if (!isInside(root, real) || path.relative(root, real).split(path.sep).some(isHiddenVaultName)) {
        return { ok: false, reason: 'invalid' };
    }
    try { if (!fs.statSync(real).isFile()) return { ok: false, reason: 'missing' }; }
    catch { return { ok: false, reason: 'missing' }; }
    return { ok: true, rel: rel as string, full: real };
}

/** The vault browser opened on `rel`; the caller has resolved it. Token and path are URL-encoded; HTML-escape the result for an attribute. */
export const vaultBrowserHref = (rel: string, token: string) =>
    `/admin/obsidian?path=${encodeURIComponent(rel)}&token=${encodeURIComponent(token)}`;
