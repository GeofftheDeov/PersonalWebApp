/**
 * Session planner (#57): the planning state machine, and the only writer of a
 * session's planning stage. The HTTP routes are thin wrappers around it.
 *
 *   kickoff -> night -(confirmed)-> [online]    scheduled
 *                                 \ [in person] venue -> food -> scheduled
 *   any planning stage -(GM cancel)-> cancelled
 *   night: open round -(everyone voted | GM moves forward)->
 *            a winner meeting quorum ? confirmed
 *          : a tie                   ? the GM picks
 *          : nothing met quorum      ? the GM re-shortlists (a new round)
 *
 * In-person planning stops at the venue step, which is the next slice; until
 * it lands, kickoff accepts online sessions only.
 *
 * Every mutation locks the session row for its transaction, so concurrent
 * votes, advances and cancels apply one at a time. Side effects -- Discord
 * and Google events, bus events -- run after the commit, never inside it: a
 * slow or failing integration can't roll back a decision the party has
 * already made. The party's bell notifications and Table Talk posts react to
 * those bus events (planning/announcements.ts, #88); the planner doesn't know
 * they exist. The one notification it sends itself is the Game Master's
 * warning that an integration failed, which comes from the publish result
 * rather than from any event.
 */
import type pg from "pg";
import pool, { withTransaction } from "../db/index.js";
import { isUuid } from "../db/model.js";
import { bus } from "../events/index.js";
import type { EventMap } from "../events/events.js";
import { notify } from "../utils/notify.js";
import { resolveQuorum } from "./availability.js";
import { campaignParty } from "./availabilityStore.js";
import { realExternalEvents, type ExternalEvents } from "./externalEvents.js";
import {
    breakTie, castBallot, closePoll, everyoneVoted, latestPoll, openPoll, openPollOf, pollJson,
    type CloseReason, type Poll,
} from "./poll.js";

type Db = Pick<pg.PoolClient, "query">;
type Effect = () => Promise<unknown>;

export const MIN_SHORTLIST = 2;
export const MAX_SHORTLIST = 4;
const HOUR = 60 * 60 * 1000;

/** A 4xx the route can hand straight back to the page. */
export class PlanningError extends Error {
    constructor(public status: number, message: string) { super(message); }
}

export interface PlannerDeps {
    events: ExternalEvents;
    now: () => Date;
}

export interface Actor { id: string }

// ── reading ─────────────────────────────────────────────────────────────────

const SESSION_SQL = `
    SELECT s.*, c.title AS campaign_title, c.quorum AS campaign_quorum, c.gm_title, c.table_link,
           c.discord_guild_id, c.discord_channel_id
      FROM game_sessions s JOIN campaigns c ON c.id = s.campaign_id
     WHERE s.id = $1`;

async function loadSession(db: Db, sessionId: string, lock: boolean) {
    if (!isUuid(sessionId)) throw new PlanningError(404, "Session not found.");
    const { rows: [s] } = await db.query(SESSION_SQL + (lock ? " FOR UPDATE OF s" : ""), [sessionId]);
    if (!s) throw new PlanningError(404, "Session not found.");
    return s;
}

/** What this person may do in this campaign (and, for a one-session torch pass, this session). */
async function roleIn(db: Db, actorId: string, campaignId: string, gmOverrideId: string | null = null) {
    // Sequential: `db` may be a transaction's single client.
    const { rows: [acct] } = await db.query(`SELECT app_role FROM accounts WHERE id = $1`, [actorId]);
    const { rows: memberships } = await db.query(
        `SELECT status FROM campaign_members WHERE campaign_id = $1 AND person_id = $2`, [campaignId, actorId]);
    const admin = acct?.app_role === "admin";
    const gm = admin || gmOverrideId === actorId || memberships.some((m) => m.status === "Game Master");
    return { admin, gm, member: gm || memberships.length > 0 };
}

/** A session's Game Masters, the stand-in first: whose vault its external events use, and who hears about problems. */
export async function gameMasterIds(db: Db, campaignId: string, gmOverrideId: string | null): Promise<string[]> {
    const { rows } = await db.query(
        `SELECT person_id FROM campaign_members
          WHERE campaign_id = $1 AND status = 'Game Master' AND person_id IS NOT NULL
          ORDER BY joined_at NULLS LAST, created_at`, [campaignId]);
    return [...new Set([gmOverrideId, ...rows.map((r) => r.person_id)].filter((id): id is string => Boolean(id)))];
}

// ── validation ──────────────────────────────────────────────────────────────

function cleanTitle(raw: unknown): string {
    const title = typeof raw === "string" ? raw.trim() : "";
    if (!title) throw new PlanningError(400, "Give the session a title.");
    if (title.length > 120) throw new PlanningError(400, "Titles are limited to 120 characters.");
    return title;
}

function cleanNightOptions(raw: unknown, now: Date) {
    if (!Array.isArray(raw) || raw.length < MIN_SHORTLIST || raw.length > MAX_SHORTLIST) {
        throw new PlanningError(400, `Shortlist ${MIN_SHORTLIST} to ${MAX_SHORTLIST} times.`);
    }
    const seen = new Set<string>();
    return raw.map((o: any, i) => {
        const start = new Date(o?.start), end = new Date(o?.end);
        if (typeof o?.start !== "string" || typeof o?.end !== "string" || isNaN(+start) || isNaN(+end)) {
            throw new PlanningError(400, `Time ${i + 1}: start and end must be ISO date-times.`);
        }
        if (end <= start) throw new PlanningError(400, `Time ${i + 1}: it must end after it starts.`);
        if (+end - +start > 24 * HOUR) throw new PlanningError(400, `Time ${i + 1}: a session can't run past 24 hours.`);
        if (start <= now) throw new PlanningError(400, `Time ${i + 1}: that's already in the past.`);
        const key = `${start.toISOString()}|${end.toISOString()}`;
        if (seen.has(key)) throw new PlanningError(400, "The same time is on the shortlist twice.");
        seen.add(key);
        return { start, end };
    }).sort((a, b) => +a.start - +b.start);
}

// ── the planner ─────────────────────────────────────────────────────────────

export function createPlanner(deps: PlannerDeps = { events: realExternalEvents, now: () => new Date() }) {
    const publish = <K extends keyof EventMap>(name: K, payload: EventMap[K]): Effect =>
        // Non-fatal, but not silent: the party's announcements ride on these events.
        () => bus.publish(name, payload).catch((err: any) => {
            console.error(`[planning] publishing ${name} failed; the party won't be told:`, JSON.stringify(payload), err?.message ?? err);
        });

    /** Runs `fn` in a transaction, then its side effects in order once committed. */
    async function mutate<T>(fn: (db: pg.PoolClient, effects: Effect[]) => Promise<T>): Promise<T> {
        const effects: Effect[] = [];
        const result = await withTransaction((db) => fn(db, effects));
        for (const effect of effects) {
            try { await effect(); } catch (err: any) { console.error("[planning] side effect failed:", err.message); }
        }
        return result;
    }

    const noticeBoard = (campaignId: string) => `/game-night/campaigns/${campaignId}#notice-board`;

    async function notifyGameMasters(s: any, title: string, body: string) {
        const ids = await gameMasterIds(pool, s.campaign_id, s.gm_override_id);
        await Promise.all(ids.map((id) => notify(id, {
            type: "system", title, body, link: noticeBoard(s.campaign_id),
            sourceKey: `planning-gm:${s.id}`, meta: { sessionId: s.id, campaignId: s.campaign_id },
        })));
    }

    async function requireGm(db: Db, actor: Actor, s: any) {
        const role = await roleIn(db, actor.id, s.campaign_id, s.gm_override_id);
        if (!role.gm) throw new PlanningError(403, `Only the ${s.gm_title} can do that.`);
    }

    function requireStage(s: any, stage: "night" | "venue" | "food") {
        if (s.status !== "planning") throw new PlanningError(409, `This session is ${s.status}, not being planned.`);
        if (s.planning_stage !== stage) throw new PlanningError(409, `This session is on the ${s.planning_stage} step.`);
    }

    /** The night is decided: fix the date and move on (online sessions are then scheduled). */
    async function confirmNight(db: Db, s: any, poll: Poll, effects: Effect[]) {
        const option = poll.options.find((o) => o.id === poll.winningOptionId)!;
        const start = option.start!, end = option.end!;
        const nextStage = s.is_online ? null : "venue";
        await db.query(
            `UPDATE game_sessions SET date = $2, end_date = $3, status = $4, planning_stage = $5 WHERE id = $1`,
            [s.id, start, end, nextStage ? "planning" : "scheduled", nextStage]);
        effects.push(publish("planning.stage_changed", {
            sessionId: s.id, campaignId: s.campaign_id, status: nextStage ? "planning" : "scheduled", stage: nextStage,
        }));
        if (nextStage) return;

        const gmIds = await gameMasterIds(db, s.campaign_id, s.gm_override_id);
        effects.push(async () => {
            const published = await deps.events.publishSession({
                gmIds,
                name: `${s.campaign_title}: ${s.title}`,
                description: s.agenda || undefined,
                location: s.table_link || "Online",
                start, end,
                discord: s.discord_guild_id
                    ? { guildId: s.discord_guild_id, channelId: s.discord_channel_id || undefined }
                    : undefined,
            });
            await pool.query(
                `UPDATE game_sessions SET discord_event_id = COALESCE($2, discord_event_id),
                        google_event_id = COALESCE($3, google_event_id), google_calendar_link = $4
                  WHERE id = $1`,
                [s.id, published.discordEventId, published.googleEventId, published.googleCalendarLink]);
            if (published.warnings.length) {
                await notifyGameMasters(s, `"${s.title}" is set, with a problem`, published.warnings.join(" "));
            }
        });
    }

    /**
     * Close the open poll and act on what it says. A tie or a failed round
     * leaves the session on the night step; the poll_closed event tells the
     * Game Master (planning/announcements.ts).
     */
    async function settle(db: Db, s: any, poll: Poll, reason: CloseReason, effects: Effect[]) {
        const closed = await closePoll(db, poll, reason);
        effects.push(publish("planning.poll_closed", {
            sessionId: s.id, campaignId: s.campaign_id, pollId: closed.id, kind: closed.kind, result: closed.result, reason,
        }));
        if (closed.result === "winner") await confirmNight(db, s, closed, effects);
    }

    async function state(actor: Actor, sessionId: string) {
        const s = await loadSession(pool, sessionId, false);
        const role = await roleIn(pool, actor.id, s.campaign_id, s.gm_override_id);
        if (!role.member) throw new PlanningError(403, "Only the party can see this session's planning.");
        const [party, night] = await Promise.all([campaignParty(s.campaign_id), latestPoll(pool, s.id, "night")]);
        return {
            session: {
                id: s.id, campaignId: s.campaign_id, title: s.title, status: s.status, stage: s.planning_stage,
                isOnline: s.is_online, foodMode: s.food_mode, agenda: s.agenda,
                date: s.date?.toISOString() ?? null, endDate: s.end_date?.toISOString() ?? null, location: s.location,
                googleCalendarLink: s.google_calendar_link, discordEventId: s.discord_event_id, googleEventId: s.google_event_id,
            },
            campaign: { id: s.campaign_id, title: s.campaign_title, gmTitle: s.gm_title, quorum: s.campaign_quorum, tableLink: s.table_link },
            party,
            quorum: resolveQuorum(s.campaign_quorum, party.length),
            viewer: { id: actor.id, isGameMaster: role.gm },
            night: night ? pollJson(night) : null,
        };
    }

    return {
        state,

        /** The Notice Board: whether this person can start planning, and the sessions being planned. */
        async board(actor: Actor, campaignId: string) {
            if (!isUuid(campaignId)) throw new PlanningError(404, "Campaign not found.");
            const { rows: [c] } = await pool.query(`SELECT id, gm_title FROM campaigns WHERE id = $1`, [campaignId]);
            if (!c) throw new PlanningError(404, "Campaign not found.");
            const role = await roleIn(pool, actor.id, campaignId);
            const { rows } = await pool.query(
                `SELECT id, gm_override_id FROM game_sessions
                  WHERE campaign_id = $1 AND status = 'planning' ORDER BY created_at`, [campaignId]);
            const visible = rows.filter((r) => role.member || r.gm_override_id === actor.id);
            if (!role.member && !visible.length) throw new PlanningError(403, "Only the party can see the Notice Board.");
            return {
                canPlan: role.gm, gmTitle: c.gm_title,
                planning: await Promise.all(visible.map((r) => state(actor, r.id))),
            };
        },

        async kickoff(actor: Actor, campaignId: string, body: any) {
            if (!isUuid(campaignId)) throw new PlanningError(404, "Campaign not found.");
            const title = cleanTitle(body?.title);
            if (typeof body?.isOnline !== "boolean") throw new PlanningError(400, "Choose online or in person.");
            if (!body.isOnline) {
                throw new PlanningError(400, "In-person planning (venue and food) isn't available yet — plan it online, or add the session with a fixed date.");
            }
            const agenda = typeof body.agenda === "string" ? body.agenda.trim().slice(0, 2000) : null;

            const id = await mutate(async (db, effects) => {
                const { rows: [c] } = await db.query(`SELECT id, title, gm_title FROM campaigns WHERE id = $1`, [campaignId]);
                if (!c) throw new PlanningError(404, "Campaign not found.");
                const role = await roleIn(db, actor.id, campaignId);
                if (!role.gm) throw new PlanningError(403, `Only the ${c.gm_title} can start planning.`);
                const { rows: [s] } = await db.query(
                    `INSERT INTO game_sessions (title, campaign_id, date, status, planning_stage, is_online, agenda)
                     VALUES ($1, $2, NULL, 'planning', 'night', $3, $4) RETURNING id`,
                    [title, campaignId, body.isOnline, agenda || null]);
                effects.push(publish("planning.stage_changed", {
                    sessionId: s.id, campaignId, status: "planning", stage: "night", actorId: actor.id,
                }));
                return s.id as string;
            });
            return state(actor, id);
        },

        /** Put 2-4 times to the party. With `replace`, an open round is abandoned for this one. */
        async shortlist(actor: Actor, sessionId: string, body: any, opts: { replace: boolean }) {
            const options = cleanNightOptions(body?.options, deps.now());
            await mutate(async (db, effects) => {
                const s = await loadSession(db, sessionId, true);
                await requireGm(db, actor, s);
                requireStage(s, "night");
                const open = await openPollOf(db, s.id);
                if (open && !opts.replace) throw new PlanningError(409, "A vote is already open. Re-shortlist to replace it.");
                if (open) {
                    await closePoll(db, open, "gm_reshortlisted");
                    effects.push(publish("planning.poll_closed", {
                        sessionId: s.id, campaignId: s.campaign_id, pollId: open.id, kind: "night", result: null, reason: "gm_reshortlisted",
                    }));
                }
                const party = await campaignParty(s.campaign_id);
                const poll = await openPoll(db, {
                    sessionId: s.id, kind: "night", eligibleIds: party.map((p) => p.id),
                    quorum: resolveQuorum(s.campaign_quorum, party.length),
                    options: options.map((o) => ({ ...o, suggestedBy: actor.id })),
                });
                effects.push(publish("planning.poll_opened", {
                    sessionId: s.id, campaignId: s.campaign_id, pollId: poll.id, kind: "night", round: poll.round, actorId: actor.id,
                }));
            });
            return state(actor, sessionId);
        },

        async vote(actor: Actor, sessionId: string, body: any) {
            await mutate(async (db, effects) => {
                const s = await loadSession(db, sessionId, true);
                const role = await roleIn(db, actor.id, s.campaign_id, s.gm_override_id);
                if (!role.member) throw new PlanningError(403, "Only the party can vote.");
                if (s.status !== "planning") throw new PlanningError(409, `This session is ${s.status}, not being planned.`);
                const open = await openPollOf(db, s.id);
                if (!open) throw new PlanningError(409, "There's no vote open.");
                const poll = await castBallot(db, open, actor.id, body?.optionIds);
                effects.push(publish("planning.vote_cast", {
                    sessionId: s.id, campaignId: s.campaign_id, pollId: poll.id, personId: actor.id,
                }));
                if (everyoneVoted(poll)) await settle(db, s, poll, "all_voted", effects);
            });
            return state(actor, sessionId);
        },

        /** The Game Master closes the vote now, without waiting for the rest. */
        async advance(actor: Actor, sessionId: string) {
            await mutate(async (db, effects) => {
                const s = await loadSession(db, sessionId, true);
                await requireGm(db, actor, s);
                requireStage(s, "night");
                const open = await openPollOf(db, s.id);
                if (!open) throw new PlanningError(409, "There's no vote open.");
                await settle(db, s, open, "gm_advanced", effects);
            });
            return state(actor, sessionId);
        },

        async tiebreak(actor: Actor, sessionId: string, body: any) {
            await mutate(async (db, effects) => {
                const s = await loadSession(db, sessionId, true);
                await requireGm(db, actor, s);
                requireStage(s, "night");
                const last = await latestPoll(db, s.id, "night");
                if (!last) throw new PlanningError(409, "There's no tie to break.");
                const decided = await breakTie(db, last, body?.optionId);
                effects.push(publish("planning.poll_closed", {
                    sessionId: s.id, campaignId: s.campaign_id, pollId: decided.id, kind: "night", result: "winner",
                    reason: decided.closedReason!,
                }));
                await confirmNight(db, s, decided, effects);
            });
            return state(actor, sessionId);
        },

        async cancel(actor: Actor, sessionId: string) {
            await mutate(async (db, effects) => {
                const s = await loadSession(db, sessionId, true);
                await requireGm(db, actor, s);
                if (s.status !== "planning") throw new PlanningError(409, `Only a session being planned can be cancelled here; this one is ${s.status}.`);
                const open = await openPollOf(db, s.id);
                if (open) {
                    await closePoll(db, open, "cancelled");
                    effects.push(publish("planning.poll_closed", {
                        sessionId: s.id, campaignId: s.campaign_id, pollId: open.id, kind: open.kind, result: null, reason: "cancelled",
                    }));
                }
                await db.query(`UPDATE game_sessions SET status = 'cancelled', planning_stage = NULL WHERE id = $1`, [s.id]);
                // Quests for a session that isn't happening must not keep reminding anyone.
                await db.query(
                    `UPDATE session_tasks SET status = 'cancelled' WHERE session_id = $1 AND status = 'open'`, [s.id]);
                effects.push(publish("planning.stage_changed", {
                    sessionId: s.id, campaignId: s.campaign_id, status: "cancelled", stage: null, actorId: actor.id,
                }));
            });
            return state(actor, sessionId);
        },
    };
}

export type Planner = ReturnType<typeof createPlanner>;
