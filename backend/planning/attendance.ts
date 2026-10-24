/**
 * Session attendance (#37, plan §4.4; the creating event is #32's hybrid).
 *
 * After a session the Game Master confirms who was actually there. The form
 * is pre-filled from the ready check (who said they were ready), so the usual
 * case is one click, and the record is still a person's assertion rather than
 * a guess from intent. With no ready check it's just an empty checklist.
 *
 * Confirming replaces the session's attendee set and stamps
 * `game_sessions.attendance_confirmed_at`, which is what tells "nobody came"
 * apart from "not taken yet". Old sessions get no backfill: their GM can take
 * attendance whenever they like.
 *
 * Who can see it: anyone who can see the campaign. Who can take it: the
 * session's Game Master (isSessionGameMaster: the campaign's GM, an admin, or
 * the one-session stand-in). A player who attended and was later deactivated
 * stays on the list (#31: hiding a person, not rewriting history), marked
 * `active: false`; only the GM's checklist offers the inactive, and only those
 * already recorded.
 */
import { query, withTransaction } from "../db/index.js";
import { isUuid } from "../db/model.js";
import { getAuthorizedCampaignIds, isSessionGameMaster } from "../utils/gameNightPlannerUtils.js";
import { personDisplayName } from "../utils/personUtils.js";

export class AttendanceError extends Error {
    constructor(public status: number, message: string) { super(message); }
}

export interface AttendanceRow {
    playerId: string;
    name: string;
    /** Still active in the campaign (#37). */
    active: boolean;
    /** Recorded as there. */
    attended: boolean;
    /** Their ready-check answer, or null if they gave none. */
    ready: boolean | null;
}

export interface Attendance {
    sessionId: string;
    confirmedAt: string | null;
    confirmedBy: string | null;
    /** Whether the viewer may confirm it (and so sees the whole party below). */
    canConfirm: boolean;
    /** Whether the session has started, so attendance can be taken. */
    open: boolean;
    /** The GM's checklist: the active party plus anyone already recorded. Others see attendees only. */
    people: AttendanceRow[];
}

interface SessionRow {
    id: string;
    campaign_id: string;
    gm_override_id: string | null;
    date: Date | null;
    status: string;
    ready_check: { responses?: Array<{ playerId?: string; ready?: boolean }> } | null;
    attendance_confirmed_at: Date | null;
    attendance_confirmed_by: string | null;
}

async function loadSession(actor: { id: string }, sessionId: string): Promise<SessionRow> {
    if (!isUuid(sessionId)) throw new AttendanceError(404, "Session not found");
    const { rows: [s] } = await query<SessionRow>(
        `SELECT id, campaign_id, gm_override_id, date, status, ready_check,
                attendance_confirmed_at, attendance_confirmed_by
           FROM game_sessions WHERE id = $1`, [sessionId]);
    if (!s) throw new AttendanceError(404, "Session not found");
    const campaignIds = await getAuthorizedCampaignIds(actor);
    if (campaignIds && !campaignIds.includes(String(s.campaign_id))) throw new AttendanceError(403, "Unauthorized");
    return s;
}

/** Started and not cancelled or still being planned. */
const isOpen = (s: SessionRow) =>
    s.status !== "cancelled" && s.status !== "planning" && Boolean(s.date) && new Date(s.date!).getTime() <= Date.now();

export async function getAttendance(actor: { id: string }, sessionId: string): Promise<Attendance> {
    const s = await loadSession(actor, sessionId);
    const canConfirm = await isSessionGameMaster(actor, { campaign: s.campaign_id, gmOverride: s.gm_override_id });

    // Everyone in the party (active, or recorded as there), with whether they
    // attended. One row per person however many member rows they have.
    const { rows } = await query<any>(
        `WITH people AS (
             SELECT person_id AS id FROM campaign_members WHERE campaign_id = $2 AND person_id IS NOT NULL
             UNION
             SELECT player_id FROM player_sessions WHERE session_id = $1
         ), seats AS (
             SELECT person_id, bool_or(is_active) AS active, min(joined_at) AS joined_at
               FROM campaign_members WHERE campaign_id = $2 GROUP BY person_id
         )
         SELECT a.id, a.handle, a.name, a.first_name AS "firstName", a.last_name AS "lastName",
                coalesce(seats.active, false) AS active,
                EXISTS (SELECT 1 FROM player_sessions p WHERE p.session_id = $1 AND p.player_id = a.id) AS attended
           FROM people JOIN accounts a ON a.id = people.id
           LEFT JOIN seats ON seats.person_id = a.id
          ORDER BY seats.joined_at NULLS LAST, lower(coalesce(a.handle, a.name, '')), a.id`,
        [sessionId, s.campaign_id]);

    const readyBy = new Map<string, boolean>();
    for (const r of s.ready_check?.responses ?? []) {
        if (r?.playerId && typeof r.ready === "boolean") readyBy.set(String(r.playerId), r.ready);
    }

    const people: AttendanceRow[] = rows
        .filter((r) => r.attended || (canConfirm && r.active))
        .map((r) => ({
            playerId: r.id,
            name: personDisplayName(r),
            active: r.active,
            attended: r.attended,
            ready: readyBy.get(r.id) ?? null,
        }));

    return {
        sessionId: s.id,
        confirmedAt: s.attendance_confirmed_at ? new Date(s.attendance_confirmed_at).toISOString() : null,
        confirmedBy: s.attendance_confirmed_by,
        canConfirm,
        open: isOpen(s),
        people,
    };
}

/**
 * The GM's confirmation: exactly these people were there. Everyone named must
 * be in the party now, or already recorded (an inactive player who came).
 */
export async function confirmAttendance(actor: { id: string }, sessionId: string, playerIds: unknown): Promise<Attendance> {
    if (!Array.isArray(playerIds) || playerIds.some((id) => !isUuid(id))) {
        throw new AttendanceError(400, "playerIds must be a list of player ids");
    }
    const ids = [...new Set(playerIds as string[])];
    const s = await loadSession(actor, sessionId);
    if (!(await isSessionGameMaster(actor, { campaign: s.campaign_id, gmOverride: s.gm_override_id }))) {
        throw new AttendanceError(403, "Only the session's Game Master can take attendance");
    }
    if (!isOpen(s)) throw new AttendanceError(409, "Attendance opens once the session has started");

    await withTransaction(async (db) => {
        // Lock the session so two confirmations can't interleave.
        await db.query(`SELECT 1 FROM game_sessions WHERE id = $1 FOR UPDATE`, [sessionId]);
        const { rows: eligible } = await db.query<{ id: string; name: string }>(
            `SELECT a.id, coalesce(a.handle, a.name, nullif(concat_ws(' ', a.first_name, a.last_name), ''), 'Unknown Player') AS name
               FROM accounts a
              WHERE a.id = ANY($1::uuid[])
                AND (EXISTS (SELECT 1 FROM campaign_members m WHERE m.campaign_id = $2 AND m.person_id = a.id AND m.is_active)
                  OR EXISTS (SELECT 1 FROM player_sessions p WHERE p.session_id = $3 AND p.player_id = a.id))`,
            [ids, s.campaign_id, sessionId]);
        if (eligible.length !== ids.length) {
            throw new AttendanceError(400, "Attendance can only list players in this campaign");
        }
        await db.query(
            `DELETE FROM player_sessions WHERE session_id = $1 AND player_id <> ALL($2::uuid[])`, [sessionId, ids]);
        for (const p of eligible) {
            await db.query(
                `INSERT INTO player_sessions (name, session_id, player_id, campaign_id)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (session_id, player_id) DO NOTHING`,
                [p.name, sessionId, p.id, s.campaign_id]);
        }
        await db.query(
            `UPDATE game_sessions SET attendance_confirmed_at = now(), attendance_confirmed_by = $2 WHERE id = $1`,
            [sessionId, actor.id]);
    });
    return getAttendance(actor, sessionId);
}
