import { ok, type TileSource } from "../overview.js";
import { ago, centralTime, esc, TIME_ZONE } from "../format.js";

/**
 * The Tasks tile (#141): Notion-synced tasks that need attention now, from the
 * `tasks` table the BullMQ Notion poll (jobs/workers.ts) keeps up to date.
 *
 * A task is listed when it has a Notion page id, isn't Completed, and is due
 * before the end of tomorrow, in Central days: overdue first, then today, then
 * tomorrow. The counts cover every such task; the list stops at
 * TASKS_MAX_SHOWN. Read-only: nothing here writes to tasks or Notion.
 *
 * Due days. A Notion date with no time ("2026-10-13") is stored as UTC
 * midnight of that date (`new Date("2026-10-13")`), which is the Central
 * evening before. A due_date at exactly 00:00:00 UTC is therefore read as a
 * date-only due date on its UTC date; any other due_date falls on its Central
 * day. (A timed task due at exactly 7 PM CDT / 6 PM CST lands a day late.)
 *
 * The answers ticket (#147) reads `overview.tiles.tasks` as TasksTileData.
 */

/** At most this many tasks are listed; the rest are "+N more". */
export const TASKS_MAX_SHOWN = 7;
/** The sync is flagged stale after this long. The BullMQ poll runs every 15 minutes. */
export const TASKS_STALE_AFTER_MS = 60 * 60_000;
/** Tasks in this status are done and never listed. */
export const TASKS_DONE_STATUS = "Completed";

export type TaskBucket = "overdue" | "today" | "tomorrow";

export interface DueTask {
    id: string;
    /** As synced from Notion; escape before showing. */
    title: string;
    /** "Not Started" or "In Progress" (never Completed). */
    status: string;
    /** The stored due_date (ISO). */
    due: string;
    /** The day it's due, YYYY-MM-DD (see "Due days" above). */
    dueDay: string;
    /** True for a Notion date with no time. */
    dateOnly: boolean;
    bucket: TaskBucket;
    notionPageId: string;
    /** The Notion page, or null when the page id isn't a Notion id. */
    url: string | null;
}

export interface TasksTileData {
    /** Today's Central day, YYYY-MM-DD. */
    today: string;
    /** Tomorrow's Central day, YYYY-MM-DD. */
    tomorrow: string;
    /** Every listed-worthy task, not just the shown ones. */
    counts: { overdue: number; today: number; tomorrow: number; total: number };
    /** The first TASKS_MAX_SHOWN, overdue first, then by due day and time. */
    tasks: DueTask[];
    /** counts.total - tasks.length. */
    more: number;
    /** The newest notion_last_synced over the Notion tasks (ISO), or null if none has synced. */
    lastSync: string | null;
    /** now - lastSync, or null. */
    syncAgeMs: number | null;
    /** Older than TASKS_STALE_AFTER_MS, or never synced. */
    stale: boolean;
}

/** A Notion page id: 32 hex digits, with or without dashes. */
const notionUrl = (pageId: string) => {
    const hex = pageId.trim().replace(/-/g, "");
    return /^[0-9a-f]{32}$/i.test(hex) ? `https://www.notion.so/${hex.toLowerCase()}` : null;
};

// The Notion tasks, and each one's due day: a UTC-midnight due_date is a date-only day.
const NOTION_TASKS = `
    FROM tasks
    WHERE notion_page_id IS NOT NULL AND btrim(notion_page_id) <> ''`;
const DUE_DAY = `
    CASE WHEN (due_date AT TIME ZONE 'UTC')::time = '00:00'
         THEN (due_date AT TIME ZONE 'UTC')::date
         ELSE (due_date AT TIME ZONE '${TIME_ZONE}')::date END`;

export const tasksTile: TileSource<TasksTileData> = {
    id: "tasks",
    title: "Tasks",
    href: "/db/tasks",

    async build({ now, db }) {
        // Days are computed in Postgres, so "tomorrow" ends at Central midnight across DST.
        const { rows: [d] } = await db.query(
            `WITH t AS (SELECT ($1::timestamptz AT TIME ZONE '${TIME_ZONE}')::date AS today)
             SELECT to_char(t.today, 'YYYY-MM-DD') AS today, to_char(t.today + 1, 'YYYY-MM-DD') AS tomorrow,
                    (SELECT max(notion_last_synced) ${NOTION_TASKS}) AS last_sync
             FROM t`, [now]);
        const { rows } = await db.query(
            `WITH due AS (
                SELECT id, title, status, due_date, notion_page_id,
                       (due_date AT TIME ZONE 'UTC')::time = '00:00' AS date_only, ${DUE_DAY} AS due_day
                ${NOTION_TASKS}
                  AND status <> $2
                  AND due_date IS NOT NULL
                  -- A coarse bound first: nothing due on or after the day after tomorrow starts (Central).
                  AND due_date < (($1::date + 2)::timestamp AT TIME ZONE '${TIME_ZONE}')
             ), listed AS (
                SELECT *, CASE WHEN due_day < $1::date THEN 'overdue'
                               WHEN due_day = $1::date THEN 'today' ELSE 'tomorrow' END AS bucket
                FROM due WHERE due_day <= $1::date + 1
             )
             SELECT id, title, status, due_date, notion_page_id, date_only,
                    to_char(due_day, 'YYYY-MM-DD') AS due_day, bucket,
                    count(*) FILTER (WHERE bucket = 'overdue') OVER () AS n_overdue,
                    count(*) FILTER (WHERE bucket = 'today') OVER () AS n_today,
                    count(*) OVER () AS n_total
             FROM listed
             ORDER BY due_day, due_date, title, id
             LIMIT $3`, [d.today, TASKS_DONE_STATUS, TASKS_MAX_SHOWN]);

        const total = rows.length ? Number(rows[0].n_total) : 0;
        const overdue = rows.length ? Number(rows[0].n_overdue) : 0;
        const today = rows.length ? Number(rows[0].n_today) : 0;
        const lastSync = d.last_sync ? new Date(d.last_sync) : null;
        const syncAgeMs = lastSync ? now.getTime() - lastSync.getTime() : null;

        return ok({
            today: d.today,
            tomorrow: d.tomorrow,
            counts: { overdue, today, tomorrow: total - overdue - today, total },
            tasks: rows.map((r): DueTask => ({
                id: r.id,
                title: r.title,
                status: r.status,
                due: new Date(r.due_date).toISOString(),
                dueDay: r.due_day,
                dateOnly: r.date_only === true,
                bucket: r.bucket,
                notionPageId: r.notion_page_id,
                url: notionUrl(r.notion_page_id),
            })),
            more: total - rows.length,
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
                t.stale ? ` · <span class="warn">no sync for over ${TASKS_STALE_AFTER_MS / 60_000} min</span>` : ""}`
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
            const progress = task.status === "In Progress" ? ` · in progress` : "";
            return `<li data-bucket="${task.bucket}">${tag}<span class="task-title">${title}</span> <span class="muted">${
                esc(when(task))}${progress}</span></li>`;
        }).join("");
        const more = t.more > 0 ? `<div class="muted task-more">+${t.more} more</div>` : "";
        return `${head}
            <ul class="task-list">${items}</ul>${more}
            ${meta}`;
    },
};
