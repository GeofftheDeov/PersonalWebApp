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
 *     control characters, or encoded `.`, `/`, `\`, NUL or % (%2e %2f %5c %00 %25);
 *   - no empty, `.` or `..` segments, and no segment ending in `.` or a space
 *     (Windows drops those, so `private.` would open `private`);
 *   - nothing the vault tree hides: dot entries (.git, .obsidian) and the
 *     VAULT_HIDDEN folders, `private/` above all, matched in any case;
 *   - and the file's real path, after symlinks, junctions and 8.3 short names,
 *     must still be inside the vault's real path and outside the hidden folders.
 * The tree (adminRoutes buildVaultTree) lists only names that pass, so every
 * note it shows opens.
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

/**
 * Whether one file or folder name may appear in a vault path the browser serves.
 * The vault tree lists only these, so everything it shows opens.
 * %2e, %2f, %5c and %00 are refused (encoded traversal, should anything decode
 * the path again), and %25 (so is its double encoding); other %-sequences,
 * like a downloaded file's %20, are ordinary characters in a file name.
 */
export function isServableVaultName(name: string): boolean {
    return name !== '' && name.length <= 255 && !isHiddenVaultName(name) && !/[. ]$/.test(name)
        && !/[\u0000-\u001f\u007f\\/:]|%(2e|2f|5c|00|25)/i.test(name);
}

/** The path's segments if it is a canonical vault-relative path the browser may serve, else null. */
function vaultSegments(rel: unknown): string[] | null {
    if (typeof rel !== 'string' || rel.length === 0 || rel.length > MAX_LENGTH) return null;
    const segments = rel.split('/');
    return segments.every(isServableVaultName) ? segments : null;
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
    // The OS's own realpath: it follows symlinks and junctions and, on Windows,
    // also expands 8.3 short names (PRIVAT~1 is private), which the JS one doesn't.
    let root: string;
    try { root = fs.realpathSync.native(vaultRoot); } catch { return { ok: false, reason: 'missing' }; }
    let real: string;
    try { real = fs.realpathSync.native(path.join(root, ...segments)); } catch { return { ok: false, reason: 'missing' }; }
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
