/**
 * Quest reminders (#91, part of #57). A quest's owner picks when to be
 * reminded -- minutes before the quest is due (planning/quests.ts,
 * setReminders) -- and this module sends each reminder as a bell notification
 * and an email.
 *
 *   runQuestReminders(db, now, deps)
 *       The reminder job. The clock and the email sender are injected so
 *       tests can move time forward and stub email; jobs/ runs it once a
 *       minute on BullMQ. Each run first brings due times in line with their
 *       sessions' starts, then sends what's due:
 *         - exactly once per offset per due time: a session_task_reminders row
 *           is claimed (task, offset, due time) before anything is sent, so
 *           two workers, or a retried run, can't both send it. A new due time
 *           is a new key, so moving the night re-arms every reminder.
 *         - never for a quest that's done or cancelled, or whose session is
 *           cancelled or over, or that has no owner (an unclaimed potluck slot).
 *         - never once the quest is due.
 *         - when several offsets have passed together (the owner added "a day
 *           before" with three hours to go, or the night moved earlier), only
 *           the latest of them is sent: one reminder, not a burst.
 *
 *   followSessionStarts(db, sessionId?)
 *       A quest's due time follows its session's start. due_anchor records
 *       the start each due time was set against; a quest whose anchor differs
 *       from its session's start shifts by the difference, or takes the start
 *       if it had no due time because the night wasn't set yet. Idempotent,
 *       so it's safe to run from the bus, from the job and from the session
 *       edit route for the same move. A move re-arms only the reminders still
 *       to come: one already sent whose time has passed for the new due time
 *       too is carried over as sent.
 *
 *   subscribeQuestSchedule()
 *       Follows planning.night_moved and planning.stage_changed, so due times
 *       move as soon as a night is confirmed or moved. The job runs the same
 *       step anyway, which covers a missed event and session edits made
 *       outside the planner.
 */
import type pg from "pg";
import pool from "../db/index.js";
import { bus } from "../events/index.js";
import { notify as realNotify } from "../utils/notify.js";
import { sendEmail as realSendEmail, type OutgoingEmail } from "../services/emailService.js";

type Db = Pick<pg.Pool, "query">;

/** Sessions whose quests still remind: being planned or still to come. */
const LIVE_SESSION = `s.status IN ('planning','scheduled')`;

/**
 * Moves open quests' due times to follow their sessions' starts (all sessions,
 * or one). Returns the ids of the quests it moved.
 *
 * A move re-arms only the reminders still to come. An offset already sent for
 * the old due time whose time has passed for the new one too (the night moved
 * by half an hour after "the day before" went out) is carried over as sent,
 * so the owner isn't told twice. `now` is the moment of the move.
 */
export async function followSessionStarts(db: Db, sessionId: string | null = null, now: Date = new Date()): Promise<string[]> {
    const { rows } = await db.query(
        `WITH due AS (
              SELECT t.id, t.due_at AS old_due, s.date AS start,
                     CASE WHEN t.due_anchor IS NULL THEN COALESCE(t.due_at, s.date)
                          ELSE t.due_at + (s.date - t.due_anchor) END AS new_due
                FROM session_tasks t JOIN game_sessions s ON s.id = t.session_id
               WHERE t.status = 'open'
                 AND s.date IS NOT NULL
                 AND t.due_anchor IS DISTINCT FROM s.date
                 AND ($1::uuid IS NULL OR s.id = $1::uuid)
                 FOR UPDATE OF t),
          moved AS (
              UPDATE session_tasks t SET due_at = due.new_due, due_anchor = due.start
                FROM due WHERE t.id = due.id
           RETURNING t.id),
          carried AS (
              INSERT INTO session_task_reminders (task_id, offset_minutes, due_at, sent_at)
              SELECT r.task_id, r.offset_minutes, due.new_due, r.sent_at
                FROM session_task_reminders r JOIN due ON r.task_id = due.id AND r.due_at = due.old_due
               WHERE due.new_due IS NOT NULL
                 AND due.new_due IS DISTINCT FROM due.old_due
                 AND due.new_due - make_interval(mins => r.offset_minutes) <= $2
              ON CONFLICT DO NOTHING)
        SELECT id FROM moved`, [sessionId, now]);
    return rows.map((r) => r.id);
}

export interface ReminderDeps {
    /** Sends one email. Defaults to services/emailService.sendEmail; tests stub it. */
    sendEmail?: (msg: OutgoingEmail) => Promise<unknown>;
    /** Creates the bell notification. Defaults to utils/notify. */
    notify?: typeof realNotify;
}

export interface SentReminder {
    questId: string;
    assigneeId: string;
    offsetMinutes: number;
    dueAt: string;
    emailed: boolean;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const formatWhen = (d: Date, timeZone: string) => d.toLocaleString("en-US", {
    timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
});

/** "in 45 minutes", "in 2 hours", "in 3 days" -- from the actual time left, not the offset. */
function timeLeft(ms: number): string {
    const minutes = Math.max(1, Math.round(ms / 60_000));
    if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
    const days = Math.round(hours / 24);
    return `in ${days} days`;
}

/** The reminder job: one pass at `now`. */
export async function runQuestReminders(db: Db, now: Date, deps: ReminderDeps = {}) {
    const sendEmail = deps.sendEmail ?? realSendEmail;
    const notify = deps.notify ?? realNotify;

    const followed = await followSessionStarts(db, null, now);

    // Claim, in one statement, each quest's latest offset that has come round and hasn't been
    // sent for its current due time. Only the rows this run inserted are sent, so a concurrent
    // run (another worker, a retry) can't send the same reminder twice.
    const { rows: claimed } = await db.query(
        `INSERT INTO session_task_reminders (task_id, offset_minutes, due_at, sent_at)
         SELECT t.id, cur.offset_minutes, t.due_at, $1
           FROM session_tasks t
           JOIN game_sessions s ON s.id = t.session_id
           CROSS JOIN LATERAL (
                SELECT min(o) AS offset_minutes FROM unnest(t.reminder_offsets) o
                 WHERE o > 0 AND t.due_at - make_interval(mins => o) <= $1) cur
          WHERE t.status = 'open' AND ${LIVE_SESSION}
            AND t.assignee_id IS NOT NULL
            AND t.due_at > $1
            AND cur.offset_minutes IS NOT NULL
         ON CONFLICT DO NOTHING
         RETURNING task_id, offset_minutes, due_at`, [now]);
    const sent: SentReminder[] = [];
    if (!claimed.length) return { followed, sent };

    const { rows: quests } = await db.query(
        `SELECT t.id, t.title, t.assignee_id, s.id AS session_id, s.title AS session_title,
                c.id AS campaign_id, c.title AS campaign_title, a.email,
                (SELECT w.time_zone FROM availability_windows w
                  WHERE w.person_id = t.assignee_id ORDER BY w.created_at LIMIT 1) AS time_zone
           FROM session_tasks t
           JOIN game_sessions s ON s.id = t.session_id
           JOIN campaigns c ON c.id = s.campaign_id
           JOIN accounts a ON a.id = t.assignee_id
          WHERE t.id = ANY ($1)`, [claimed.map((r) => r.task_id)]);
    const byId = new Map(quests.map((q) => [q.id, q]));

    for (const claim of claimed.sort((a, b) => +a.due_at - +b.due_at)) {
        const q = byId.get(claim.task_id);
        if (!q) continue;
        const dueAt: Date = claim.due_at;
        const when = formatWhen(dueAt, q.time_zone || "UTC");
        const left = timeLeft(+dueAt - +now);
        const path = `/game-night/sessions/${q.session_id}#quests`;
        const title = `Reminder: ${q.title}`;
        const body = `Due ${left} (${when}) — "${q.session_title}", ${q.campaign_title}.`;

        await notify(q.assignee_id, {
            type: "system", title, body, link: path,
            sourceKey: `quest-reminder:${q.id}`,
            meta: { questId: q.id, sessionId: q.session_id, campaignId: q.campaign_id, offsetMinutes: claim.offset_minutes },
        });

        let emailed = false;
        if (q.email) {
            const url = `${process.env.FRONTEND_URL ?? ""}${path}`;
            try {
                await sendEmail({
                    to: q.email,
                    subject: `Quest reminder: ${q.title} (due ${left})`,
                    text: `${q.title}\n\n${body}\n\n${url}\n`,
                    html: `<p><strong>${escapeHtml(q.title)}</strong></p>` +
                        `<p>${escapeHtml(body)}</p>` +
                        `<p><a href="${escapeHtml(url)}">Open the quest</a></p>`,
                });
                emailed = true;
            } catch (err: any) {
                // Best-effort, like the bell: the reminder stays sent rather than repeating every minute.
                console.error(`[quest-reminders] email for quest ${q.id} failed:`, err.message);
            }
        }
        sent.push({ questId: q.id, assigneeId: q.assignee_id, offsetMinutes: claim.offset_minutes, dueAt: dueAt.toISOString(), emailed });
    }
    return { followed, sent };
}

let subscribed = false;

/** Registers the bus subscribers that move due times with the night. Call once, before the bus starts. */
export function subscribeQuestSchedule() {
    if (subscribed) return;
    subscribed = true;
    const follow = async (sessionId: string) => {
        try { await followSessionStarts(pool, sessionId); } catch (err: any) {
            console.error(`[quest-reminders] following session ${sessionId}'s start failed:`, err.message);
        }
    };
    bus.subscribe("planning.night_moved", (p) => follow(p.sessionId));
    // Confirming a session's first night gives its quests their due times.
    bus.subscribe("planning.stage_changed", (p) => { if (p.status !== "cancelled") return follow(p.sessionId); });
}
