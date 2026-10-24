import { describeError, ok, unavailable, type TileSource } from "../overview.js";
import { ago, centralDay, centralTime, esc, TIME_ZONE } from "../format.js";
import { readVaultTasks, VAULT_TASKS_FILE, type VaultTasks } from "../../utils/vaultTasks.js";

/**
 * The Tasks tile (#141): Notion tasks that need attention now, read from the
 * vault's Notion sync (raw/notion/tasks.md, utils/vaultTasks.ts) in the local
 * vault checkout. The backend's own Notion poll (jobs/workers.ts) isn't read:
 * it has no Notion credentials in prod or dev, so `tasks` never held a Notion
 * task (#141 follow-up).
 *
 * A task is listed when it isn't done (TASKS_DONE_STATUSES) and is due before
 * the end of tomorrow, in Central days: overdue first, then today, then
 * tomorrow. The counts cover every such task; the list stops at
 * TASKS_MAX_SHOWN. Read-only: nothing here writes to the vault or Notion.
 *
 * Due days. A Notion date with no time ("2026-10-13") is due on that date,
 * and its `due` is UTC midnight of it, so it sorts first in its day. A timed
 * due date (with its offset) falls on its Central day. A range is due at its end.
 *
 * The tile is unavailable when the vault isn't configured or the file can't
 * be read; a file without a readable `synced:` time is ok but never synced.
 *
 * The answers ticket (#147) reads `overview.tiles.tasks` as TasksTileData.
 */

/** At most this many tasks are listed; the rest are "+N more". */
export const TASKS_MAX_SHOWN = 7;
/**
 * The sync is flagged stale after this long: the vault syncs Notion nightly
 * at 2 AM Central (and at logon), and the backend pulls the vault every 10
 * minutes, so a day plus two hours of slack.
 */
export const TASKS_STALE_AFTER_MS = 26 * 60 * 60_000;
/** Tasks in these statuses (any case) are done and never listed. */
export const TASKS_DONE_STATUSES: readonly string[] = ["done", "completed", "complete"];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** The calendar day after a YYYY-MM-DD day. */
const nextDay = (day: string) => new Date(Date.parse(`${day}T12:00:00Z`) + 24 * 60 * 60_000).toISOString().slice(0, 10);

export type TaskBucket = "overdue" | "today" | "tomorrow";

export interface DueTask {
    /** The Notion page id. */
    id: string;
    /** As synced from Notion; escape before showing. */
    title: string;
    /** The Status as Notion names it ("Not started", "In progress", "backlog"); never a done status. */
    status: string;
    /** When it's due (ISO); UTC midnight of its day for a date-only due date. */
    due: string;
    /** The day it's due, YYYY-MM-DD (see "Due days" above). */
    dueDay: string;
    /** True for a Notion date with no time. */
    dateOnly: boolean;
    bucket: TaskBucket;
    notionPageId: string;
    /** The Notion page, or null when the vault's link isn't an https link. */
    url: string | null;
}

export interface TasksTileData {
    /** Today's Central day, YYYY-MM-DD. */
    today: string;
    /** Tomorrow's Central day, YYYY-MM-DD. */
    tomorrow: string;
    /** Every task due before the end of tomorrow, not just the shown ones. */
    counts: { overdue: number; today: number; tomorrow: number; total: number };
    /** The first TASKS_MAX_SHOWN, overdue first, then by due day and time. */
    tasks: DueTask[];
    /** counts.total - tasks.length. */
    more: number;
    /** When the vault last synced Notion (the file's `synced:`, ISO), or null if it doesn't say. */
    lastSync: string | null;
    /** now - lastSync, or null. */
    syncAgeMs: number | null;
    /** Older than TASKS_STALE_AFTER_MS, or never synced. */
    stale: boolean;
}

export const tasksTile: TileSource<TasksTileData> = {
    id: "tasks",
    title: "Tasks",
    href: `/admin/obsidian?path=${encodeURIComponent(VAULT_TASKS_FILE)}`,

    async build({ now }) {
        const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
        if (!vaultPath) return unavailable("the vault isn't configured (OBSIDIAN_VAULT_PATH)");
        let synced: VaultTasks;
        try {
            synced = await readVaultTasks(vaultPath);
        } catch (err: any) {
            return unavailable(err?.code === "ENOENT"
                ? `no Notion sync in the vault yet (${VAULT_TASKS_FILE})`
                : `${VAULT_TASKS_FILE} can't be read: ${describeError(err)}`);
        }

        const today = centralDay(now);
        const tomorrow = nextDay(today);
        const due: DueTask[] = [];
        for (const task of synced.tasks) {
            if (TASKS_DONE_STATUSES.includes(task.status.toLowerCase()) || !task.due) continue;
            const dateOnly = DATE_ONLY.test(task.due);
            const at = new Date(dateOnly ? `${task.due}T00:00:00Z` : task.due);
            if (Number.isNaN(at.getTime())) continue;
            const dueDay = dateOnly ? task.due : centralDay(at);
            if (dueDay > tomorrow) continue;
            due.push({
                id: task.pageId,
                title: task.title,
                status: task.status,
                due: at.toISOString(),
                dueDay,
                dateOnly,
                bucket: dueDay < today ? "overdue" : dueDay === today ? "today" : "tomorrow",
                notionPageId: task.pageId,
                url: task.url,
            });
        }
        // Due day, then due time, then title and id: the order the list and its cap use.
        const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
        due.sort((a, b) => cmp(a.dueDay, b.dueDay) || cmp(a.due, b.due) || cmp(a.title, b.title) || cmp(a.id, b.id));

        const n = (bucket: TaskBucket) => due.filter((t) => t.bucket === bucket).length;
        const tasks = due.slice(0, TASKS_MAX_SHOWN);
        const lastSync = synced.synced;
        const syncAgeMs = lastSync ? Math.max(0, now.getTime() - lastSync.getTime()) : null;

        return ok({
            today,
            tomorrow,
            counts: { overdue: n("overdue"), today: n("today"), tomorrow: n("tomorrow"), total: due.length },
            tasks,
            more: due.length - tasks.length,
            lastSync: lastSync ? lastSync.toISOString() : null,
            syncAgeMs,
            stale: syncAgeMs === null || syncAgeMs > TASKS_STALE_AFTER_MS,
        });
    },

    render(t, { now }) {
        const c = t.counts;
        const count = (n: number, label: string, warn = false) =>
            `<span class="task-count${warn && n > 0 ? " warn" : ""}"><b>${n}</b> ${label}</span>`;
        const head = `<div class="task-counts" data-tasks-counts>${count(c.overdue, "overdue", true)} · ${
            count(c.today, "today")} · ${count(c.tomorrow, "tomorrow")}</div>`;

        const sync = t.lastSync
            ? `synced ${esc(centralTime(new Date(t.lastSync), now))} · ${esc(ago(t.syncAgeMs ?? 0))}${
                t.stale ? ` · <span class="warn">no sync for over ${TASKS_STALE_AFTER_MS / 3_600_000} h</span>` : ""}`
            : `<span class="warn">never synced from Notion</span>`;
        const meta = `<div class="stat-meta">${sync}</div>`;

        if (c.total === 0) {
            return `${head}
            <div class="task-clear" data-tasks-state="clear"><span aria-hidden="true">✓</span> Nothing due</div>
            <div class="stat-delta">nothing overdue, due today or due tomorrow</div>
            ${meta}`;
        }

        const when = (task: DueTask) => {
            const day = new Date(`${task.dueDay}T12:00:00Z`)
                .toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
            const time = task.dateOnly ? "" : new Date(task.due)
                .toLocaleTimeString("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" });
            if (task.bucket === "overdue") return `due ${day}${time ? `, ${time}` : ""}`;
            return `${task.bucket}${time ? ` ${time}` : ""}`;
        };
        const items = t.tasks.map((task) => {
            const title = task.url
                ? `<a href="${esc(task.url)}" target="_blank" rel="noopener noreferrer">${esc(task.title)}</a>`
                : esc(task.title);
            const tag = task.bucket === "overdue" ? `<span class="task-tag">OVERDUE</span> ` : "";
            const progress = /^in progress$/i.test(task.status) ? ` · in progress` : "";
            return `<li data-bucket="${task.bucket}">${tag}<span class="task-title">${title}</span> <span class="muted">${
                esc(when(task))}${progress}</span></li>`;
        }).join("");
        const more = t.more > 0 ? `<div class="muted task-more">+${t.more} more</div>` : "";
        return `${head}
            <ul class="task-list">${items}</ul>${more}
            ${meta}`;
    },
};
