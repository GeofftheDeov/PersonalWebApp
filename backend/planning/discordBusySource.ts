/**
 * Discord "interested" events as a busy source (#85, part of #57).
 *
 * For each campaign the person is in that has a linked Discord server
 * (campaigns.discord_guild_id), the app reads that server's scheduled events
 * with the campaign Game Master's bot token -- the same 'discord' entry in the
 * API Key Vault that creates the campaign's session events -- and asks each
 * event who marked it "interested". An event counts as busy for the person
 * when their linked Discord user id (accounts.discord_id, set on the profile
 * or through POST /api/friends/link-discord) is among them. Only the event's
 * times and id are kept; its name never enters the app.
 *
 * Rules:
 *   - No linked Discord id: no Discord signal, and no error.
 *   - A campaign with no linked server, no GM bot token, or a bot that isn't
 *     in the server contributes nothing. That's the Game Master's to fix, so
 *     the player's sync still succeeds and the GM sees a note on the overlap
 *     (discordOverlapNotes).
 *   - Any other Discord failure (an outage, a long rate limit) fails the
 *     sync, so busySources.ts leaves the person's Discord busy time out until
 *     a sync works rather than trusting half an answer.
 *   - Canceled and completed events are ignored. An event with no end time
 *     (voice and stage events may leave it empty) counts for
 *     DEFAULT_EVENT_HOURS: 4 hours, the app's default session length (the
 *     overlap grid's default slot is 240 minutes), which is what "another
 *     game that evening" usually takes.
 *   - A recurring event counts for the occurrence Discord lists (the next one).
 *   - The campaign's OWN session events, which the app created itself
 *     (game_sessions.discord_event_id), are left out of that campaign's
 *     overlap by availabilityStore, so being interested in a session never
 *     blocks planning it. They still count in other campaigns' overlaps:
 *     that's another game.
 *
 * Rate limits and time: one person's sync reads each server once and then
 * asks about at most MAX_EVENTS_PER_GUILD events, INTEREST_CONCURRENCY at a
 * time, and starts no new Discord call after FETCH_BUDGET_MS (inside the
 * sync's own 15 s limit): a sync that runs out of time fails like any other
 * rather than keep calling Discord in the background. Reads are shared for
 * READ_TTL_MS, so a party syncing together for one overlap reads each server
 * once, not once per player; "Sync now" and turning the source on always read
 * afresh. The integrations module honours Discord's rate-limit headers and
 * pages the interested users.
 */
import crypto from "crypto";
import { query } from "../db/index.js";
import { DiscordApiError, integrations, type DiscordScheduledEventTimes } from "../utils/integrations.js";
import { firstKey } from "./externalEvents.js";
import type { BusySourceAdapter, FetchedBusy } from "./busySources.js";

const HOUR = 60 * 60 * 1000;

/** How long an event with no end time counts as busy. */
export const DEFAULT_EVENT_HOURS = 4;
/** Events per server whose interested users one sync asks about (Discord allows 100 scheduled events). */
export const MAX_EVENTS_PER_GUILD = 50;
/** How long one read of a server (or of an event's interested users) is reused. */
export const READ_TTL_MS = 30_000;
/** Interested-user reads in flight at once, per sync. */
export const INTEREST_CONCURRENCY = 4;
/** No Discord call starts after this long into one sync (the sync itself gives up at 15 s). */
export const FETCH_BUDGET_MS = 12_000;
const TOO_SLOW = "Discord took too long to answer. Try \"Sync now\" later.";

const NOT_LINKED = "Add your Discord user ID on your profile (Info tab) first.";
const BAD_ID = "Your Discord user ID should be the long number from Discord's \"Copy User ID\". Fix it on your profile (Info tab).";

/** Scheduled (1) and active (2). Completed (3) and canceled (4) don't count. */
const LIVE = new Set([1, 2]);

type GuildProblem = "not_in_guild" | "bad_token" | "unreachable";
type GuildRead = { ok: true; events: DiscordScheduledEventTimes[] } | { ok: false; problem: GuildProblem; message: string };

const reads = new Map<string, { at: number; value: Promise<unknown> }>();

/**
 * Shares one read between everyone asking within READ_TTL_MS (including while
 * it's still in flight). `fresh` reads anyway, and shares that answer instead.
 */
function shared<T>(key: string, read: () => Promise<T>, fresh = false): Promise<T> {
    const now = Date.now();
    for (const [k, v] of reads) if (now - v.at >= READ_TTL_MS) reads.delete(k);
    const hit = reads.get(key);
    if (hit && !fresh) return hit.value as Promise<T>;
    const value = read();
    value.catch(() => { /* the caller handles it */ });
    reads.set(key, { at: now, value });
    return value;
}

/** Tests only: forget shared reads, so the next sync asks Discord again. */
export function forgetDiscordReads() {
    reads.clear();
}

const tokenKey = (token: string) => crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);

function classify(err: any): { problem: GuildProblem; message: string } {
    const message = String(err?.message ?? "no reason given").slice(0, 160);
    if (err instanceof DiscordApiError && (err.status === 403 || err.status === 404)) return { problem: "not_in_guild", message };
    if (err instanceof DiscordApiError && err.status === 401) return { problem: "bad_token", message };
    return { problem: "unreachable", message };
}

function readGuild(token: string, guildId: string, fresh = false): Promise<GuildRead> {
    return shared(`events|${guildId}|${tokenKey(token)}`, async (): Promise<GuildRead> => {
        try {
            return { ok: true, events: await integrations().discord.listScheduledEvents(token, guildId) };
        } catch (err: any) {
            return { ok: false, ...classify(err) };
        }
    }, fresh);
}

function readInterested(token: string, guildId: string, eventId: string, fresh = false): Promise<string[]> {
    return shared(`users|${guildId}|${eventId}|${tokenKey(token)}`,
        () => integrations().discord.listInterestedUsers(token, guildId, eventId), fresh);
}

/** The person's linked Discord user id: null when there is none, "" when it isn't a Discord id. */
async function linkedDiscordId(personId: string): Promise<string | null> {
    const { rows: [row] } = await query(`SELECT discord_id FROM accounts WHERE id = $1`, [personId]);
    const id = String(row?.discord_id ?? "").trim();
    if (!id) return null;
    return /^\d{15,25}$/.test(id) ? id : "";
}

/** The 'discord' bot token of the campaign's Game Master (the first one holding one). */
async function campaignBotToken(campaignId: string): Promise<string | null> {
    const { rows } = await query(
        `SELECT person_id FROM campaign_members
          WHERE campaign_id = $1 AND status = 'Game Master' AND person_id IS NOT NULL
          ORDER BY joined_at NULLS LAST, created_at`, [campaignId]);
    const keys = await firstKey([...new Set(rows.map((r) => r.person_id as string))], "discord");
    return keys?.secret || null;
}

const endOf = (e: DiscordScheduledEventTimes) => e.end ?? new Date(e.start.getTime() + DEFAULT_EVENT_HOURS * HOUR);

export const discordBusySource: BusySourceAdapter = {
    name: "discord",

    async connection(personId) {
        const id = await linkedDiscordId(personId);
        if (id === null) return { connected: false, ready: false, needsReconsent: false, problem: NOT_LINKED };
        if (!id) return { connected: true, ready: false, needsReconsent: false, problem: BAD_ID };
        return { connected: true, ready: true, needsReconsent: false, problem: null };
    },

    async fetchBusy(personId, range, opts) {
        const fresh = !!opts?.manual;
        const deadline = Date.now() + FETCH_BUDGET_MS;
        const inTime = () => { if (Date.now() > deadline) throw new Error(TOO_SLOW); };
        const me = await linkedDiscordId(personId);
        if (!me) return [];   // no linked id, no Discord signal

        const { rows: links } = await query(
            `SELECT DISTINCT c.id AS campaign_id, c.discord_guild_id AS guild_id
               FROM campaign_members m JOIN campaigns c ON c.id = m.campaign_id
              WHERE m.person_id = $1 AND coalesce(c.discord_guild_id, '') <> ''
              ORDER BY c.discord_guild_id, c.id`, [personId]);

        // One token per server: the first of its campaigns whose GM has one.
        const guilds = new Map<string, string | null>();
        for (const { campaign_id, guild_id } of links) {
            if (guilds.get(guild_id)) continue;
            guilds.set(guild_id, await campaignBotToken(campaign_id));
        }

        const out: FetchedBusy[] = [];
        for (const [guildId, token] of guilds) {
            if (!token) continue;   // the GM's overlap says why
            inTime();
            const read = await readGuild(token, guildId, fresh);
            if (!read.ok) {
                if (read.problem === "unreachable") throw new Error(`Discord events couldn't be read just now (${read.message}).`);
                continue;   // bot not in the server, or a bad token: the GM's overlap says why
            }
            const relevant = read.events
                .filter((e) => LIVE.has(e.status) && Number.isFinite(e.start.getTime()) &&
                    e.start < range.end && endOf(e) > range.start)
                .sort((a, b) => a.start.getTime() - b.start.getTime())
                .slice(0, MAX_EVENTS_PER_GUILD);
            // A few at a time: quick for a big server, gentle on Discord's rate limits.
            let next = 0, stop = false;
            const worker = async () => {
                while (!stop && next < relevant.length) {
                    const e = relevant[next++];
                    try { inTime(); } catch (err) { stop = true; throw err; }
                    let interested: string[];
                    try {
                        interested = await readInterested(token, guildId, e.id, fresh);
                    } catch (err: any) {
                        const { problem, message } = classify(err);
                        if (problem === "unreachable") {
                            stop = true;
                            throw new Error(`Discord events couldn't be read just now (${message}).`);
                        }
                        continue;   // the event vanished, or the bot can't see its channel
                    }
                    if (interested.includes(me)) out.push({ start: e.start, end: endOf(e), externalId: e.id });
                }
            };
            const workers = Array.from({ length: Math.min(INTEREST_CONCURRENCY, relevant.length) }, worker);
            // The first failure fails the sync, and the other workers start no more calls.
            await Promise.all(workers);
        }
        return out;
    },
};

const NOTE = "Discord events aren't counted as busy";

/**
 * Why Discord busy time is missing from this campaign's overlap, for its Game
 * Master: no linked server, no bot token, or a bot that isn't in the server.
 * Empty when it works, or when nobody in the party counts Discord events.
 * Names no player.
 */
export async function discordOverlapNotes(campaignId: string, partyIds: string[]): Promise<string[]> {
    if (!partyIds.length) return [];
    const { rows: [{ n }] } = await query(
        `SELECT count(*)::int AS n FROM busy_sources WHERE source = 'discord' AND person_id = ANY($1)`, [partyIds]);
    if (!n) return [];
    const { rows: [c] } = await query(`SELECT discord_guild_id FROM campaigns WHERE id = $1`, [campaignId]);
    const guildId = String(c?.discord_guild_id ?? "").trim();
    if (!guildId) return [`${NOTE}: this campaign has no Discord server linked.`];
    const token = await campaignBotToken(campaignId);
    if (!token) return [`${NOTE}: there's no 'discord' bot token in the Game Master's API Key Vault.`];
    const read = await readGuild(token, guildId);
    if (read.ok) return [];
    if (read.problem === "not_in_guild") return [`${NOTE}: the bot isn't in this campaign's Discord server (or can't see its events).`];
    if (read.problem === "bad_token") return [`${NOTE}: Discord refused the Game Master's bot token.`];
    return ["Discord events couldn't be read just now, so some Discord busy time may be missing."];
}
