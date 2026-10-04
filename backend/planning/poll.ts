/**
 * Poll (#57): the vote behind the night step and the venue step.
 *
 *   night  approval voting -- tick every time you can make. An option meets
 *          quorum when its approvals reach the poll's quorum; the winner is
 *          the option meeting quorum with the most approvals. None meeting
 *          quorum fails the round, and the Game Master re-shortlists.
 *   venue  single choice -- most votes wins.
 *
 * Either way a tie goes to the Game Master, and a poll closes when every
 * eligible voter has voted or when the Game Master moves forward. There is no
 * deadline timer.
 *
 * Eligible voters and the quorum are fixed when the poll opens. A ballot row
 * means "has voted" even when it approves nothing ("I can't make any of
 * these"), which is what closing on "everyone has voted" counts.
 *
 * Every function takes the caller's database client: the planner runs them
 * inside its own transaction, with the session row locked, so two last votes
 * landing together cannot both close the poll.
 */
import type pg from "pg";

export type PollKind = "night" | "venue";
export type PollResult = "winner" | "tie" | "no_quorum";
export type CloseReason = "all_voted" | "gm_advanced" | "gm_reshortlisted" | "cancelled";

type Db = Pick<pg.PoolClient, "query">;

/** A 4xx the route can hand straight back. */
export class PollError extends Error {
    constructor(public status: number, message: string) { super(message); }
}

export interface PollOption {
    id: string;
    start: Date | null;
    end: Date | null;
    venueId: string | null;
    suggestedBy: string | null;
    /** Who chose this option, in ballot order. */
    approvals: string[];
}

export interface Poll {
    id: string;
    sessionId: string;
    kind: PollKind;
    round: number;
    status: "open" | "closed";
    eligibleIds: string[];
    quorum: number | null;
    result: PollResult | null;
    closedReason: CloseReason | null;
    winningOptionId: string | null;
    openedAt: Date;
    closedAt: Date | null;
    /** Everyone who has cast a ballot, including ballots that approve nothing. */
    voted: string[];
    options: PollOption[];
}

export type NewOption = { start: Date; end: Date; suggestedBy?: string } | { venueId: string; suggestedBy?: string };

async function load(db: Db, where: string, params: unknown[]): Promise<Poll | null> {
    const { rows: [p] } = await db.query(`SELECT * FROM polls WHERE ${where} LIMIT 1`, params);
    if (!p) return null;
    // One after another: `db` is often a transaction's single client, which
    // can't run queries concurrently.
    const opts = await db.query(`SELECT * FROM poll_options WHERE poll_id = $1 ORDER BY starts_at NULLS LAST, created_at, id`, [p.id]);
    const ballots = await db.query(`SELECT person_id FROM poll_ballots WHERE poll_id = $1 ORDER BY cast_at, person_id`, [p.id]);
    const votes = await db.query(
        `SELECT v.option_id, v.person_id FROM poll_votes v
           JOIN poll_ballots b ON b.poll_id = v.poll_id AND b.person_id = v.person_id
          WHERE v.poll_id = $1 ORDER BY b.cast_at, v.person_id`, [p.id]);
    return {
        id: p.id, sessionId: p.session_id, kind: p.kind, round: p.round, status: p.status,
        eligibleIds: p.eligible_ids, quorum: p.quorum, result: p.result, closedReason: p.closed_reason,
        winningOptionId: p.winning_option_id, openedAt: p.opened_at, closedAt: p.closed_at,
        voted: ballots.rows.map((b) => b.person_id),
        options: opts.rows.map((o) => ({
            id: o.id, start: o.starts_at, end: o.ends_at, venueId: o.venue_id, suggestedBy: o.suggested_by,
            approvals: votes.rows.filter((v) => v.option_id === o.id).map((v) => v.person_id),
        })),
    };
}

export const getPoll = (db: Db, pollId: string) => load(db, "id = $1", [pollId]);

/** The session's most recent poll of this kind, open or closed. */
export const latestPoll = (db: Db, sessionId: string, kind: PollKind) =>
    load(db, "session_id = $1 AND kind = $2 ORDER BY round DESC", [sessionId, kind]);

/** Every round of this kind for the session, oldest first: closed rounds and their votes stay visible. */
export async function pollsOf(db: Db, sessionId: string, kind: PollKind): Promise<Poll[]> {
    const { rows } = await db.query(`SELECT id FROM polls WHERE session_id = $1 AND kind = $2 ORDER BY round`, [sessionId, kind]);
    const out: Poll[] = [];
    for (const r of rows) out.push((await getPoll(db, r.id))!);
    return out;
}

export const openPollOf = (db: Db, sessionId: string) => load(db, "session_id = $1 AND status = 'open'", [sessionId]);

/** Opens the next round of this kind for the session. The caller closes any open poll first. */
export async function openPoll(db: Db, input: {
    sessionId: string; kind: PollKind; eligibleIds: string[]; quorum: number | null; options: NewOption[];
}): Promise<Poll> {
    const { rows: [{ next }] } = await db.query(
        `SELECT COALESCE(MAX(round), 0) + 1 AS next FROM polls WHERE session_id = $1 AND kind = $2`,
        [input.sessionId, input.kind]);
    const { rows: [poll] } = await db.query(
        `INSERT INTO polls (session_id, kind, round, eligible_ids, quorum) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [input.sessionId, input.kind, next, input.eligibleIds, input.kind === "night" ? input.quorum : null]);
    for (const o of input.options) await insertOption(db, poll.id, o);
    return (await getPoll(db, poll.id))!;
}

/**
 * clock_timestamp(), not now(): options inserted in one transaction would
 * otherwise share a created_at, and venue options (which have no time to sort
 * by) would come back in id order instead of the order they were put up in.
 */
async function insertOption(db: Db, pollId: string, o: NewOption): Promise<string> {
    const { rows: [row] } = "venueId" in o
        ? await db.query(`INSERT INTO poll_options (poll_id, venue_id, suggested_by, created_at)
                          VALUES ($1, $2, $3, clock_timestamp()) RETURNING id`, [pollId, o.venueId, o.suggestedBy ?? null])
        : await db.query(`INSERT INTO poll_options (poll_id, starts_at, ends_at, suggested_by, created_at)
                          VALUES ($1, $2, $3, $4, clock_timestamp()) RETURNING id`, [pollId, o.start, o.end, o.suggestedBy ?? null]);
    return row.id;
}

/**
 * Adds an option to a vote that's already open: a venue someone suggests
 * mid-vote (#92). Ballots already cast stand, and can still be changed.
 */
export async function addOption(db: Db, poll: Poll, option: NewOption): Promise<{ poll: Poll; optionId: string }> {
    if (poll.status !== "open") throw new PollError(409, "This vote has closed.");
    if ("venueId" in option !== (poll.kind === "venue")) throw new PollError(400, `That isn't a ${poll.kind} option.`);
    if ("venueId" in option && poll.options.some((o) => o.venueId === option.venueId)) {
        throw new PollError(409, "That venue is already on the vote.");
    }
    const optionId = await insertOption(db, poll.id, option);
    return { poll: (await getPoll(db, poll.id))!, optionId };
}

/** Replaces this person's ballot. Night: any number of options, none included. Venue: exactly one. */
export async function castBallot(db: Db, poll: Poll, personId: string, optionIds: unknown): Promise<Poll> {
    if (poll.status !== "open") throw new PollError(409, "This vote has closed.");
    if (!poll.eligibleIds.includes(personId)) {
        throw new PollError(403, "You weren't in the party when this vote opened.");
    }
    if (!Array.isArray(optionIds) || optionIds.some((id) => typeof id !== "string")) {
        throw new PollError(400, "optionIds must be an array of option ids.");
    }
    const chosen = [...new Set(optionIds as string[])];
    const known = new Set(poll.options.map((o) => o.id));
    if (chosen.some((id) => !known.has(id))) throw new PollError(400, "That option isn't on this vote.");
    if (poll.kind === "venue" && chosen.length !== 1) throw new PollError(400, "Pick exactly one venue.");

    await db.query(`DELETE FROM poll_votes WHERE poll_id = $1 AND person_id = $2`, [poll.id, personId]);
    await db.query(
        `INSERT INTO poll_ballots (poll_id, person_id) VALUES ($1, $2)
         ON CONFLICT (poll_id, person_id) DO UPDATE SET cast_at = now()`, [poll.id, personId]);
    for (const optionId of chosen) {
        await db.query(`INSERT INTO poll_votes (poll_id, option_id, person_id) VALUES ($1, $2, $3)`,
            [poll.id, optionId, personId]);
    }
    return (await getPoll(db, poll.id))!;
}

export const everyoneVoted = (poll: Poll) => poll.eligibleIds.every((id) => poll.voted.includes(id));

/** True when a night option has enough approvals. Venue options always qualify. */
export const meetsQuorum = (poll: Poll, option: PollOption) =>
    poll.kind !== "night" || option.approvals.length >= (poll.quorum ?? 1);

/** What the votes say, without changing anything. `leaders` are the options a tie is between. */
export function tally(poll: Poll): { result: PollResult; leaders: string[] } {
    const qualifying = poll.options.filter((o) => meetsQuorum(poll, o));
    if (!qualifying.length) return { result: "no_quorum", leaders: [] };
    const best = Math.max(...qualifying.map((o) => o.approvals.length));
    const leaders = qualifying.filter((o) => o.approvals.length === best).map((o) => o.id);
    return { result: leaders.length === 1 ? "winner" : "tie", leaders };
}

/**
 * Closes an open poll. Closing because everyone voted or the GM moved forward
 * records the result; re-shortlisting or cancelling abandons it.
 */
export async function closePoll(db: Db, poll: Poll, reason: CloseReason): Promise<Poll> {
    if (poll.status !== "open") throw new PollError(409, "This vote has already closed.");
    const decided = reason === "all_voted" || reason === "gm_advanced";
    const { result, leaders } = decided ? tally(poll) : { result: null, leaders: [] };
    await db.query(
        `UPDATE polls SET status = 'closed', closed_at = now(), closed_reason = $2, result = $3, winning_option_id = $4
          WHERE id = $1`,
        [poll.id, reason, result, result === "winner" ? leaders[0] : null]);
    return (await getPoll(db, poll.id))!;
}

/** The Game Master's pick between the options a closed vote tied on. */
export async function breakTie(db: Db, poll: Poll, optionId: unknown): Promise<Poll> {
    if (poll.status !== "closed" || poll.result !== "tie") throw new PollError(409, "There's no tie to break.");
    const { leaders } = tally(poll);
    if (typeof optionId !== "string" || !leaders.includes(optionId)) {
        throw new PollError(400, "Pick one of the options that tied.");
    }
    await db.query(`UPDATE polls SET result = 'winner', winning_option_id = $2 WHERE id = $1`, [poll.id, optionId]);
    return (await getPoll(db, poll.id))!;
}

/** The poll as the party sees it: every vote is public within the party (#57, story 28). */
export function pollJson(poll: Poll) {
    const { leaders } = poll.status === "closed" && poll.result === "tie" ? tally(poll) : { leaders: [] as string[] };
    return {
        id: poll.id, kind: poll.kind, round: poll.round, status: poll.status,
        result: poll.result, closedReason: poll.closedReason, quorum: poll.quorum,
        eligibleIds: poll.eligibleIds, voted: poll.voted, winningOptionId: poll.winningOptionId, tiedOptionIds: leaders,
        openedAt: poll.openedAt.toISOString(), closedAt: poll.closedAt?.toISOString() ?? null,
        options: poll.options.map((o) => ({
            id: o.id, start: o.start?.toISOString() ?? null, end: o.end?.toISOString() ?? null,
            venueId: o.venueId, suggestedBy: o.suggestedBy, approvals: o.approvals, meetsQuorum: meetsQuorum(poll, o),
        })),
    };
}
