import type { CommandReply } from "./ask.js";
import { centralDay } from "./format.js";
import { briefDates, briefSpeech, readBrief, type BriefSpeech } from "../utils/briefs.js";

/**
 * The brief, read aloud (spec #135 W3, #152).
 *
 *   GET /admin/os/api/brief/say?date=YYYY-MM-DD   (routes/osRoutes.ts)
 *   "read the brief"                              (tier 1, intent `brief.read`, os/commands.ts)
 *
 * Both read the vault checkout at OBSIDIAN_VAULT_PATH on every call, like the
 * brief tile. The text is the brief's `## Say` section, or its Top 3 as plain
 * text when it has none (utils/briefs.ts `briefSpeech`). #153 polls the
 * endpoint after a confirmed morning-brief run succeeds, then speaks `text`.
 */

export const READ_BRIEF_INTENT = "brief.read";

export type BriefSpeechLookup =
    | { found: "speech"; speech: BriefSpeech }
    /** No brief file for that day. */
    | { found: "no_brief"; date: string }
    /** The file is there but couldn't be read. */
    | { found: "unreadable"; date: string }
    /** OBSIDIAN_VAULT_PATH is unset on this service. */
    | { found: "no_vault" };

/** The speech for one day's brief. `date` must already be YYYY-MM-DD. */
export function lookupBriefSpeech(date: string, vaultPath = process.env.OBSIDIAN_VAULT_PATH): BriefSpeechLookup {
    if (!vaultPath) return { found: "no_vault" };
    const brief = readBrief(vaultPath, date);
    if (brief) return { found: "speech", speech: briefSpeech(brief) };
    return briefDates(vaultPath).includes(date) ? { found: "unreadable", date } : { found: "no_brief", date };
}

/** "Thursday, October 15" for a YYYY-MM-DD day. */
const spokenDay = (date: string) =>
    new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });

/** The reply to "read the brief": today's (Central) brief, spoken. */
export function readTodaysBrief(now: Date, vaultPath = process.env.OBSIDIAN_VAULT_PATH): CommandReply {
    const today = centralDay(now);
    const lookup = lookupBriefSpeech(today, vaultPath);
    switch (lookup.found) {
        case "no_vault":
            return { kind: "unavailable", say: "I can't read the brief: the vault isn't configured on this service." };
        case "unreadable":
            return { kind: "unavailable", say: "I can't read the brief: today's brief file couldn't be read." };
        case "no_brief": {
            const latest = briefDates(vaultPath!).find((d) => d < today);
            const since = latest ? ` The latest is from ${spokenDay(latest)}.` : "";
            return { kind: "answer", say: `There's no brief for today yet.${since}` };
        }
        case "speech": {
            const { speech } = lookup;
            if (speech.source === "none") {
                return { kind: "answer", say: "Today's brief has nothing to read aloud: it has no Say section or Top 3." };
            }
            return {
                kind: "answer",
                say: speech.text,
                ...(speech.source === "top3" ? { display: "Read from the brief's Top 3: its Say section is missing or empty." } : {}),
            };
        }
    }
}
