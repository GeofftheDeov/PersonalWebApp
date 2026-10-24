import fs from 'fs';
import path from 'path';
import { parseFrontmatter } from './briefs.js';

/**
 * Notion tasks as the vault's Notion sync writes them.
 *
 * The vault's scripts/notion_sync.py runs on Geoff's PC (nightly at 2 AM and
 * at logon), rewrites raw/notion/tasks.md from the whole Notion Tasks
 * database, and pushes it; this container sees it after the next vault pull
 * (services/vaultSync.ts). The file is rewritten whole or not at all, so a
 * task archived in Notion drops out on the next sync.
 *
 *   ---
 *   notion_db: tasks
 *   synced: 2026-10-23 07:00 UTC
 *   ---
 *   ... a summary table (values cut to 80 characters) ...
 *   ## Pages
 *
 *   ### Create Campaign Member Invite button
 *
 *   [Open in Notion](https://app.notion.com/p/Create-...-34c7cb8daee18007acccda9656e81a30) · Created: 2026-04-24 · Edited: 2026-05-22
 *
 *   **Due date:** 2026-05-08
 *   **Status:** In progress
 *   ... the page body ...
 *
 * Only the `## Pages` sections are read: they carry full values and the page
 * link. A page starts at a `### ` heading whose next non-blank line is its
 * "Open in Notion" link (a heading in a page body has no such line), and its
 * properties are the `**Name:** value` lines right after that.
 */

export const VAULT_TASKS_FILE = 'raw/notion/tasks.md';

export interface VaultTask {
    /** The Notion page id, 32 lowercase hex digits. */
    pageId: string;
    /** The page's "Open in Notion" link, or null when it isn't an https link. */
    url: string | null;
    /** As synced (Notion rich text rendered as markdown); escape before showing. */
    title: string;
    /** The Status property as Notion names it ("Not started", "In progress", "Done", "backlog"), or "" when unset. */
    status: string;
    /**
     * The Due date property: "2026-05-08" for a date with no time, else an ISO
     * time with its offset. For a range ("start → end") it's the end. Null when unset.
     */
    due: string | null;
}

export interface VaultTasks {
    /** The `synced:` time in the frontmatter, or null when it's missing or unreadable. */
    synced: Date | null;
    tasks: VaultTask[];
}

const PAGE_LINK = /^\[Open in Notion\]\(([^)\s]+)\)/;
const PROPERTY = /^\*\*(.+?):\*\*\s?(.*?)\s*$/;
const PAGE_ID = /([0-9a-f]{32})(?:[?#]|$)/i;

/** `2026-10-23 07:00 UTC`, as notion_sync.py writes it. */
function parseSynced(value: string | undefined): Date | null {
    const m = value?.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?\s*UTC$/);
    return m ? new Date(`${m[1]}T${m[2]}:00Z`) : null;
}

/** The property named like `name` (any case), or undefined. */
const prop = (props: Map<string, string>, ...names: string[]) => {
    for (const [k, v] of props) if (names.includes(k.toLowerCase())) return v;
    return undefined;
};

export function parseVaultTasks(raw: string): VaultTasks {
    const { fields, body } = parseFrontmatter(raw);
    const lines = body.split(/\r?\n/);
    const tasks: VaultTask[] = [];
    let i = lines.findIndex(l => /^##\s+Pages\s*$/.test(l));
    if (i < 0) return { synced: parseSynced(fields.synced), tasks };

    for (i++; i < lines.length; i++) {
        const heading = lines[i].match(/^###\s+(.*?)\s*$/);
        if (!heading) continue;
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        const link = lines[j]?.match(PAGE_LINK);
        const pageId = link?.[1].match(PAGE_ID)?.[1];
        if (!link || !pageId) continue;

        const props = new Map<string, string>();
        for (j++; j < lines.length && !lines[j].trim(); j++);
        for (; j < lines.length; j++) {
            const p = lines[j].match(PROPERTY);
            if (!p) break;
            props.set(p[1].trim(), p[2]);
        }
        const due = prop(props, 'due date', 'due')?.split('→').pop()?.trim() || null;
        tasks.push({
            pageId: pageId.toLowerCase(),
            url: /^https:\/\//i.test(link[1]) ? link[1] : null,
            title: heading[1],
            status: prop(props, 'status')?.trim() ?? '',
            due,
        });
        i = j - 1;
    }
    return { synced: parseSynced(fields.synced), tasks };
}

/** Throws when the file can't be read (no vault, or no sync yet: ENOENT). */
export async function readVaultTasks(vaultPath: string): Promise<VaultTasks> {
    return parseVaultTasks(await fs.promises.readFile(path.join(vaultPath, VAULT_TASKS_FILE), 'utf-8'));
}
