/**
 * Planning announcements (#88): tells the party when planning needs them.
 *
 * Listens to the planner's bus events and turns each into a bell
 * notification and a Table Talk post from the system sender:
 *
 *   stage_changed planning/night   kickoff: planning has started, watch for the vote
 *     ...nightChange "reopened"    not a kickoff: a scheduled night is changing
 *                                  (#87); the old night stands, vote on the new times
 *   poll_opened                    a vote is open: go and vote (except the round a
 *                                  reopen starts, which the reopen already announced,
 *                                  and the venue vote opening with planning/venue)
 *   stage_changed planning/venue   the night is confirmed (in person); the venue is next
 *   stage_changed planning/food    the venue is confirmed; the food is next
 *   stage_changed scheduled        it's on: when (and where, or the table link)
 *     ...nightChange "kept"        a re-planned night came out the same: it stays on
 *     ...nightChange "moved"       nothing here: night_moved announces it
 *     ...closedBy "session_start"  nothing: the food step closed as the session began (#93)
 *   night_moved                    the night moved: the new night, and what it was (#87)
 *   stage_changed cancelled        planning has stopped
 *   poll_closed tie / no_quorum    the Game Master has to act
 *
 * The planner never calls this module, so the planner doesn't know notifications
 * exist. Every handler swallows its own errors: a failed announcement can't
 * fail the planning action, which committed before the event was published,
 * and on the Redis bus a handler that threw would be retried and post twice.
 *
 * Bell notifications share one key per session, so while unread the party's
 * planning alerts for a session collapse into one entry that keeps updating.
 */
import pool from "../db/index.js";
import { bus } from "../events/index.js";
import type { EventMap } from "../events/events.js";
import { notify } from "../utils/notify.js";
import { postTableTalk } from "../utils/tableTalk.js";
import { campaignParty } from "./availabilityStore.js";
import { gameMasterIds } from "./planner.js";

export const noticeBoardLink = (campaignId: string) => `/game-night/campaigns/${campaignId}#notice-board`;

async function loadSession(sessionId: string) {
    const { rows: [s] } = await pool.query(
        `SELECT s.id, s.title, s.campaign_id, s.is_online, s.date, s.location, s.gm_override_id,
                c.title AS campaign_title, c.gm_title, c.table_link, v.name AS venue_name
           FROM game_sessions s
           JOIN campaigns c ON c.id = s.campaign_id
           LEFT JOIN venues v ON v.id = s.venue_id
          WHERE s.id = $1`, [sessionId]);
    return s ?? null;
}

/**
 * The zone the party's messages state times in: the Game Master's, from their
 * regular availability, else UTC. Message text is read by everyone at once and
 * can't localise per reader, so it names its zone instead.
 */
async function campaignTimeZone(campaignId: string): Promise<string> {
    const { rows: [w] } = await pool.query(
        `SELECT w.time_zone FROM availability_windows w
           JOIN campaign_members m ON m.person_id = w.person_id
          WHERE m.campaign_id = $1 AND m.status = 'Game Master'
          ORDER BY m.joined_at NULLS LAST, w.created_at LIMIT 1`, [campaignId]);
    return w?.time_zone ?? "UTC";
}

async function formatAt(campaignId: string, date: Date | string): Promise<string> {
    return new Date(date).toLocaleString("en-US", {
        timeZone: await campaignTimeZone(campaignId),
        weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
    });
}

async function when(s: any): Promise<string> {
    return s.date ? formatAt(s.campaign_id, s.date) : "date to be confirmed";
}

const where = (s: any) => s.venue_name || s.location || "a place to be confirmed";

/** Bell-notify the party, optionally minus whoever acted. */
async function notifyParty(s: any, except: string | undefined, title: string, body: string) {
    const party = await campaignParty(s.campaign_id);
    await Promise.all(party.filter((p) => p.id !== except).map((p) => notify(p.id, {
        type: "system", title, body, link: noticeBoardLink(s.campaign_id),
        sourceKey: `planning:${s.id}`, meta: { sessionId: s.id, campaignId: s.campaign_id },
    })));
}

async function notifyGameMasters(s: any, title: string, body: string) {
    const ids = await gameMasterIds(pool, s.campaign_id, s.gm_override_id);
    await Promise.all(ids.map((id) => notify(id, {
        type: "system", title, body, link: noticeBoardLink(s.campaign_id),
        sourceKey: `planning-gm:${s.id}`, meta: { sessionId: s.id, campaignId: s.campaign_id },
    })));
}

async function onStageChanged(e: EventMap["planning.stage_changed"]) {
    const s = await loadSession(e.sessionId);
    if (!s) return;
    const board = noticeBoardLink(s.campaign_id);

    if (e.status === "planning" && e.stage === "night" && e.nightChange === "reopened") {
        // Not a kickoff: a confirmed night is being changed, and it stands until a
        // new one is. The event says which night that is: by the time a redelivered
        // event is handled, the session may already have moved.
        const was = e.standingStart ? await formatAt(s.campaign_id, e.standingStart) : await when(s);
        const { rows: [{ n }] } = await pool.query(
            `SELECT count(*)::int AS n FROM poll_options WHERE poll_id =
                (SELECT id FROM polls WHERE session_id = $1 AND kind = 'night' ORDER BY round DESC LIMIT 1)`, [s.id]);
        await notifyParty(s, e.actorId, `The night for "${s.title}" is changing`,
            `${s.campaign_title} — it was ${was}. Tick every new time you can make.`);
        await postTableTalk(s.campaign_id,
            `**The night for "${s.title}" is changing.** It was ${was}; ${n} new times are on the ` +
            `[Notice Board](${board}). Until one is confirmed, the old night stands.`);
    } else if (e.status === "planning" && e.stage === "night") {
        await notifyParty(s, e.actorId, `Planning started: "${s.title}"`,
            `${s.campaign_title} — the ${s.gm_title} is finding a night. Watch the Notice Board for the vote.`);
        await postTableTalk(s.campaign_id,
            `**A new session is being planned:** "${s.title}" (${s.is_online ? "online" : "in person"}). ` +
            `The ${s.gm_title} will shortlist some nights — vote on the [Notice Board](${board}).`);
    } else if (e.status === "planning" && e.stage === "venue") {
        const at = await when(s);
        await notifyParty(s, undefined, `Night set for "${s.title}": ${at}`,
            `${s.campaign_title} — next, pick the venue on the Notice Board.`);
        await postTableTalk(s.campaign_id,
            `**The night is set** for "${s.title}": ${at}. Next, the venue — vote on the [Notice Board](${board}).`);
    } else if (e.status === "planning" && e.stage === "food") {
        await notifyParty(s, undefined, `Venue set for "${s.title}": ${where(s)}`,
            `${s.campaign_title} — next, sort out the food on the Notice Board.`);
        await postTableTalk(s.campaign_id,
            `**The venue is set** for "${s.title}": ${where(s)}. Next, the food — see the [Notice Board](${board}).`);
    } else if (e.status === "scheduled" && e.nightChange === "moved") {
        return;   // planning.night_moved announces it, with the old and new times
    } else if (e.status === "scheduled" && e.closedBy === "session_start") {
        // The food step closed by itself as the session started (#93): the party
        // already knows the night and the venue, and had the ready check at T-30.
        return;
    } else if (e.status === "scheduled" && e.nightChange === "kept") {
        await notifyParty(s, undefined, `"${s.title}" stays on ${await when(s)}`,
            `${s.campaign_title} — the vote kept the same night.`);
    } else if (e.status === "scheduled") {
        const at = await when(s);
        if (s.is_online) {
            await notifyParty(s, undefined, `"${s.title}" is on: ${at}`,
                `${s.campaign_title} — online${s.table_link ? `, at ${s.table_link}` : ""}.`);
            await postTableTalk(s.campaign_id,
                `**The night is set!** "${s.title}" — ${at}, online.` +
                (s.table_link ? ` Table: [${s.table_link}](${s.table_link})` : ""));
        } else {
            await notifyParty(s, undefined, `"${s.title}" is on: ${at}`, `${s.campaign_title} — at ${where(s)}.`);
            await postTableTalk(s.campaign_id, `**"${s.title}" is scheduled:** ${at}, at ${where(s)}.`);
        }
    } else if (e.status === "cancelled") {
        await notifyParty(s, e.actorId, `"${s.title}" was cancelled`,
            `${s.campaign_title} — planning for this session has stopped.`);
        await postTableTalk(s.campaign_id, `Planning for "${s.title}" has been cancelled.`);
    }
}

/** A scheduled session's night moved (#87): tell the party the new night, and what it was. */
async function onNightMoved(e: EventMap["planning.night_moved"]) {
    const s = await loadSession(e.sessionId);
    if (!s) return;
    const [at, was] = await Promise.all([formatAt(s.campaign_id, e.start), formatAt(s.campaign_id, e.previousStart)]);
    const place = s.is_online ? `online${s.table_link ? `, at ${s.table_link}` : ""}` : `at ${where(s)}`;
    await notifyParty(s, undefined, `"${s.title}" moved: ${at}`, `${s.campaign_title} — was ${was}. Now ${place}.`);
    await postTableTalk(s.campaign_id, `**The night has moved!** "${s.title}" — now ${at} (was ${was}), ${place}.`);
}

async function onPollOpened(e: EventMap["planning.poll_opened"]) {
    // The reopen's stage change already announced this round; likewise the
    // venue vote that opens as the night is confirmed (#92).
    if (e.nightChange === "reopened" || e.withStage) return;
    const s = await loadSession(e.sessionId);
    if (!s) return;
    const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int AS n FROM poll_options WHERE poll_id = $1`, [e.pollId]);
    const board = noticeBoardLink(s.campaign_id);
    if (e.kind === "night") {
        await notifyParty(s, e.actorId, `Vote: when can you play "${s.title}"?`,
            `${n} nights shortlisted. Tick every one you can make.`);
        await postTableTalk(s.campaign_id,
            `**Vote on the night** for "${s.title}": ${n} times are on the [Notice Board](${board}). ` +
            `Tick every one you can make — the vote closes when everyone has voted.`);
    } else {
        await notifyParty(s, e.actorId, `Vote: where should we play "${s.title}"?`,
            `${n} venues shortlisted. Pick one.`);
        await postTableTalk(s.campaign_id,
            `**Vote on the venue** for "${s.title}": ${n} places are on the [Notice Board](${board}). ` +
            `Pick one — the vote closes when everyone has voted.`);
    }
}

async function onPollClosed(e: EventMap["planning.poll_closed"]) {
    if (e.result !== "tie" && e.result !== "no_quorum") return;   // a winner announces itself as a stage change
    const s = await loadSession(e.sessionId);
    if (!s) return;
    const what = e.kind === "night" ? "night" : "venue";
    const options = e.kind === "night" ? "times" : "venues";
    if (e.result === "tie") {
        await notifyGameMasters(s, `Tie on "${s.title}"`, `The vote closed level. Pick the ${what} on the Notice Board.`);
        await postTableTalk(s.campaign_id, `The vote for "${s.title}" is a tie — the ${s.gm_title} will pick the ${what}.`);
    } else {
        const { rows: [p] } = await pool.query(`SELECT quorum FROM polls WHERE id = $1`, [e.pollId]);
        await notifyGameMasters(s, `No ${what} worked for "${s.title}"`,
            `None of the shortlisted ${options} reached quorum (${p?.quorum ?? "?"}). Shortlist new ${options} on the Notice Board.`);
        await postTableTalk(s.campaign_id,
            `None of the shortlisted ${options} for "${s.title}" had enough of the party. The ${s.gm_title} will shortlist new ones.`);
    }
}

/**
 * Subscribes the announcements to the bus. Call once at boot, before the bus
 * starts. `idle()` resolves once every announcement in flight has finished,
 * for tests that check what was announced.
 */
export function startPlanningAnnouncements() {
    const pending = new Set<Promise<void>>();
    const on = <K extends keyof EventMap>(name: K, handle: (payload: EventMap[K]) => Promise<void>) =>
        bus.subscribe(name, (payload) => {
            const run = handle(payload).catch((err: any) => {
                console.error(`[planning-announcements] ${name} for session ${(payload as any).sessionId} failed:`, err?.message ?? err);
            });
            pending.add(run);
            void run.finally(() => pending.delete(run));
            return run;
        });

    const unsubscribe = [
        on("planning.stage_changed", onStageChanged),
        on("planning.poll_opened", onPollOpened),
        on("planning.poll_closed", onPollClosed),
        on("planning.night_moved", onNightMoved),
    ];

    return {
        stop() { for (const off of unsubscribe) off(); },
        async idle() {
            // The in-memory bus dispatches on a later tick, so let it, then
            // wait until nothing is left in flight.
            do {
                await new Promise((resolve) => setImmediate(resolve));
                await Promise.all([...pending]);
            } while (pending.size);
        },
    };
}
