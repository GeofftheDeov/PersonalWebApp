/**
 * Quests (#90, part of #57): session tasks. A quest is a to-do tied to one
 * session and owned by one person ("print the handout", "bring the battle
 * map"). The party sees what they owe in the Quest Log, on the Almanac next to
 * the session, and on the session page.
 *
 * Two layers:
 *
 *   createQuests()  the gated API the HTTP routes wrap. The Game Master (the
 *                   campaign's, the session's stand-in, or an admin) creates
 *                   and reassigns quests for party members; a quest's owner or
 *                   the Game Master marks it done. Each mutation runs in a
 *                   transaction with the quest's row locked, then publishes
 *                   its bus event and bell notification after the commit.
 *
 *   insertQuest / setAssignee / getQuest / announceAssigned
 *                   the ungated building blocks, which take the caller's
 *                   database client. The planner uses them inside its own
 *                   transaction for the quests it creates itself: the host's
 *                   prep quest when a venue is confirmed (#92) and potluck
 *                   slots, which start unassigned and are claimed (#93).
 *                   Callers push announceAssigned() as an after-commit effect.
 *
 * Due times default to the session's start, and are NULL while the night is
 * still being voted on. Reminder offsets are stored here but set and sent by
 * the reminder job (#91), which also moves due times when the night moves.
 *
 * Plain SQL against session_tasks (migrations/2026-10-01-session-planning.sql).
 */
import type pg from "pg";
import pool, { withTransaction } from "../db/index.js";
import { isUuid } from "../db/model.js";
import { bus } from "../events/index.js";
import type { EventMap } from "../events/events.js";
import { notify } from "../utils/notify.js";
import { personDisplayName } from "../utils/personUtils.js";
import { campaignParty } from "./availabilityStore.js";
import { roleIn } from "./roles.js";

type Db = Pick<pg.PoolClient, "query">;

export type QuestKind = "host_prep" | "food" | "custom";
export type QuestStatus = "open" | "done" | "cancelled";

const DAY = 24 * 60 * 60 * 1000;
export const MAX_TITLE = 120;
export const MAX_NOTES = 1000;
export const MAX_ALMANAC_DAYS = 400;
/** Reminder offsets (#91), in minutes before the due time. The table's CHECK allows the same range. */
export const MAX_REMINDERS = 5;
export const MAX_REMINDER_MINUTES = 14 * 24 * 60;
/** A session without an end time still counts as upcoming for this long after it starts. */
const SESSION_GRACE = "4 hours";

/** A 4xx the route can hand straight back to the page. */
export class QuestError extends Error {
    constructor(public status: number, message: string) { super(message); }
}

export interface Actor { id: string }

export interface QuestJson {
    id: string;
    sessionId: string;
    kind: QuestKind;
    title: string;
    notes: string | null;
    /** null: an unclaimed potluck slot (#93). */
    assignee: { id: string; name: string } | null;
    /** ISO. null while the session's night is still being voted on. */
    dueAt: string | null;
    status: QuestStatus;
    /** Minutes before dueAt, chosen by the quest's owner (#91). Largest first. */
    reminderOffsets: number[];
    /** The offsets already sent for the current dueAt (#91). Moving the night re-arms them. */
    remindersSent: number[];
    createdBy: string | null;
    createdAt: string;
    completedAt: string | null;
    session: {
        id: string;
        title: string;
        date: string | null;
        endDate: string | null;
        status: string;
        campaign: { id: string; title: string };
    };
}

// ── reading ─────────────────────────────────────────────────────────────────

const QUEST_SQL = `
    SELECT t.*, s.title AS session_title, s.date AS session_date, s.end_date AS session_end_date,
           s.status AS session_status, s.campaign_id, c.title AS campaign_title,
           a.handle AS a_handle, a.name AS a_name, a.first_name AS a_first_name,
           a.last_name AS a_last_name, a.email AS a_email,
           ARRAY(SELECT r.offset_minutes FROM session_task_reminders r
                  WHERE r.task_id = t.id AND r.due_at = t.due_at ORDER BY r.offset_minutes DESC) AS reminders_sent
      FROM session_tasks t
      JOIN game_sessions s ON s.id = t.session_id
      JOIN campaigns c ON c.id = s.campaign_id
      LEFT JOIN accounts a ON a.id = t.assignee_id`;

/** Open quests first, then soonest due (undated last). */
const QUEST_ORDER = `ORDER BY (t.status <> 'open'), COALESCE(t.due_at, s.date) NULLS LAST, t.created_at, t.id`;

const iso = (d: Date | null) => d?.toISOString() ?? null;

function toQuestJson(r: any): QuestJson {
    return {
        id: r.id,
        sessionId: r.session_id,
        kind: r.kind,
        title: r.title,
        notes: r.notes,
        assignee: r.assignee_id ? {
            id: r.assignee_id,
            name: personDisplayName({ handle: r.a_handle, name: r.a_name, firstName: r.a_first_name, lastName: r.a_last_name, email: r.a_email }),
        } : null,
        dueAt: iso(r.due_at),
        status: r.status,
        reminderOffsets: r.reminder_offsets ?? [],
        remindersSent: r.reminders_sent ?? [],
        createdBy: r.created_by,
        createdAt: r.created_at.toISOString(),
        completedAt: iso(r.completed_at),
        session: {
            id: r.session_id, title: r.session_title, date: iso(r.session_date), endDate: iso(r.session_end_date),
            status: r.session_status, campaign: { id: r.campaign_id, title: r.campaign_title },
        },
    };
}

export async function getQuest(db: Db, questId: string): Promise<QuestJson | null> {
    if (!isUuid(questId)) return null;
    const { rows: [r] } = await db.query(`${QUEST_SQL} WHERE t.id = $1`, [questId]);
    return r ? toQuestJson(r) : null;
}

const SESSION_SQL = `
    SELECT s.id, s.title, s.date, s.end_date, s.status, s.campaign_id, s.gm_override_id,
           c.title AS campaign_title, c.gm_title
      FROM game_sessions s JOIN campaigns c ON c.id = s.campaign_id
     WHERE s.id = $1`;

async function loadSession(db: Db, sessionId: string, lock = false) {
    if (!isUuid(sessionId)) throw new QuestError(404, "Session not found.");
    const { rows: [s] } = await db.query(SESSION_SQL + (lock ? " FOR UPDATE OF s" : ""), [sessionId]);
    if (!s) throw new QuestError(404, "Session not found.");
    return s;
}

// ── validation ──────────────────────────────────────────────────────────────

function cleanTitle(raw: unknown): string {
    const title = typeof raw === "string" ? raw.trim() : "";
    if (!title) throw new QuestError(400, "Give the quest a title.");
    if (title.length > MAX_TITLE) throw new QuestError(400, `Quest titles are limited to ${MAX_TITLE} characters.`);
    return title;
}

function cleanNotes(raw: unknown): string | null {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "string") throw new QuestError(400, "Notes must be text.");
    const notes = raw.trim();
    if (notes.length > MAX_NOTES) throw new QuestError(400, `Notes are limited to ${MAX_NOTES} characters.`);
    return notes || null;
}

/** undefined: not given (use the default). null: explicitly none. */
function cleanDueAt(raw: unknown): Date | null | undefined {
    if (raw === undefined) return undefined;
    if (raw === null || raw === "") return null;
    const d = new Date(raw as string);
    if (typeof raw !== "string" || isNaN(+d)) throw new QuestError(400, "The due time must be an ISO date-time.");
    return d;
}

/** Only a potluck slot (#93) may be left without an owner; the owner must be in the party. */
async function cleanAssignee(db: Db, raw: unknown, kind: QuestKind, campaignId: string): Promise<string | null> {
    if (raw === null || raw === undefined || raw === "") {
        if (kind === "food") return null;
        throw new QuestError(400, "Choose someone in the party to own this quest.");
    }
    if (!isUuid(raw)) throw new QuestError(400, "Choose someone in the party to own this quest.");
    const { rowCount } = await db.query(
        `SELECT 1 FROM campaign_members WHERE campaign_id = $1 AND person_id = $2 LIMIT 1`, [campaignId, raw]);
    if (!rowCount) throw new QuestError(400, "Quests can only go to someone in the party.");
    return raw as string;
}

/**
 * Reminder offsets (#91): whole minutes before the due time, 1 minute to two
 * weeks, at most five. Duplicates collapse; stored largest (earliest) first.
 */
export function cleanReminderOffsets(raw: unknown): number[] {
    if (!Array.isArray(raw)) throw new QuestError(400, "offsets must be a list of minutes before the due time.");
    const offsets = [...new Set(raw)];
    for (const o of offsets) {
        if (typeof o !== "number" || !Number.isInteger(o) || o < 1 || o > MAX_REMINDER_MINUTES) {
            throw new QuestError(400, `Each reminder is a whole number of minutes before the due time, from 1 to ${MAX_REMINDER_MINUTES} (two weeks).`);
        }
    }
    if (offsets.length > MAX_REMINDERS) throw new QuestError(400, `A quest can have at most ${MAX_REMINDERS} reminders.`);
    return (offsets as number[]).sort((a, b) => b - a);
}

// ── building blocks (ungated; the caller has already decided) ───────────────

export interface NewQuest {
    sessionId: string;
    kind: QuestKind;
    title: string;
    notes?: string | null;
    /** null only for an unclaimed potluck slot. */
    assigneeId: string | null;
    /** null while the session has no night yet. */
    dueAt: Date | null;
    /** null when the app creates it (e.g. a host-prep quest). */
    createdBy: string | null;
}

/**
 * Inserts a quest and returns its id. Its due time is anchored to the
 * session's start as it is now, so it follows the night when that moves (#91).
 */
export async function insertQuest(db: Db, q: NewQuest): Promise<string> {
    const { rows: [r] } = await db.query(
        `INSERT INTO session_tasks (session_id, kind, title, notes, assignee_id, due_at, created_by, due_anchor)
         VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT date FROM game_sessions WHERE id = $1)) RETURNING id`,
        [q.sessionId, q.kind, q.title, q.notes ?? null, q.assigneeId, q.dueAt, q.createdBy]);
    return r.id;
}

/**
 * Gives a quest a new owner (or none, for a potluck slot). Returns the previous
 * owner. Reminder timing is the owner's own choice (#91), so a new owner starts
 * with none.
 */
export async function setAssignee(db: Db, questId: string, assigneeId: string | null): Promise<{ previousAssigneeId: string | null }> {
    const { rows: [old] } = await db.query(`SELECT assignee_id FROM session_tasks WHERE id = $1 FOR UPDATE`, [questId]);
    if (!old) throw new QuestError(404, "Quest not found.");
    await db.query(
        `UPDATE session_tasks
            SET assignee_id = $2,
                reminder_offsets = CASE WHEN assignee_id IS DISTINCT FROM $2 THEN '{}' ELSE reminder_offsets END
          WHERE id = $1`, [questId, assigneeId]);
    return { previousAssigneeId: old.assignee_id };
}

/**
 * Run after the commit: publishes quest.assigned and bell-notifies the new
 * owner (unless they gave it to themselves). Never throws.
 */
export async function announceAssigned(q: QuestJson, assignedBy: string | null, previousAssigneeId: string | null) {
    const payload: EventMap["quest.assigned"] = {
        questId: q.id, sessionId: q.sessionId, campaignId: q.session.campaign.id, kind: q.kind,
        assigneeId: q.assignee?.id ?? null, previousAssigneeId, assignedBy,
    };
    await bus.publish("quest.assigned", payload).catch(() => { /* bus down is non-fatal */ });
    if (q.assignee && q.assignee.id !== assignedBy) {
        await notify(q.assignee.id, {
            type: "system",
            title: `New quest: ${q.title}`,
            body: `${q.session.campaign.title} — for "${q.session.title}".`,
            link: `/game-night/sessions/${q.sessionId}#quests`,
            sourceKey: `quest:${q.id}`,
            meta: { questId: q.id, sessionId: q.sessionId, campaignId: q.session.campaign.id },
        });
    }
}

// ── the gated API ───────────────────────────────────────────────────────────

export interface QuestDeps {
    /** What "upcoming" is measured against. */
    now: () => Date;
}

export function createQuests(deps: QuestDeps = { now: () => new Date() }) {
    type Effect = () => Promise<unknown>;

    /** Runs `fn` in a transaction, then its side effects once committed. */
    async function mutate<T>(fn: (db: pg.PoolClient, effects: Effect[]) => Promise<T>): Promise<T> {
        const effects: Effect[] = [];
        const result = await withTransaction((db) => fn(db, effects));
        for (const effect of effects) {
            try { await effect(); } catch (err: any) { console.error("[quests] side effect failed:", err.message); }
        }
        return result;
    }

    /** Loads a quest with its row locked, plus what gating needs. */
    async function lockQuest(db: Db, questId: string) {
        if (!isUuid(questId)) throw new QuestError(404, "Quest not found.");
        const { rows: [t] } = await db.query(
            `SELECT t.id, t.kind, t.status, t.assignee_id, t.session_id,
                    s.campaign_id, s.gm_override_id, c.gm_title
               FROM session_tasks t
               JOIN game_sessions s ON s.id = t.session_id
               JOIN campaigns c ON c.id = s.campaign_id
              WHERE t.id = $1
                FOR UPDATE OF t`, [questId]);
        if (!t) throw new QuestError(404, "Quest not found.");
        return t;
    }

    return {
        /**
         * My quests across every session. scope "upcoming" (the Quest Log): open
         * quests for sessions being planned or still to come. scope "all": open
         * and done quests on any session.
         */
        async mine(actor: Actor, scope: unknown = "upcoming") {
            if (scope !== "upcoming" && scope !== "all") throw new QuestError(400, `scope is "upcoming" or "all".`);
            const [where, params] = scope === "upcoming"
                ? [`t.status = 'open' AND s.status IN ('planning','scheduled')
                    AND (s.date IS NULL OR COALESCE(s.end_date, s.date + interval '${SESSION_GRACE}') >= $2)`, [actor.id, deps.now()]]
                : [`t.status IN ('open','done')`, [actor.id]];
            const { rows } = await pool.query(
                `${QUEST_SQL} WHERE t.assignee_id = $1 AND ${where}
                 ORDER BY COALESCE(t.due_at, s.date) NULLS LAST, t.created_at, t.id`, params);
            return { quests: rows.map(toQuestJson) };
        },

        /** Everything on one session, for the party (and what the viewer may do with it). */
        async ofSession(actor: Actor, sessionId: string) {
            const s = await loadSession(pool, sessionId);
            const role = await roleIn(pool, actor.id, s.campaign_id, s.gm_override_id);
            if (!role.member) throw new QuestError(403, "Only the party can see this session's quests.");
            const [party, { rows }] = await Promise.all([
                campaignParty(s.campaign_id),
                pool.query(`${QUEST_SQL} WHERE t.session_id = $1 AND t.status <> 'cancelled' ${QUEST_ORDER}`, [s.id]),
            ]);
            return {
                session: {
                    id: s.id, title: s.title, date: iso(s.date), endDate: iso(s.end_date), status: s.status,
                    campaign: { id: s.campaign_id, title: s.campaign_title },
                },
                gmTitle: s.gm_title,
                viewer: { id: actor.id, isGameMaster: role.gm },
                party,
                quests: rows.map(toQuestJson),
            };
        },

        /** The Game Master adds a custom quest for someone in the party. */
        async create(actor: Actor, sessionId: string, body: any): Promise<QuestJson> {
            const title = cleanTitle(body?.title);
            const notes = cleanNotes(body?.notes);
            const dueAt = cleanDueAt(body?.dueAt);
            return mutate(async (db, effects) => {
                // Locked, so a cancel landing at the same moment can't miss this quest.
                const s = await loadSession(db, sessionId, true);
                const role = await roleIn(db, actor.id, s.campaign_id, s.gm_override_id);
                if (!role.gm) throw new QuestError(403, `Only the ${s.gm_title} can add quests.`);
                if (s.status === "cancelled" || s.status === "completed") {
                    throw new QuestError(409, `This session is ${s.status}, so it takes no new quests.`);
                }
                const assigneeId = await cleanAssignee(db, body?.assigneeId, "custom", s.campaign_id);
                const id = await insertQuest(db, {
                    sessionId: s.id, kind: "custom", title, notes, assigneeId,
                    dueAt: dueAt === undefined ? s.date : dueAt, createdBy: actor.id,
                });
                const quest = (await getQuest(db, id))!;
                effects.push(() => announceAssigned(quest, actor.id, null));
                return quest;
            });
        },

        /** The Game Master edits an open quest: title, notes, due time, or owner (reassigning). */
        async update(actor: Actor, questId: string, body: any): Promise<QuestJson> {
            if (!body || typeof body !== "object" || !["title", "notes", "dueAt", "assigneeId"].some((k) => k in body)) {
                throw new QuestError(400, "Nothing to change: send title, notes, dueAt or assigneeId.");
            }
            return mutate(async (db, effects) => {
                const t = await lockQuest(db, questId);
                const role = await roleIn(db, actor.id, t.campaign_id, t.gm_override_id);
                if (!role.gm) throw new QuestError(403, `Only the ${t.gm_title} can change quests.`);
                if (t.status !== "open") throw new QuestError(409, `This quest is ${t.status}.`);

                const sets: string[] = [];
                const params: unknown[] = [t.id];
                const set = (col: string, value: unknown) => { params.push(value); sets.push(`${col} = $${params.length}`); };
                if ("title" in body) set("title", cleanTitle(body.title));
                if ("notes" in body) set("notes", cleanNotes(body.notes));
                if ("dueAt" in body) {
                    set("due_at", cleanDueAt(body.dueAt) ?? null);
                    // A due time set now is relative to the session's start as it is now (#91).
                    sets.push(`due_anchor = (SELECT date FROM game_sessions WHERE id = session_id)`);
                }
                let previous: string | null | undefined;
                if ("assigneeId" in body) {
                    const assigneeId = await cleanAssignee(db, body.assigneeId, t.kind, t.campaign_id);
                    if (assigneeId !== t.assignee_id) {
                        previous = (await setAssignee(db, t.id, assigneeId)).previousAssigneeId;
                    }
                }
                if (sets.length) await db.query(`UPDATE session_tasks SET ${sets.join(", ")} WHERE id = $1`, params);
                const quest = (await getQuest(db, t.id))!;
                if (previous !== undefined) effects.push(() => announceAssigned(quest, actor.id, previous!));
                return quest;
            });
        },

        /** The quest's owner, or the Game Master, marks it done. Doing so twice is harmless. */
        async complete(actor: Actor, questId: string): Promise<QuestJson> {
            return mutate(async (db, effects) => {
                const t = await lockQuest(db, questId);
                if (t.assignee_id !== actor.id) {
                    const role = await roleIn(db, actor.id, t.campaign_id, t.gm_override_id);
                    if (!role.gm) throw new QuestError(403, `Only the quest's owner or the ${t.gm_title} can mark it done.`);
                }
                if (t.status === "cancelled") throw new QuestError(409, "This quest was cancelled.");
                if (t.status === "open") {
                    await db.query(`UPDATE session_tasks SET status = 'done', completed_at = now() WHERE id = $1`, [t.id]);
                    effects.push(() => bus.publish("quest.completed", {
                        questId: t.id, sessionId: t.session_id, campaignId: t.campaign_id,
                        assigneeId: t.assignee_id, completedBy: actor.id,
                    }).catch(() => { /* bus down is non-fatal */ }));
                }
                return (await getQuest(db, t.id))!;
            });
        },

        /**
         * The quest's owner chooses when to be reminded (#91): minutes before
         * the due time. Only the owner -- it's their routine, not the Game
         * Master's call. An offset already sent for the current due time stays
         * sent; the reminder job sends the rest.
         */
        async setReminders(actor: Actor, questId: string, body: any): Promise<QuestJson> {
            const offsets = cleanReminderOffsets(body?.offsets);
            return mutate(async (db) => {
                const t = await lockQuest(db, questId);
                if (t.assignee_id !== actor.id) throw new QuestError(403, "Only the quest's owner can choose its reminders.");
                if (t.status !== "open") throw new QuestError(409, `This quest is ${t.status}, so it sends no reminders.`);
                await db.query(`UPDATE session_tasks SET reminder_offsets = $2 WHERE id = $1`, [t.id, offsets]);
                return (await getQuest(db, t.id))!;
            });
        },

        /**
         * The Almanac: my sessions with a date in [start, end) -- every campaign
         * I'm in, plus any I'm the stand-in GM of -- each with my quests on it.
         */
        async almanac(actor: Actor, q: { start?: unknown; end?: unknown }) {
            const start = new Date(q.start as string), end = new Date(q.end as string);
            if (typeof q.start !== "string" || typeof q.end !== "string" || isNaN(+start) || isNaN(+end) || end <= start) {
                throw new QuestError(400, "start and end must be ISO date-times, end after start.");
            }
            if (+end - +start > MAX_ALMANAC_DAYS * DAY) throw new QuestError(400, `The range is limited to ${MAX_ALMANAC_DAYS} days.`);
            const { rows: sessions } = await pool.query(
                `SELECT s.id, s.title, s.date, s.end_date, s.status, s.is_online, s.location,
                        s.campaign_id, c.title AS campaign_title
                   FROM game_sessions s JOIN campaigns c ON c.id = s.campaign_id
                  WHERE s.date >= $2 AND s.date < $3 AND s.status <> 'cancelled'
                    AND (s.gm_override_id = $1 OR EXISTS (
                          SELECT 1 FROM campaign_members m WHERE m.campaign_id = s.campaign_id AND m.person_id = $1))
                  ORDER BY s.date, s.id`, [actor.id, start, end]);
            const { rows: quests } = sessions.length ? await pool.query(
                `${QUEST_SQL} WHERE t.session_id = ANY($1) AND t.assignee_id = $2 AND t.status <> 'cancelled' ${QUEST_ORDER}`,
                [sessions.map((s) => s.id), actor.id]) : { rows: [] };
            const bySession = new Map<string, QuestJson[]>();
            for (const r of quests) {
                const quest = toQuestJson(r);
                bySession.set(quest.sessionId, [...(bySession.get(quest.sessionId) ?? []), quest]);
            }
            return {
                sessions: sessions.map((s) => ({
                    id: s.id, title: s.title, date: iso(s.date), endDate: iso(s.end_date), status: s.status,
                    isOnline: s.is_online, location: s.location,
                    campaign: { id: s.campaign_id, title: s.campaign_title },
                    quests: bySession.get(s.id) ?? [],
                })),
            };
        },
    };
}

export type Quests = ReturnType<typeof createQuests>;
