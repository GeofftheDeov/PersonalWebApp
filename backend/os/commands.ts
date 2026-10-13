import type { Command } from "./ask.js";

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

/** The tier-1 command table, in match order. */
export const COMMANDS: readonly Command[] = [
    ...navigation,
];
