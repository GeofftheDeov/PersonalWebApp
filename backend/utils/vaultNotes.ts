import fs from 'fs';
import path from 'path';
import { isServableVaultName, resolveVaultFile } from './vaultPath.js';

/**
 * Cloud-Claw's vault tools (readNote, searchVault): the paths come from the
 * model, so they are untrusted (#180). Both go through resolveVaultFile, the
 * vault browser's check, so the model sees exactly what the browser serves:
 * nothing under private/ or a dot folder, no traversal, and nothing a symlink
 * or junction leads to outside the vault.
 */

/** Reads one note by its vault-relative path, or says why not. */
export function readVaultNote(vaultRoot: string, rel: unknown): unknown {
  const file = resolveVaultFile(vaultRoot, rel);
  if (!file.ok) {
    return { error: file.reason === 'missing' ? 'Note not found' : 'Invalid path: use a forward-slash path relative to the vault root' };
  }
  try {
    return { path: file.rel, content: fs.readFileSync(file.full, 'utf-8') };
  } catch {
    return { error: 'Note could not be read' };
  }
}

/** Up to 10 notes whose name or text contains `query`, with an excerpt around the first match. */
export function searchVaultNotes(vaultRoot: string, query: string): unknown {
  const q = query.toLowerCase();
  const results: { path: string; excerpt: string }[] = [];

  function walk(dir: string, base: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (results.length >= 10) return;
      if (!isServableVaultName(e.name)) continue;
      const rel = base ? `${base}/${e.name}` : e.name;
      // Dirent doesn't follow links, so a symlinked folder is never walked;
      // a symlinked note is read only if it resolves inside the vault.
      if (e.isDirectory()) { walk(path.join(dir, e.name), rel); continue; }
      if (!e.name.endsWith('.md')) continue;
      const file = resolveVaultFile(vaultRoot, rel);
      if (!file.ok) continue;
      try {
        const text = fs.readFileSync(file.full, 'utf-8');
        if (text.toLowerCase().includes(q) || e.name.toLowerCase().includes(q)) {
          const idx = text.toLowerCase().indexOf(q);
          const excerpt = idx >= 0 ? text.slice(Math.max(0, idx - 50), idx + 150) : text.slice(0, 200);
          results.push({ path: rel, excerpt: '...' + excerpt.trim() + '...' });
        }
      } catch { /* skip */ }
    }
  }

  walk(vaultRoot, '');
  return { results };
}
