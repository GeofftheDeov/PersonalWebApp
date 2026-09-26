import fs from 'fs';
import path from 'path';

/**
 * Morning briefs written by the vault's /morning-brief skill.
 *
 * The skill runs on Geoff's PC (Claude subscription), writes
 * outputs/briefs/YYYY-MM-DD.md into the Obsidian vault, and Obsidian Git pushes
 * it; this container sees it after the next vault pull (services/vaultSync.ts).
 * Each file starts with YAML frontmatter carrying its own run status:
 *
 *   date: 2026-09-26
 *   generated: 2026-09-26T06:47-05:00
 *   run: scheduled | manual
 *   status: ok | partial
 *   failed: [trading.account, email]
 */

export const BRIEFS_DIR = 'outputs/briefs';
const BRIEF_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;
export const BRIEF_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface BriefMeta {
    date: string;
    generated: string | null;
    run: string | null;
    status: string | null;
    failed: string[];
}

export interface Brief extends BriefMeta {
    body: string;
}

/**
 * Minimal frontmatter reader for the handful of flat keys the skill writes.
 * Not a YAML parser: `key: value` lines, trailing `# comments` dropped, and
 * `[a, b]` inline lists. Anything else is ignored rather than guessed at.
 */
export function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
    const text = raw.replace(/^﻿/, ''); // PowerShell-written files can carry a BOM
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!match) return { fields: {}, body: text };
    const fields: Record<string, string> = {};
    for (const line of match[1].split(/\r?\n/)) {
        const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
        if (!kv) continue;
        fields[kv[1]] = kv[2].replace(/\s+#.*$/, '').trim();
    }
    return { fields, body: text.slice(match[0].length) };
}

function parseList(value: string | undefined): string[] {
    if (!value) return [];
    const inner = value.replace(/^\[/, '').replace(/\]$/, '');
    return inner.split(',').map(s => s.trim()).filter(Boolean);
}

function toMeta(date: string, fields: Record<string, string>): BriefMeta {
    return {
        date,
        generated: fields.generated || null,
        run: fields.run || null,
        status: fields.status || null,
        failed: parseList(fields.failed),
    };
}

/** Newest first. Returns [] when the vault or the folder is missing. */
export function listBriefs(vaultPath: string, limit = 30): BriefMeta[] {
    const dir = path.join(vaultPath, BRIEFS_DIR);
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return []; }
    return names
        .map(n => n.match(BRIEF_FILE)?.[1])
        .filter((d): d is string => !!d)
        .sort()
        .reverse()
        .slice(0, limit)
        .map(date => {
            try {
                const { fields } = parseFrontmatter(fs.readFileSync(path.join(dir, `${date}.md`), 'utf-8'));
                return toMeta(date, fields);
            } catch {
                return toMeta(date, {});
            }
        });
}

/** `date` must match BRIEF_DATE — it is the only part of the path callers control. */
export function readBrief(vaultPath: string, date: string): Brief | null {
    if (!BRIEF_DATE.test(date)) return null;
    try {
        const raw = fs.readFileSync(path.join(vaultPath, BRIEFS_DIR, `${date}.md`), 'utf-8');
        const { fields, body } = parseFrontmatter(raw);
        return { ...toMeta(date, fields), body };
    } catch {
        return null;
    }
}
