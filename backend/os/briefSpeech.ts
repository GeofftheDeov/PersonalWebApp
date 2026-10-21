import type { Command, CommandReply } from "./ask.js";
import { centralDay } from "./format.js";
import { briefSpeech, listBriefs, readBrief, type BriefSpeech } from "../utils/briefs.js";

/**
 * The brief, read aloud (spec #135 W3, #152).
 *
 *   GET /admin/os/api/brief/say?date=YYYY-MM-DD   (routes/osRoutes.ts)
 *   "read the brief"                              (tier 1, intent `brief.read`)
 *
 * Both read the vault checkout at OBSIDIAN_VAULT_PATH on every call, like the
 * brief tile. The text is the brief's `## Say` section, or its Top 3 as plain
 * text when it has none (utils/briefs.ts `briefSpeech`). #153 polls the
 * endpoint after a confirmed morning-brief run succeeds, then speaks `text`.
 */

export const READ_BRIEF_INTENT = "brief.read";

export type BriefSpeechLookup =
    | { found: "speech"; speech: BriefSpeech }
    /** No brief file for that day (or it couldn't be read). */
    | { found: "no_brief"; date: string }
    /** OBSIDIAN_VAULT_PATH is unset on this service. */
    | { found: "no_vault" };

/** The speech for one day's brief. `date` must already be YYYY-MM-DD. */
export function lookupBriefSpeech(date: string, vaultPath = process.env.OBSIDIAN_VAULT_PATH): BriefSpeechLookup {
    if (!vaultPath) return { found: "no_vault" };
    const brief = readBrief(vaultPath, date);
    return brief ? { found: "speech", speech: briefSpeech(brief) } : { found: "no_brief", date };
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
        case "no_brief": {
            const [latest] = listBriefs(vaultPath!, 1);
            const since = latest && latest.date < today ? ` The latest is from ${spokenDay(latest.date)}.` : "";
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
                ...(speech.source === "top3" ? { display: "From the brief's Top 3: it has no Say section." } : {}),
            };
        }
    }
}

// "read the brief", "please read me today's brief", "read my morning brief aloud", "can you read out the briefing".
const POLITE = "(?:please )?(?:(?:can|could|would|will) you )?";

export const readBriefCommands: Command[] = [{
    pattern: new RegExp(`^${POLITE}read (?:me )?(?:out )?(?:the |my )?(?:todays )?(?:morning )?brief(?:ing)?(?: (?:aloud|out loud|out|to me))?(?: please)?$`),
    intent: READ_BRIEF_INTENT,
    handler: ({ now }) => readTodaysBrief(now),
}];
