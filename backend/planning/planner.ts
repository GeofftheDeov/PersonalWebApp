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
 *   venue: opens as the night is confirmed, pre-filled with the campaign's
 *          recent venues; the GM adds any venue, the party suggests more;
 *          single choice -(everyone voted | GM moves forward)->
 *            most votes ? confirmed: the session's venue, location and host,
 *                         the host's prep quest, a Google event at the venue
 *                         (no Discord event in person); then food if a food
 *                         mode was chosen at kickoff, else scheduled
 *          : a tie    ? the GM picks
 *   food (#93): potluck -- the Game Master seeds slots, anyone in the party
 *          claims one, adds their own, or un-claims one they hold -- or food
 *          provided, where the food owner got one provisioning quest as the
 *          venue was confirmed. Every slot and the provisioning are `food`
 *          quests, so they show in the owner's Quest Log and on the Almanac.
 *          -(the GM confirms | the session starts: closeDueFoodSteps)->
 *          scheduled. Unclaimed slots never hold it up; they stay open.
 *   scheduled -(GM changes the night)-> night (a new round; the old night
 *            stands) -(confirmed)-> scheduled, its date and its Discord and
 *            Google events moved to the new night (#87)
 *
 * Changing the night and the venue (#92). A scheduled in-person session keeps
 * its confirmed venue, host and host's quest when its night is changed: only
 * the night is re-planned, and the venue was chosen for the session, not the
 * night. While the venue (or food) step is still running, the night can't be
 * changed (409): an open venue vote was put to the party for the night they
 * just confirmed, so the Game Master cancels and plans again instead.
 *
 * The food step and the ready check (#93). The ready check (T-30 minutes)
 * fires for scheduled sessions, and the food step closes by itself only at
 * the session's start -- so a session still in the food step at T-30 would
 * miss it. Rather than close the food step early, the ready check also
 * covers sessions in the food step (utils/readyCheck.ts): by then the night
 * and the venue are settled, so the session is happening; only who brings
 * what is still open.
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
import { personDisplayName } from "../utils/personUtils.js";
import { resolveQuorum } from "./availability.js";
import { campaignParty } from "./availabilityStore.js";
import { realExternalEvents, type ExternalEvents } from "./externalEvents.js";
import {
    addOption, breakTie, castBallot, closePoll, everyoneVoted, latestPoll, openPoll, openPollOf, pollJson, pollsOf,
    type CloseReason, type NewOption, type Poll,
} from "./poll.js";
import { announceAssigned, getQuest, insertQuest, MAX_TITLE, sessionQuests, setAssignee, type QuestJson } from "./quests.js";
import { roleIn } from "./roles.js";

type Db = Pick<pg.PoolClient, "query">;
type Effect = () => Promise<unknown>;

export const MIN_SHORTLIST = 2;
export const MAX_SHORTLIST = 4;
/** How many of the campaign's most recently used venues the venue vote starts with (#92). */
export const RECENT_VENUES = 4;
/** A venue re-shortlist names 1 to this many venues. */
export const MAX_VENUE_SHORTLIST = 6;
/** Suggestions stop once a venue vote has this many options. */
export const MAX_VENUE_OPTIONS = 10;
export const FOOD_MODES = ["potluck", "provided"] as const;
/** A potluck holds at most this many slots (#93); the Game Master seeds at most this many at once. */
export const MAX_FOOD_SLOTS = 20;
export const MAX_FOOD_SEED = 10;
/** The food owner's quest under food provided (#93). */
export const PROVISION_TITLE = "Provide the food";
const VENUE_KINDS = ["home", "store", "other"] as const;
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
           c.discord_guild_id, c.discord_channel_id, v.name AS venue_name, v.address AS venue_address
      FROM game_sessions s JOIN campaigns c ON c.id = s.campaign_id
      LEFT JOIN venues v ON v.id = s.venue_id
     WHERE s.id = $1`;

async function loadSession(db: Db, sessionId: string, lock: boolean) {
    if (!isUuid(sessionId)) throw new PlanningError(404, "Session not found.");
    const { rows: [s] } = await db.query(SESSION_SQL + (lock ? " FOR UPDATE OF s" : ""), [sessionId]);
    if (!s) throw new PlanningError(404, "Session not found.");
    return s;
}

/** A campaign's saved venues, most recently used first, then newest. */
async function campaignVenues(db: Db, campaignId: string) {
    const { rows } = await db.query(
        `SELECT * FROM venues WHERE campaign_id = $1 ORDER BY last_used_at DESC NULLS LAST, created_at DESC, id`, [campaignId]);
    return rows;
}

/**
 * A venue as the party sees it. The address -- a home address, often -- is
 * shown only while the venue is shortlisted or once it's confirmed (#57,
 * story 39); callers only build this for the party.
 */
function venueJson(v: any, showAddress: boolean) {
    return {
        id: v.id, name: v.name, kind: v.kind, hostId: v.host_id,
        address: showAddress ? v.address : null,
        lastUsedAt: v.last_used_at?.toISOString() ?? null,
    };
}

/** Where to show up, for a calendar event: the venue's name, and its address when it has one. */
const venueLocation = (name: string, address: string | null) => address ? `${name}, ${address}` : name;

/** A session's Game Masters, the stand-in first: whose vault its external events use, and who hears about problems. */
export async function gameMasterIds(db: Db, campaignId: string, gmOverrideId: string | null): Promise<string[]> {
    const { rows } = await db.query(
        `SELECT person_id FROM campaign_members
          WHERE campaign_id = $1 AND status = 'Game Master' AND person_id IS NOT NULL
          ORDER BY joined_at NULLS LAST, created_at`, [campaignId]);
    return [...new Set([gmOverrideId, ...rows.map((r) => r.person_id)].filter((id): id is string => Boolean(id)))];
}

/** A person's display name: from the party when they're in it, else their account. */
async function personName(id: string, party: { id: string; name: string }[]): Promise<string> {
    const seated = party.find((p) => p.id === id);
    if (seated) return seated.name;
    const { rows: [a] } = await pool.query(`SELECT handle, name, first_name, last_name, email FROM accounts WHERE id = $1`, [id]);
    return a ? personDisplayName({ handle: a.handle, name: a.name, firstName: a.first_name, lastName: a.last_name, email: a.email }) : "someone";
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

const isPartyMember = async (db: Db, campaignId: string, personId: unknown) => isUuid(personId) && Boolean((await db.query(
    `SELECT 1 FROM campaign_members WHERE campaign_id = $1 AND person_id = $2 LIMIT 1`, [campaignId, personId])).rowCount);

/** A venue re-shortlist: 1 to MAX_VENUE_SHORTLIST of the campaign's saved venues. */
async function cleanVenueIds(db: Db, campaignId: string, raw: unknown): Promise<string[]> {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_VENUE_SHORTLIST) {
        throw new PlanningError(400, `Shortlist 1 to ${MAX_VENUE_SHORTLIST} venues.`);
    }
    const ids = [...new Set(raw)];
    if (ids.length !== raw.length) throw new PlanningError(400, "The same venue is on the shortlist twice.");
    if (!ids.every(isUuid)) throw new PlanningError(400, "venueIds must be the campaign's venue ids.");
    const { rows } = await db.query(`SELECT id FROM venues WHERE campaign_id = $1 AND id = ANY($2)`, [campaignId, ids]);
    if (rows.length !== ids.length) throw new PlanningError(400, "Every venue must be one of this campaign's.");
    return ids as string[];
}

/**
 * The venue someone puts on the vote: one of the campaign's saved venues
 * ({ venueId }), or a new one ({ name, address?, kind?, hostId? }) that is
 * saved to the campaign's list. A home has a host, who must be in the party:
 * a player can offer only their own home; the Game Master can name anyone.
 */
async function venueToSuggest(db: Db, actorId: string, isGm: boolean, campaignId: string, body: any): Promise<string> {
    if (body?.venueId !== undefined) {
        const { rows: [v] } = isUuid(body.venueId)
            ? await db.query(`SELECT id FROM venues WHERE id = $1 AND campaign_id = $2`, [body.venueId, campaignId])
            : { rows: [] };
        if (!v) throw new PlanningError(400, "That venue isn't one of this campaign's.");
        return v.id;
    }
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) throw new PlanningError(400, "Give the venue a name.");
    if (name.length > 120) throw new PlanningError(400, "Venue names are limited to 120 characters.");
    const address = typeof body?.address === "string" ? body.address.trim() : body?.address ?? "";
    if (typeof address !== "string") throw new PlanningError(400, "The address must be text.");
    if (address.length > 300) throw new PlanningError(400, "Addresses are limited to 300 characters.");
    const kind = body?.kind ?? "other";
    if (!VENUE_KINDS.includes(kind)) throw new PlanningError(400, `A venue is a ${VENUE_KINDS.join(", ")}.`);
    let hostId: string | null = null;
    if (kind === "home") {
        hostId = body?.hostId ?? actorId;
        if (hostId !== actorId && !isGm) throw new PlanningError(400, "You can only offer your own home.");
        if (!(await isPartyMember(db, campaignId, hostId))) throw new PlanningError(400, "A home's host must be in the party.");
    }
    const { rows: [v] } = await db.query(
        `INSERT INTO venues (campaign_id, name, address, kind, host_id, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [campaignId, name, address || null, kind, hostId, actorId]);
    return v.id;
}

function cleanSlotTitle(raw: unknown): string {
    const title = typeof raw === "string" ? raw.trim() : "";
    if (!title) throw new PlanningError(400, "Name the dish or the job (say, Snacks).");
    if (title.length > MAX_TITLE) throw new PlanningError(400, `Food slots are limited to ${MAX_TITLE} characters.`);
    return title;
}

/** The Game Master's seed list: 1 to MAX_FOOD_SEED distinct titles. */
function cleanSeedTitles(raw: unknown): string[] {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_FOOD_SEED) {
        throw new PlanningError(400, `Seed 1 to ${MAX_FOOD_SEED} slots.`);
    }
    const titles = raw.map(cleanSlotTitle);
    if (new Set(titles.map((t) => t.toLowerCase())).size !== titles.length) {
        throw new PlanningError(400, "The same slot is on the list twice.");
    }
    return titles;
}

/** A food quest as the Notice Board shows it: a potluck slot (null assignee: unclaimed), or the provisioning. */
const foodQuestJson = (q: QuestJson) => ({
    id: q.id, title: q.title, notes: q.notes, assignee: q.assignee, status: q.status, dueAt: q.dueAt, createdBy: q.createdBy,
});

/**
 * The food step ends (#93): the session is scheduled. The Game Master's
 * confirm and the automatic close at the session's start both go through
 * this; the stage guard makes each a no-op on a session already past it.
 * Unclaimed potluck slots never hold it up.
 */
const END_FOOD_STEP = `UPDATE game_sessions SET status = 'scheduled', planning_stage = NULL
                        WHERE status = 'planning' AND planning_stage = 'food'`;

const foodStepEnded = (s: { id: string; campaign_id: string }, by: { actorId: string } | { closedBy: "session_start" }):
    EventMap["planning.stage_changed"] => ({ sessionId: s.id, campaignId: s.campaign_id, status: "scheduled", stage: null, ...by });

/**
 * The automatic close (#93): every session still in the food step whose start
 * is at or before `now` is scheduled, and a stage_changed is published for
 * each (closedBy "session_start"). Idempotent -- a session it has closed is no
 * longer in the food step -- so it's safe to run every minute, twice, or late.
 * A single UPDATE: it waits for any planner mutation holding a session's lock,
 * then re-checks the stage, so a GM confirm landing at the same moment wins
 * cleanly rather than being announced twice.
 *
 * Run from the every-minute quest-reminders BullMQ job (jobs/workers.ts) with the real
 * clock; tests pass their own `now`. Pass the pool, not a transaction's
 * client: the events go out as soon as the UPDATE returns.
 */
export async function closeDueFoodSteps(db: Db, now: Date): Promise<{ closed: string[] }> {
    const { rows } = await db.query(`${END_FOOD_STEP} AND date <= $1 RETURNING id, campaign_id`, [now]);
    for (const s of rows) {
        await bus.publish("planning.stage_changed", foodStepEnded(s, { closedBy: "session_start" })).catch((err: any) => {
            console.error(`[planning] publishing the food step's close for ${s.id} failed:`, err?.message ?? err);
        });
    }
    return { closed: rows.map((s) => s.id as string) };
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

    /** Where a session's external events say to show up. */
    const eventLocation = (s: any) => s.is_online ? (s.table_link || s.location || "Online")
        : s.venue_name ? venueLocation(s.venue_name, s.venue_address) : (s.location || "In person");

    /** The step a vote can be running on now; anything else is a 409. */
    function votingStage(s: any): "night" | "venue" {
        if (s.status !== "planning") throw new PlanningError(409, `This session is ${s.status}, not being planned.`);
        if (s.planning_stage !== "night" && s.planning_stage !== "venue") {
            throw new PlanningError(409, `This session is on the ${s.planning_stage} step.`);
        }
        return s.planning_stage;
    }

    /**
     * Opens the next venue round. As the night is confirmed it opens by
     * itself, pre-filled with the campaign's recent venues (`withStage`: the
     * stage change already told the party); a re-shortlist opens it with the
     * Game Master's picks.
     */
    async function openVenueRound(db: Db, s: any, options: NewOption[], effects: Effect[],
                                  opts: { actorId?: string; withStage?: true }) {
        const party = await campaignParty(s.campaign_id);
        const poll = await openPoll(db, {
            sessionId: s.id, kind: "venue", eligibleIds: party.map((p) => p.id), quorum: null, options,
        });
        effects.push(publish("planning.poll_opened", {
            sessionId: s.id, campaignId: s.campaign_id, pollId: poll.id, kind: "venue", round: poll.round,
            ...(opts.actorId ? { actorId: opts.actorId } : {}), ...(opts.withStage ? { withStage: true as const } : {}),
        }));
        return poll;
    }

    /**
     * The venue is decided (#92): it becomes the session's venue and location,
     * the venue's last-used time moves to now (so it's offered first next
     * time), and a home's host becomes the session's host, with a "prep the
     * space" quest. A Google event goes out with the venue as its location --
     * in person there's no Discord event. Then the food step (with the food
     * owner's quest under food provided, #93); a session kicked off before
     * the food mode was required may have none, and is scheduled straight away.
     */
    async function confirmVenue(db: Db, s: any, poll: Poll, effects: Effect[]) {
        const option = poll.options.find((o) => o.id === poll.winningOptionId)!;
        const { rows: [v] } = await db.query(`SELECT * FROM venues WHERE id = $1`, [option.venueId]);
        const hostId: string | null = v.kind === "home" ? v.host_id : null;
        const nextStage = s.food_mode ? "food" as const : null;
        await db.query(
            `UPDATE game_sessions SET venue_id = $2, location = $3, host_id = $4, status = $5, planning_stage = $6 WHERE id = $1`,
            [s.id, v.id, v.name, hostId, nextStage ? "planning" : "scheduled", nextStage]);
        await db.query(`UPDATE venues SET last_used_at = $2 WHERE id = $1`, [v.id, deps.now()]);
        effects.push(publish("planning.stage_changed", {
            sessionId: s.id, campaignId: s.campaign_id, status: nextStage ? "planning" : "scheduled", stage: nextStage,
        }));

        if (hostId) {
            const questId = await insertQuest(db, {
                sessionId: s.id, kind: "host_prep", title: "Prep the space",
                notes: `Get ${v.name} ready for "${s.title}".`,
                assigneeId: hostId, dueAt: s.date, createdBy: null,
            });
            const quest = (await getQuest(db, questId))!;
            effects.push(() => announceAssigned(quest, null, null));
        }

        // Food provided (#93): the food owner's one quest, made as the food step opens.
        // (Should the owner's account be gone, the quest waits unclaimed; the GM can reassign it.)
        if (nextStage && s.food_mode === "provided") {
            const questId = await insertQuest(db, {
                sessionId: s.id, kind: "food", title: PROVISION_TITLE,
                notes: `Food for "${s.title}" at ${v.name}.`,
                assigneeId: s.food_owner_id, dueAt: s.date, createdBy: null,
            });
            const quest = (await getQuest(db, questId))!;
            effects.push(() => announceAssigned(quest, null, null));
        }

        const gmIds = await gameMasterIds(db, s.campaign_id, s.gm_override_id);
        const start: Date = s.date, end: Date = s.end_date ?? new Date(+s.date + 4 * HOUR);
        effects.push(async () => {
            const published = await deps.events.publishSession({
                gmIds, name: `${s.campaign_title}: ${s.title}`, description: s.agenda || undefined,
                location: venueLocation(v.name, v.address), start, end,
            });
            await pool.query(
                `UPDATE game_sessions SET google_event_id = COALESCE($2, google_event_id), google_calendar_link = $3 WHERE id = $1`,
                [s.id, published.googleEventId, published.googleCalendarLink]);
            if (published.warnings.length) {
                await notifyGameMasters(s, `"${s.title}" has its venue, with a problem`, published.warnings.join(" "));
            }
        });
    }

    /**
     * The night is decided: fix the date and move on (online sessions are then scheduled).
     *
     * A session that already had a night -- the Game Master changed a
     * scheduled session's night (#87) -- goes straight back to scheduled,
     * whether online or in person: only the night was re-planned. Its
     * existing Discord and Google events move to the new time.
     */
    async function confirmNight(db: Db, s: any, poll: Poll, effects: Effect[]) {
        const option = poll.options.find((o) => o.id === poll.winningOptionId)!;
        const start = option.start!, end = option.end!;
        const previous: { start: Date; end: Date | null } | null = s.date ? { start: s.date, end: s.end_date } : null;
        // A session added with a fixed date may have no end: then only the start says whether it moved.
        const moved = previous !== null && (+previous.start !== +start || (previous.end !== null && +previous.end !== +end));
        const nextStage = previous || s.is_online ? null : "venue";
        await db.query(
            `UPDATE game_sessions SET date = $2, end_date = $3, status = $4, planning_stage = $5,
                    ready_check = CASE WHEN $6 THEN NULL ELSE ready_check END
              WHERE id = $1`,
            [s.id, start, end, nextStage ? "planning" : "scheduled", nextStage, moved]);
        effects.push(publish("planning.stage_changed", {
            sessionId: s.id, campaignId: s.campaign_id, status: nextStage ? "planning" : "scheduled", stage: nextStage,
            ...(previous ? { nightChange: moved ? "moved" as const : "kept" as const } : {}),
        }));
        if (moved) {
            effects.push(publish("planning.night_moved", {
                sessionId: s.id, campaignId: s.campaign_id,
                previousStart: previous!.start.toISOString(), previousEnd: previous!.end?.toISOString() ?? null,
                start: start.toISOString(), end: end.toISOString(),
            }));
        }
        if (nextStage) {
            // In person, the venue vote opens straight away with the venues the campaign used last.
            const { rows: recent } = await db.query(
                `SELECT id FROM venues WHERE campaign_id = $1 AND last_used_at IS NOT NULL
                  ORDER BY last_used_at DESC, id LIMIT $2`, [s.campaign_id, RECENT_VENUES]);
            await openVenueRound(db, s, recent.map((r) => ({ venueId: r.id })), effects, { withStage: true });
            return;
        }

        const gmIds = await gameMasterIds(db, s.campaign_id, s.gm_override_id);
        const event = {
            gmIds,
            name: `${s.campaign_title}: ${s.title}`,
            description: s.agenda || undefined,
            location: eventLocation(s),
            start, end,
            discord: s.discord_guild_id
                ? { guildId: s.discord_guild_id, channelId: s.discord_channel_id || undefined }
                : undefined,
        };

        if (previous) {
            // The vote kept the same night: nothing to send out (nightChange "kept" tells the party).
            if (!moved) return;
            effects.push(async () => {
                const published = await deps.events.rescheduleSession({
                    ...event,
                    existing: { discordEventId: s.discord_event_id, googleEventId: s.google_event_id },
                    createMissing: Boolean(s.is_online),
                });
                await pool.query(
                    `UPDATE game_sessions SET discord_event_id = $2, google_event_id = $3, google_calendar_link = $4 WHERE id = $1`,
                    [s.id, published.discordEventId, published.googleEventId, published.googleCalendarLink]);
                if (published.warnings.length) {
                    await notifyGameMasters(s, `"${s.title}" moved, with a problem`, published.warnings.join(" "));
                }
            });
            return;
        }

        effects.push(async () => {
            const published = await deps.events.publishSession(event);
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
     * Opens the next night round for the party as it stands now. The caller
     * closes any open round first. `nightChange` marks the round a reopen
     * starts, which the reopen's stage change already announces.
     */
    async function openNightRound(db: Db, actor: Actor, s: any, options: { start: Date; end: Date }[], effects: Effect[],
                                  nightChange?: "reopened") {
        const party = await campaignParty(s.campaign_id);
        const poll = await openPoll(db, {
            sessionId: s.id, kind: "night", eligibleIds: party.map((p) => p.id),
            quorum: resolveQuorum(s.campaign_quorum, party.length),
            options: options.map((o) => ({ ...o, suggestedBy: actor.id })),
        });
        effects.push(publish("planning.poll_opened", {
            sessionId: s.id, campaignId: s.campaign_id, pollId: poll.id, kind: "night", round: poll.round, actorId: actor.id,
            ...(nightChange ? { nightChange } : {}),
        }));
        return poll;
    }

    /** A vote has a winner: act on it. */
    const confirm = (db: Db, s: any, poll: Poll, effects: Effect[]) =>
        poll.kind === "night" ? confirmNight(db, s, poll, effects) : confirmVenue(db, s, poll, effects);

    /**
     * Close the open poll and act on what it says. A tie or a failed round
     * leaves the session on its step; the poll_closed event tells the Game
     * Master (planning/announcements.ts).
     */
    async function settle(db: Db, s: any, poll: Poll, reason: CloseReason, effects: Effect[]) {
        const closed = await closePoll(db, poll, reason);
        effects.push(publish("planning.poll_closed", {
            sessionId: s.id, campaignId: s.campaign_id, pollId: closed.id, kind: closed.kind, result: closed.result, reason,
        }));
        if (closed.result === "winner") await confirm(db, s, closed, effects);
    }

    async function state(actor: Actor, sessionId: string) {
        const s = await loadSession(pool, sessionId, false);
        const role = await roleIn(pool, actor.id, s.campaign_id, s.gm_override_id);
        if (!role.member) throw new PlanningError(403, "Only the party can see this session's planning.");
        const [party, rounds, venueRounds, venues, foodQuests, gmIds] = await Promise.all([
            campaignParty(s.campaign_id), pollsOf(pool, s.id, "night"), pollsOf(pool, s.id, "venue"),
            s.is_online ? [] : campaignVenues(pool, s.campaign_id),
            s.food_mode ? sessionQuests(pool, s.id, "food") : [],
            gameMasterIds(pool, s.campaign_id, null),
        ]);
        const night = rounds.at(-1) ?? null;
        const venuePoll = venueRounds.at(-1) ?? null;

        // Addresses show for the confirmed venue, and for the venues on the
        // vote while it's still being decided (open, or tied and waiting on
        // the Game Master) -- not for saved venues off the shortlist, nor for
        // a round's losers once it's over.
        const showAddress = new Set<string>(s.venue_id ? [s.venue_id] : []);
        if (venuePoll && s.status === "planning" && s.planning_stage === "venue") {
            for (const o of venuePoll.options) showAddress.add(o.venueId!);
        }
        const byId = new Map(venues.map((v: any) => [v.id, v]));
        const venue = (id: string | null) => id && byId.has(id) ? venueJson(byId.get(id), showAddress.has(id)) : null;
        const venuePollJson = (p: Poll) => {
            const json = pollJson(p);
            return { ...json, options: json.options.map((o) => ({ ...o, venue: venue(o.venueId) })) };
        };

        return {
            session: {
                id: s.id, campaignId: s.campaign_id, title: s.title, status: s.status, stage: s.planning_stage,
                isOnline: s.is_online, foodMode: s.food_mode, foodOwnerId: s.food_owner_id, agenda: s.agenda,
                date: s.date?.toISOString() ?? null, endDate: s.end_date?.toISOString() ?? null, location: s.location,
                /** The confirmed venue (#92), with its address. */
                venue: venue(s.venue_id),
                hostId: s.host_id,
                googleCalendarLink: s.google_calendar_link, discordEventId: s.discord_event_id, googleEventId: s.google_event_id,
                // The one-session stand-in Game Master (#89), if the torch was passed for this session.
                gmOverride: s.gm_override_id ? { id: s.gm_override_id, name: await personName(s.gm_override_id, party) } : null,
            },
            campaign: {
                id: s.campaign_id, title: s.campaign_title, gmTitle: s.gm_title, quorum: s.campaign_quorum, tableLink: s.table_link,
                gameMasterIds: gmIds,
            },
            party,
            quorum: resolveQuorum(s.campaign_quorum, party.length),
            viewer: { id: actor.id, isGameMaster: role.gm, canPassTorch: role.campaignGm },
            night: night ? pollJson(night) : null,
            /** Every round so far, oldest first, the current one last (#87: earlier rounds stay visible). */
            nightRounds: rounds.map(pollJson),
            /** In person (#92): the latest venue round; each option carries its venue. */
            venue: venuePoll ? venuePollJson(venuePoll) : null,
            venueRounds: venueRounds.map(venuePollJson),
            /** In person: the campaign's saved venues, most recently used first, to shortlist or suggest from. */
            venues: venues.map((v: any) => venueJson(v, showAddress.has(v.id))),
            /**
             * In person (#93): how food works, and its quests in the order they
             * were made -- potluck slots (an unclaimed one has a null
             * assignee), or the food owner's provisioning quest.
             */
            food: s.food_mode ? { mode: s.food_mode, ownerId: s.food_owner_id, quests: foodQuests.map(foodQuestJson) } : null,
        };
    }

    /**
     * The potluck as it stands, for a food-step action (#93): the session,
     * locked, on its food step with a potluck. `who` says who may act --
     * "gm" the Game Master (the campaign's, the session's stand-in, or an
     * admin); "party" a party member, since claims are quests and quests go
     * only to the party.
     */
    async function lockPotluck(db: Db, actor: Actor, sessionId: string, who: "gm" | "party") {
        const s = await loadSession(db, sessionId, true);
        if (who === "gm") await requireGm(db, actor, s);
        else if (!(await isPartyMember(db, s.campaign_id, actor.id))) throw new PlanningError(403, "Only the party can bring food.");
        requireStage(s, "food");
        if (s.food_mode !== "potluck") throw new PlanningError(409, "This session's food is provided, not a potluck.");
        return s;
    }

    /** A potluck slot of this session, its row locked; 404 if it isn't one. */
    async function lockSlot(db: Db, sessionId: string, questId: string) {
        const { rows: [t] } = isUuid(questId) ? await db.query(
            `SELECT id, status, assignee_id FROM session_tasks WHERE id = $1 AND session_id = $2 AND kind = 'food' FOR UPDATE`,
            [questId, sessionId]) : { rows: [] };
        if (!t) throw new PlanningError(404, "That food slot isn't on this session.");
        if (t.status !== "open") throw new PlanningError(409, `That slot is ${t.status}.`);
        return t as { id: string; status: string; assignee_id: string | null };
    }

    /** 409 if a title is already one of the potluck's open slots (case-insensitive). */
    async function requireNewSlots(db: Db, sessionId: string, titles: string[], hint: string) {
        const { rows } = await db.query(
            `SELECT title FROM session_tasks WHERE session_id = $1 AND kind = 'food' AND status = 'open'`, [sessionId]);
        const taken = new Set(rows.map((r) => r.title.toLowerCase()));
        const clash = titles.find((t) => taken.has(t.toLowerCase()));
        if (clash) throw new PlanningError(409, `There's already a "${clash}" slot${hint}.`);
        if (rows.length + titles.length > MAX_FOOD_SLOTS) {
            throw new PlanningError(409, `A potluck holds up to ${MAX_FOOD_SLOTS} slots.`);
        }
    }

    /** Adds potluck slots, owned by `assigneeId` or unclaimed, and announces each after the commit. */
    async function addSlots(db: Db, s: any, titles: string[], assigneeId: string | null, actor: Actor, effects: Effect[]) {
        for (const title of titles) {
            const id = await insertQuest(db, {
                sessionId: s.id, kind: "food", title, assigneeId, dueAt: s.date, createdBy: actor.id,
            });
            const quest = (await getQuest(db, id))!;
            effects.push(() => announceAssigned(quest, actor.id, null));
        }
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
            const { rows: scheduled } = await pool.query(
                `SELECT s.id, s.title, s.date, s.end_date, s.is_online, s.gm_override_id, s.host_id,
                        v.id AS venue_id, v.name AS venue_name, v.address AS venue_address, v.kind AS venue_kind,
                        v.host_id AS venue_host_id, v.last_used_at AS venue_last_used_at
                   FROM game_sessions s LEFT JOIN venues v ON v.id = s.venue_id
                  WHERE s.campaign_id = $1 AND s.status = 'scheduled' AND s.date > $2 ORDER BY s.date LIMIT 10`, [campaignId, deps.now()]);
            // A one-session stand-in counts only while they're still in the party (#89), so the party is everyone.
            if (!role.member) throw new PlanningError(403, "Only the party can see the Notice Board.");
            return {
                canPlan: role.gm, gmTitle: c.gm_title,
                /** Who kickoff can name as the food owner (#92); only the party sees it. */
                party: await campaignParty(campaignId),
                planning: await Promise.all(rows.map((r) => state(actor, r.id))),
                /** Scheduled sessions still to come; the Game Master can change their night (#87). */
                upcoming: scheduled.map((r) => ({
                    id: r.id, title: r.title, date: r.date.toISOString(), endDate: r.end_date?.toISOString() ?? null,
                    isOnline: r.is_online, canChangeNight: role.gm || r.gm_override_id === actor.id,
                    // Only the party (and a stand-in GM) gets here, and a confirmed venue's address is theirs to see.
                    venue: r.venue_id ? venueJson({
                        id: r.venue_id, name: r.venue_name, kind: r.venue_kind, host_id: r.venue_host_id,
                        address: r.venue_address, last_used_at: r.venue_last_used_at,
                    }, true) : null,
                    hostId: r.host_id,
                })),
            };
        },

        /**
         * Start planning: online (night -> scheduled) or in person (night ->
         * venue -> food -> scheduled). In person, the Game Master chooses how
         * food works now (#93): potluck, or provided by one person in the
         * party (the GM included).
         */
        async kickoff(actor: Actor, campaignId: string, body: any) {
            if (!isUuid(campaignId)) throw new PlanningError(404, "Campaign not found.");
            const title = cleanTitle(body?.title);
            if (typeof body?.isOnline !== "boolean") throw new PlanningError(400, "Choose online or in person.");
            const foodMode = body.foodMode ?? null;
            if (foodMode === null && !body.isOnline) throw new PlanningError(400, "Choose how food works: potluck or food provided.");
            if (foodMode !== null) {
                if (body.isOnline) throw new PlanningError(400, "Only in-person sessions have a food step.");
                if (!FOOD_MODES.includes(foodMode)) throw new PlanningError(400, "Food is potluck or provided.");
            }
            const foodOwnerId = body.foodOwnerId ?? null;
            if (foodMode === "provided" && foodOwnerId === null) throw new PlanningError(400, "Choose who provides the food.");
            if (foodMode !== "provided" && foodOwnerId !== null) throw new PlanningError(400, "A food owner goes with food provided.");
            const agenda = typeof body.agenda === "string" ? body.agenda.trim().slice(0, 2000) : null;

            const id = await mutate(async (db, effects) => {
                const { rows: [c] } = await db.query(`SELECT id, title, gm_title FROM campaigns WHERE id = $1`, [campaignId]);
                if (!c) throw new PlanningError(404, "Campaign not found.");
                const role = await roleIn(db, actor.id, campaignId);
                if (!role.gm) throw new PlanningError(403, `Only the ${c.gm_title} can start planning.`);
                if (foodOwnerId !== null && !(await isPartyMember(db, campaignId, foodOwnerId))) {
                    throw new PlanningError(400, "The food owner must be in the party.");
                }
                const { rows: [s] } = await db.query(
                    `INSERT INTO game_sessions (title, campaign_id, date, status, planning_stage, is_online, agenda, food_mode, food_owner_id)
                     VALUES ($1, $2, NULL, 'planning', 'night', $3, $4, $5, $6) RETURNING id`,
                    [title, campaignId, body.isOnline, agenda || null, foodMode, foodOwnerId]);
                effects.push(publish("planning.stage_changed", {
                    sessionId: s.id, campaignId, status: "planning", stage: "night", actorId: actor.id,
                }));
                return s.id as string;
            });
            return state(actor, id);
        },

        /**
         * Put options to the party: on the night step 2-4 times ({ options }),
         * on the venue step 1-6 of the campaign's saved venues ({ venueIds }).
         * With `replace`, an open round is abandoned for this one.
         */
        async shortlist(actor: Actor, sessionId: string, body: any, opts: { replace: boolean }) {
            await mutate(async (db, effects) => {
                const s = await loadSession(db, sessionId, true);
                await requireGm(db, actor, s);
                const stage = votingStage(s);
                const nights = stage === "night" ? cleanNightOptions(body?.options, deps.now()) : [];
                const venueIds = stage === "venue" ? await cleanVenueIds(db, s.campaign_id, body?.venueIds) : [];
                const open = await openPollOf(db, s.id);
                if (open && !opts.replace) throw new PlanningError(409, "A vote is already open. Re-shortlist to replace it.");
                if (open) {
                    await closePoll(db, open, "gm_reshortlisted");
                    effects.push(publish("planning.poll_closed", {
                        sessionId: s.id, campaignId: s.campaign_id, pollId: open.id, kind: open.kind, result: null, reason: "gm_reshortlisted",
                    }));
                }
                if (stage === "night") await openNightRound(db, actor, s, nights, effects);
                else await openVenueRound(db, s, venueIds.map((venueId) => ({ venueId, suggestedBy: actor.id })), effects, { actorId: actor.id });
            });
            return state(actor, sessionId);
        },

        /**
         * Put a venue on the open venue vote (#92): anyone in the party can
         * suggest one -- say, to offer to host -- and the Game Master can add
         * any venue. Either one of the campaign's saved venues, or a new one,
         * which is saved to the campaign's list.
         */
        async suggestVenue(actor: Actor, sessionId: string, body: any) {
            await mutate(async (db, effects) => {
                const s = await loadSession(db, sessionId, true);
                const role = await roleIn(db, actor.id, s.campaign_id, s.gm_override_id);
                if (!role.member) throw new PlanningError(403, "Only the party can suggest a venue.");
                requireStage(s, "venue");
                const open = await openPollOf(db, s.id);
                if (!open) throw new PlanningError(409, "There's no venue vote open.");
                if (open.options.length >= MAX_VENUE_OPTIONS) {
                    throw new PlanningError(409, `The vote already has ${MAX_VENUE_OPTIONS} venues.`);
                }
                const venueId = await venueToSuggest(db, actor.id, role.gm, s.campaign_id, body);
                const { optionId } = await addOption(db, open, { venueId, suggestedBy: actor.id });
                effects.push(publish("planning.venue_suggested", {
                    sessionId: s.id, campaignId: s.campaign_id, pollId: open.id, optionId, venueId, suggestedBy: actor.id,
                }));
            });
            return state(actor, sessionId);
        },

        /**
         * The Game Master settles the food step at any time (#93): the session
         * is scheduled, whether or not every potluck slot is claimed.
         * Otherwise it closes by itself at the session's start (closeDueFoodSteps).
         */
        async confirmFood(actor: Actor, sessionId: string) {
            await mutate(async (db, effects) => {
                const s = await loadSession(db, sessionId, true);
                await requireGm(db, actor, s);
                requireStage(s, "food");
                await db.query(`${END_FOOD_STEP} AND id = $1`, [s.id]);
                effects.push(publish("planning.stage_changed", foodStepEnded(s, { actorId: actor.id })));
            });
            return state(actor, sessionId);
        },

        /** Potluck (#93): the Game Master seeds slots ({ titles: ["Main", "Snacks", "Drinks"] }), each unclaimed. */
        async seedFood(actor: Actor, sessionId: string, body: any) {
            const titles = cleanSeedTitles(body?.titles);
            await mutate(async (db, effects) => {
                const s = await lockPotluck(db, actor, sessionId, "gm");
                await requireNewSlots(db, s.id, titles, "");
                await addSlots(db, s, titles, null, actor, effects);
            });
            return state(actor, sessionId);
        },

        /** Potluck (#93): someone in the party adds a slot of their own ({ title }), claimed by them. */
        async addFood(actor: Actor, sessionId: string, body: any) {
            const title = cleanSlotTitle(body?.title);
            await mutate(async (db, effects) => {
                const s = await lockPotluck(db, actor, sessionId, "party");
                await requireNewSlots(db, s.id, [title], " — claim it instead");
                await addSlots(db, s, [title], actor.id, actor, effects);
            });
            return state(actor, sessionId);
        },

        /** Potluck (#93): someone in the party claims an open slot; it becomes their quest. */
        async claimFood(actor: Actor, sessionId: string, questId: string) {
            await mutate(async (db, effects) => {
                const s = await lockPotluck(db, actor, sessionId, "party");
                const slot = await lockSlot(db, s.id, questId);
                if (slot.assignee_id === actor.id) return;   // already theirs: nothing to do
                if (slot.assignee_id) throw new PlanningError(409, "Someone has already claimed that slot.");
                await setAssignee(db, slot.id, actor.id);
                const quest = (await getQuest(db, slot.id))!;
                effects.push(() => announceAssigned(quest, actor.id, null));
            });
            return state(actor, sessionId);
        },

        /** Potluck (#93): whoever holds a slot backs out of it; it's open (and highlighted) again. */
        async unclaimFood(actor: Actor, sessionId: string, questId: string) {
            await mutate(async (db, effects) => {
                const s = await lockPotluck(db, actor, sessionId, "party");
                const slot = await lockSlot(db, s.id, questId);
                if (!slot.assignee_id) throw new PlanningError(409, "Nobody has claimed that slot.");
                if (slot.assignee_id !== actor.id) throw new PlanningError(403, "Only whoever claimed a slot can un-claim it.");
                await setAssignee(db, slot.id, null);
                const quest = (await getQuest(db, slot.id))!;
                effects.push(() => announceAssigned(quest, actor.id, actor.id));
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
                votingStage(s);
                const open = await openPollOf(db, s.id);
                if (!open) throw new PlanningError(409, "There's no vote open.");
                if (!open.options.length) throw new PlanningError(409, "Nothing is on the vote yet. Add a venue first.");
                await settle(db, s, open, "gm_advanced", effects);
            });
            return state(actor, sessionId);
        },

        async tiebreak(actor: Actor, sessionId: string, body: any) {
            await mutate(async (db, effects) => {
                const s = await loadSession(db, sessionId, true);
                await requireGm(db, actor, s);
                const last = await latestPoll(db, s.id, votingStage(s));
                if (!last) throw new PlanningError(409, "There's no tie to break.");
                const decided = await breakTie(db, last, body?.optionId);
                effects.push(publish("planning.poll_closed", {
                    sessionId: s.id, campaignId: s.campaign_id, pollId: decided.id, kind: decided.kind, result: "winner",
                    reason: decided.closedReason!,
                }));
                await confirm(db, s, decided, effects);
            });
            return state(actor, sessionId);
        },

        /**
         * Change a scheduled session's night (#87): back to the night step,
         * with a new round of 2-4 times open. The session keeps its old date,
         * and its Discord and Google events stay put, until a new night is
         * confirmed. Meanwhile it counts as being planned, so -- like any
         * session being planned -- it gets no ready check; a vote still open
         * when the old night comes round simply moves it once it's decided.
         */
        async reopen(actor: Actor, sessionId: string, body: any) {
            const options = cleanNightOptions(body?.options, deps.now());
            await mutate(async (db, effects) => {
                const s = await loadSession(db, sessionId, true);
                await requireGm(db, actor, s);
                if (s.status === "planning") {
                    throw new PlanningError(409, s.planning_stage === "night"
                        ? "This session's night is already being decided. Re-shortlist instead."
                        : `The night can't be changed during the ${s.planning_stage} step: finish it, or cancel and plan again.`);
                }
                if (s.status !== "scheduled") throw new PlanningError(409, `This session is ${s.status}.`);
                if (!s.date || s.date <= deps.now()) throw new PlanningError(409, "This session has already started.");
                await db.query(`UPDATE game_sessions SET status = 'planning', planning_stage = 'night' WHERE id = $1`, [s.id]);
                // The announcer tells the party the night is changing -- not that planning has started -- from
                // this stage change; the new round's poll_opened is marked so it isn't announced a second time.
                effects.push(publish("planning.stage_changed", {
                    sessionId: s.id, campaignId: s.campaign_id, status: "planning", stage: "night",
                    actorId: actor.id, nightChange: "reopened", standingStart: s.date.toISOString(),
                }));
                await openNightRound(db, actor, s, options, effects, "reopened");
            });
            return state(actor, sessionId);
        },

        /**
         * Pass the torch for one session (#89): `to`, a party member who isn't
         * already a Game Master, gets full GM control of this session and
         * nothing else. Only the campaign's GM (or an admin) can, not a stand-in.
         */
        async passSession(actor: Actor, sessionId: string, body: any) {
            await mutate(async (db, effects) => {
                const s = await loadSession(db, sessionId, true);
                const role = await roleIn(db, actor.id, s.campaign_id);
                if (!role.campaignGm) throw new PlanningError(403, `Only the ${s.gm_title} can pass the torch.`);
                if (s.status !== "planning" && s.status !== "scheduled") {
                    throw new PlanningError(409, `This session is ${s.status}; its torch can't be passed.`);
                }
                const to = body?.to;
                const { rows: seats } = isUuid(String(to)) ? await db.query(
                    `SELECT status FROM campaign_members WHERE campaign_id = $1 AND person_id = $2`, [s.campaign_id, to]) : { rows: [] };
                if (!seats.length) throw new PlanningError(400, "Pass the torch to someone in the party.");
                if (seats.some((m) => m.status === "Game Master")) throw new PlanningError(400, `They're already the ${s.gm_title}.`);
                if (s.gm_override_id === to) return;

                await db.query(`UPDATE game_sessions SET gm_override_id = $2 WHERE id = $1`, [s.id, to]);
                effects.push(publish("campaign.torch_passed", {
                    campaignId: s.campaign_id, scope: "session", sessionId: s.id, byId: actor.id, fromId: s.gm_override_id, toId: to,
                }));
                // The new stand-in's bell comes from planning/announcements.ts, off this event.
            });
            return state(actor, sessionId);
        },

        /** Take back a one-session pass. The campaign's GM (or an admin) can, and so can the stand-in, stepping down. */
        async clearSessionPass(actor: Actor, sessionId: string) {
            await mutate(async (db, effects) => {
                const s = await loadSession(db, sessionId, true);
                const role = await roleIn(db, actor.id, s.campaign_id);
                if (!role.campaignGm && s.gm_override_id !== actor.id) {
                    throw new PlanningError(403, `Only the ${s.gm_title} can take the torch back.`);
                }
                if (s.status !== "planning" && s.status !== "scheduled") {
                    throw new PlanningError(409, `This session is ${s.status}; its torch can't change hands.`);
                }
                if (!s.gm_override_id) return;
                await db.query(`UPDATE game_sessions SET gm_override_id = NULL WHERE id = $1`, [s.id]);
                effects.push(publish("campaign.torch_passed", {
                    campaignId: s.campaign_id, scope: "session", sessionId: s.id, byId: actor.id, fromId: s.gm_override_id, toId: null,
                }));
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
                // A session whose night was being changed already has events out there (#87).
                if (s.discord_event_id || s.google_event_id) {
                    const gmIds = await gameMasterIds(db, s.campaign_id, s.gm_override_id);
                    effects.push(async () => {
                        const withdrawn = await deps.events.withdrawSession({
                            gmIds, discordGuildId: s.discord_guild_id,
                            discordEventId: s.discord_event_id, googleEventId: s.google_event_id,
                        });
                        await pool.query(
                            `UPDATE game_sessions SET discord_event_id = CASE WHEN $2 THEN NULL ELSE discord_event_id END,
                                    google_event_id = CASE WHEN $3 THEN NULL ELSE google_event_id END WHERE id = $1`,
                            [s.id, withdrawn.discordRemoved, withdrawn.googleRemoved]);
                        if (withdrawn.warnings.length) {
                            await notifyGameMasters(s, `"${s.title}" was cancelled, with a problem`, withdrawn.warnings.join(" "));
                        }
                    });
                }
            });
            return state(actor, sessionId);
        },
    };
}

export type Planner = ReturnType<typeof createPlanner>;
