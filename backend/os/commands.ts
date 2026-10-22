import { normaliseAsk, type Command } from "./ask.js";
import { proposalSay } from "./proposals.js";
import { READ_BRIEF_INTENT, readTodaysBrief } from "./briefSpeech.js";
import { ANSWER_COMMANDS } from "./answers.js";
import { SKILLS, type SkillId } from "../services/agentRuns.js";

/**
 * Tier 1 of the ask router (spec #135 W3): the command table, kept as data.
 *
 * Order matters: the first command whose pattern matches the normalised ask
 * answers (see os/ask.ts). Patterns are anchored so a longer question that
 * merely mentions a page falls through to the next tier instead of
 * navigating.
 *
 * Adding an intent (#147 answers, #148 "run <skill>", #152 "read the brief"):
 * append a Command { pattern, intent, handler } to COMMANDS, or build a group
 * of them from data the way the navigation commands are built from
 * ADMIN_PAGES. Put a more specific pattern before a more general one.
 */

/**
 * The admin pages an ask may navigate to: the admin nav's own pages, minus
 * the public site. `names` are what the admin might call a page, already
 * normalised (lowercase, no punctuation). Tier 2's `page` enum (#154) is the
 * ids here.
 */
export const ADMIN_PAGES = [
    { id: "os", path: "/admin/os", label: "the overview", names: ["os", "overview", "home", "home screen", "agentic os"] },
    { id: "dashboard", path: "/admin", label: "the dashboard", names: ["dashboard", "admin", "admin dashboard"] },
    { id: "shop", path: "/db", label: "the shop", names: ["shop", "database", "db", "tables"] },
    { id: "cloud-claw", path: "/admin/cloud-claw", label: "Cloud-Claw", names: ["cloud claw", "cloudclaw", "claw"] },
    { id: "obsidian", path: "/admin/obsidian", label: "the vault", names: ["vault", "obsidian", "wiki", "notes"] },
    { id: "briefs", path: "/admin/briefs", label: "the briefs", names: ["briefs", "brief", "morning briefs", "morning brief"] },
    { id: "alpaca", path: "/admin/alpaca", label: "Alpaca", names: ["alpaca", "trading", "wallet", "wallets", "paper wallet", "portfolio"] },
    { id: "paperclip", path: "/admin/paperclip", label: "Paperclip", names: ["paperclip"] },
    { id: "person-sync", path: "/admin/person-sync", label: "person sync", names: ["person sync", "salesforce sync"] },
    { id: "profile", path: "/admin/profile", label: "your profile", names: ["profile"] },
] as const;
export type AdminPageId = typeof ADMIN_PAGES[number]["id"];

/** True for exactly the allowlisted admin paths. Every `navigate` reply is checked against it. */
export const isAllowedPage = (url: unknown): boolean => ADMIN_PAGES.some((p) => p.path === url);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// "please", "can you", a verb, an optional "the"/"my", the page, an optional "page"/"tab".
const POLITE = "(?:please )?(?:(?:can|could|would|will) you )?";
const GO = "(?:open|show me|show|go to|go|take me to|bring up|pull up|navigate to|switch to|head to|jump to)(?: up)?";
const TAIL = "(?: page| tab| screen)?(?: please)?";

const navigation: Command[] = ADMIN_PAGES.map((page) => ({
    pattern: new RegExp(`^${POLITE}${GO} (?:the |my )?(?:${page.names.map(escapeRe).join("|")})${TAIL}$`),
    intent: `navigate.${page.id}`,
    handler: () => ({ kind: "navigate", say: `Opening ${page.label}.`, url: page.path }),
}));

/**
 * "run <label>" for every runnable skill, the labels lowercased ("run my
 * morning brief", "please run the weekly review"), plus the extra names in
 * RUN_ALIASES. Each always proposes the run (tier 3); nothing is queued until
 * the admin confirms.
 */
const RUN_ALIASES: Partial<Record<SkillId, string[]>> = { "morning-brief": ["brief"] };

const runs: Command[] = SKILLS.map((skill) => {
    const names = [normaliseAsk(skill.label), ...(RUN_ALIASES[skill.id] ?? [])];
    return {
        pattern: new RegExp(`^${POLITE}run (?:the |my )?(?:${names.map(escapeRe).join("|")})(?: now)?(?: please)?$`),
        intent: `run.${skill.id}`,
        handler: () => ({ kind: "confirm_run", say: proposalSay(skill.id), skill: skill.id }),
    };
});

/**
 * "read the brief" (#152): speaks today's Say block, or the Top 3 when there's
 * none (os/briefSpeech.ts). "please read me today's brief", "read my morning
 * brief aloud", "can you read out the briefing".
 */
const readBrief: Command[] = [{
    pattern: new RegExp(`^${POLITE}read (?:me )?(?:out )?(?:the |my )?(?:todays )?(?:morning )?brief(?:ing)?(?: (?:aloud|out loud|out|to me))?(?: please)?$`),
    intent: READ_BRIEF_INTENT,
    handler: ({ now }) => readTodaysBrief(now),
}];

/**
 * "Yes" or "no" that reaches the router: the page answers these itself while a
 * proposal is pending (#151), so here there's nothing pending.
 */
const nothingPending: Command[] = [
    {
        pattern: /^(?:yes|yeah|yep|yup|confirm|confirmed|do it|go ahead|go for it)(?: please)?$/,
        intent: "confirm.nothing_pending",
        handler: () => ({ kind: "answer", say: "Nothing to confirm." }),
    },
    {
        pattern: /^(?:no|nope|cancel|never mind|nevermind)$/,
        intent: "cancel.nothing_pending",
        handler: () => ({ kind: "answer", say: "Nothing to cancel." }),
    },
];

/**
 * The tier-1 command table, in match order. The answers (#147, os/answers.ts)
 * are questions ("what's my P&L", "is the runner online"), so they sit after
 * the run and read commands and before navigation; none of their patterns
 * starts with "run", "read" or a navigation verb.
 */
export const COMMANDS: readonly Command[] = [
    ...nothingPending,
    ...runs,
    ...readBrief,
    ...ANSWER_COMMANDS,
    ...navigation,
];
