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
    /** The markdown body, without its `## Say` section (the briefs page renders this). */
    body: string;
    /** The `## Say` section as plain prose, or null when there's none (or it's empty). */
    say: string | null;
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
        const { fields, body: full } = parseFrontmatter(raw);
        const { body, say } = splitSay(full);
        return { ...toMeta(date, fields), body, say };
    } catch {
        return null;
    }
}

/*
 * Speech (spec #135 W3, #152). The vault's /morning-brief skill ends the brief
 * with a spoken summary (obsidian-vault#11):
 *
 *   ## Say
 *
 *   Good morning. Sixty to ninety words of plain prose, leading with the Top 3.
 *
 * The section starts at a level-2 heading whose text is exactly "Say" (any
 * case, trailing spaces or closing #s allowed) and runs to the next level-1 or
 * level-2 heading, or the end of the file. Its lines are joined into
 * paragraphs (a blank line separates paragraphs) and any stray markdown is
 * stripped. An empty section counts as no Say block. Briefs written before the
 * Say block existed fall back to their `## Top 3` section (heading "Top 3" or
 * "Top three"): one line per top-level list item, as plain text.
 */
const SAY_HEADING = /^##[ \t]+say[ \t]*#*[ \t]*$/i;
const TOP3_HEADING = /^##[ \t]+top[ \t]+(?:3|three)[ \t]*#*[ \t]*$/i;
/** Ends a section: the next level-1 or level-2 heading. */
const SECTION_END = /^#{1,2}[ \t]/;

/** [start, end) line range of the section under the first heading matching `heading`, heading line included. */
function sectionRange(lines: string[], heading: RegExp): [number, number] | null {
    const start = lines.findIndex((l) => heading.test(l.trim()));
    if (start < 0) return null;
    let end = start + 1;
    while (end < lines.length && !SECTION_END.test(lines[end])) end++;
    return [start, end];
}

/** One line of markdown as plain text: links keep their text, emphasis and code marks go. */
export function plainText(md: string): string {
    return md
        .replace(/!?\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')                                  // [[page|alias]]
        .replace(/!?\[\[([^\]]+)\]\]/g, (_m, t: string) => t.split('#')[0].split('/').pop() || t) // [[path/page]]
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')                                          // [text](url), ![alt](src)
        .replace(/<https?:[^>]*>/g, '')                                                     // <https://…>
        .replace(/<[^>]+>/g, '')                                                            // inline HTML
        .replace(/`([^`]*)`/g, '$1')
        .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
        .replace(/(^|[^\w*])[*_](?=\S)(.+?)(?<=\S)[*_](?![\w*])/g, '$1$2')                  // *em*, _em_
        .replace(/\*/g, '')
        .replace(/^\s*>\s?/, '')                                                            // blockquote
        .replace(/\s+/g, ' ')
        .trim();
}

/** Paragraphs of plain text: lines joined with spaces, paragraphs with a blank line. */
function paragraphs(lines: string[]): string {
    const out: string[] = [];
    let current: string[] = [];
    for (const line of [...lines, '']) {
        const text = plainText(line);
        if (text) { current.push(text); continue; }
        if (current.length) out.push(current.join(' '));
        current = [];
    }
    return out.join('\n\n');
}

/** Splits the `## Say` section out of a brief body. */
export function splitSay(body: string): { body: string; say: string | null } {
    const lines = body.split(/\r?\n/);
    const range = sectionRange(lines, SAY_HEADING);
    if (!range) return { body, say: null };
    const say = paragraphs(lines.slice(range[0] + 1, range[1]));
    const rest = [...lines.slice(0, range[0]), ...lines.slice(range[1])].join('\n').replace(/\s+$/, '\n');
    return { body: rest, say: say || null };
}

const LIST_ITEM = /^ {0,3}(?:\d+[.)]|[-*+])[ \t]+/;

/** The `## Top 3` section as plain text, one line per top-level item; null when missing or empty. */
export function topThreeText(body: string): string | null {
    const lines = body.split(/\r?\n/);
    const range = sectionRange(lines, TOP3_HEADING);
    if (!range) return null;
    const section = lines.slice(range[0] + 1, range[1]);
    const items: string[] = [];
    for (const line of section) {
        if (LIST_ITEM.test(line)) items.push(line.replace(LIST_ITEM, ''));
        else if (line.trim() && items.length) items[items.length - 1] += ' ' + line.trim();
    }
    const text = items.length
        ? items.map(plainText).filter(Boolean).map((t) => /[.!?]$/.test(t) ? t : `${t}.`).join('\n')
        : paragraphs(section);
    return text || null;
}

/** Where spoken text came from: the Say block, the Top 3 fallback, or neither. */
export type BriefSpeechSource = 'say' | 'top3' | 'none';

export interface BriefSpeech {
    date: string;
    source: BriefSpeechSource;
    /** Plain text to speak; '' when `source` is 'none'. */
    text: string;
    status: string | null;
    generated: string | null;
}

/** What to say for a brief: its Say block, else its Top 3 as plain text, else nothing. */
export function briefSpeech(brief: Brief): BriefSpeech {
    const meta = { date: brief.date, status: brief.status, generated: brief.generated };
    if (brief.say) return { ...meta, source: 'say', text: brief.say };
    const top3 = topThreeText(brief.body);
    return top3 ? { ...meta, source: 'top3', text: top3 } : { ...meta, source: 'none', text: '' };
}
