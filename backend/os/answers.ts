import type { AskContext, Command, CommandReply } from "./ask.js";
import type { Ok } from "./overview.js";
import { centralDay, centralTime, money, signedMoney, signedPct } from "./format.js";
import { budgetMoney } from "./budget.js";
import { plural, sentence, speakAgo, speakChange, speakDate, speakList, speakMoney, speakPercent, speakTime } from "./speech.js";
import { alpacaTile, type AlpacaTileData } from "./tiles/alpaca.js";
import { tasksTile, type DueTask, type TaskBucket, type TasksTileData } from "./tiles/tasks.js";
import { BRIEF_SKILL, briefTile, type BriefTileData } from "./tiles/brief.js";
import { usageTile, USAGE_WINDOW_DAYS, type UsageTileData } from "./tiles/usage.js";

/**
 * Tier-1 answers (#147 of spec #135): the common questions, answered from the
 * overview with no model. Each handler reads one tile from `ctx.overview()`
 * (built once per ask, shared with any other reader) and never queries the
 * database itself.
 *
 *   alpaca.pnl          "what's my P&L", "how's my portfolio doing", "am I up today"
 *   tasks.due_today     "what's due today", "what's due", "what's on my plate", "my tasks"
 *   tasks.due_tomorrow  "what's due tomorrow", "what's on my list for tomorrow"
 *   tasks.overdue       "what's overdue", "anything overdue", "overdue tasks"
 *   runner.status       "is the runner online", "is my PC up", "runner status"
 *   brief.next          "when's the next brief", "when does the morning brief run"
 *   usage.week          "how much have I spent this week", "what's my Claude usage"
 *
 * `say` is written for speech (os/speech.ts): "up 412 dollars, 0.4 percent",
 * "6:45 tomorrow morning". `display` carries the exact figures for the screen.
 * When the tile an answer needs is unavailable the reply is kind
 * `unavailable` and says why, in the tile's own reason. It never guesses.
 *
 * Patterns are anchored and start with a question ("what", "how", "is",
 * "when", "any", "am I"), never a navigation verb ("open", "show", "go to")
 * or "run"/"read", so they can't shadow navigation, run proposals or "read
 * the brief", and those can't shadow them (os/commands.ts lists them after
 * "read the brief", before navigation).
 */

/** "please", "can you", "tell me": an optional lead-in to any question. */
const ASK = "(?:please )?(?:(?:can|could|would|will) you )?(?:(?:tell|remind) me )?";
const PLEASE = "(?: please)?";
const any = (alts: readonly string[]) => `(?:${alts.join("|")})`;
const re = (body: string) => new RegExp(`^${ASK}${body}${PLEASE}$`);

/** Who's reading which tile, and what to call it when it's missing. */
const TILE_NAMES: Record<string, string> = {
    [alpacaTile.id]: "Alpaca", [tasksTile.id]: "tasks", [briefTile.id]: "brief and runner", [usageTile.id]: "usage",
};

/**
 * One tile from the overview, or the reply that says it's unavailable and why.
 * `what` completes "I can't tell you … right now".
 */
async function readTile<T extends object>(ctx: AskContext, id: string, what: string): Promise<Ok<T> | CommandReply> {
    const tile = (await ctx.overview()).tiles[id];
    const name = TILE_NAMES[id] ?? id;
    if (tile?.status === "ok") return tile as Ok<T>;
    const reason = tile?.status === "unavailable" ? tile.reason : "the overview has no such tile";
    return {
        kind: "unavailable",
        say: `I can't tell you ${what} right now. The ${name} tile is unavailable: ${sentence(reason)}`,
        display: `${name} tile unavailable: ${reason}`,
    };
}
const isReply = (v: object): v is CommandReply => "kind" in v && "say" in v && !("status" in v);

// ── alpaca.pnl ──────────────────────────────────────────────────────────────

async function answerPnl(ctx: AskContext): Promise<CommandReply> {
    const t = await readTile<AlpacaTileData>(ctx, alpacaTile.id, "your P and L");
    if (isReply(t)) return t;
    const asOf = new Date(t.asOf);
    const today = centralDay(asOf) === centralDay(ctx.now);
    const change = speakChange(t.dayPl);
    const pct = change !== "flat" && t.dayPlPct !== null ? `, ${speakPercent(t.dayPlPct)}` : "";
    const day = today
        ? (change === "flat" ? "You're flat today." : `Today you're ${change}${pct}.`)
        : (change === "flat" ? `On ${speakDate(asOf)} you were flat.` : `On ${speakDate(asOf)} you were ${change}${pct}.`);
    const stale = t.stale
        ? ` That's from the latest snapshot, ${speakAgo(t.ageMs)}: new snapshots have stopped coming in.`
        : "";
    return {
        kind: "answer",
        say: `Your equity is ${speakMoney(t.equity)}. ${day}${stale}`,
        display: `Equity ${money(t.equity)} · day P&L ${signedMoney(t.dayPl)} (${signedPct(t.dayPlPct)}) · as of ${centralTime(asOf, ctx.now)}`
            + (t.stale ? " · stale" : ""),
    };
}

// ── tasks.* ─────────────────────────────────────────────────────────────────

/** A title as said aloud: whitespace collapsed, never empty. */
const spokenTitle = (task: DueTask) => task.title?.replace(/\s+/g, " ").trim() || "an untitled task";

/**
 * "2 tasks are due today: A and B.", "5 tasks are due tomorrow: A and 4 more."
 * The tile lists at most TASKS_MAX_SHOWN, overdue first, so a later bucket
 * may have none listed: then it's just the count.
 */
const bucketSentence = (t: TasksTileData, bucket: TaskBucket, tail: string) => {
    const n = t.counts[bucket];
    const titles = t.tasks.filter((task) => task.bucket === bucket).map(spokenTitle);
    const rest = n - titles.length;
    const list = titles.length ? `: ${speakList(rest > 0 ? [...titles, `${rest} more`] : titles)}` : "";
    return `${plural(n, "task")} ${n === 1 ? "is" : "are"} ${tail}${list}.`;
};

/** A sync that's old or never happened makes the answer uncertain; say so. */
const syncNote = (t: TasksTileData) => t.lastSync === null
    ? " Tasks have never synced from Notion, so this may be incomplete."
    : t.stale ? ` The last Notion sync was ${speakAgo(t.syncAgeMs ?? 0)}, so this may be out of date.` : "";

const tasksDisplay = (t: TasksTileData, now: Date) =>
    `${t.counts.overdue} overdue · ${t.counts.today} today · ${t.counts.tomorrow} tomorrow · `
    + (t.lastSync ? `synced ${centralTime(new Date(t.lastSync), now)}` : "never synced");

function tasksAnswer(focus: "today" | "tomorrow" | "overdue") {
    return async (ctx: AskContext): Promise<CommandReply> => {
        const t = await readTile<TasksTileData>(ctx, tasksTile.id, focus === "overdue" ? "what's overdue" : `what's due ${focus}`);
        if (isReply(t)) return t;
        const c = t.counts;
        let say: string;
        if (focus === "today") {
            const due = c.today ? bucketSentence(t, "today", "due today") : "Nothing's due today.";
            const late = c.overdue ? ` ${bucketSentence(t, "overdue", "overdue")}`
                : c.today ? "" : " Nothing's overdue either.";
            say = due + late;
        } else if (focus === "tomorrow") {
            say = c.tomorrow ? bucketSentence(t, "tomorrow", "due tomorrow") : "Nothing's due tomorrow.";
        } else {
            say = c.overdue ? bucketSentence(t, "overdue", "overdue") : "Nothing's overdue.";
        }
        return { kind: "answer", say: say + syncNote(t), display: tasksDisplay(t, ctx.now) };
    };
}

// ── runner.status ───────────────────────────────────────────────────────────

/** "Morning brief" → "the morning brief". */
const theSkill = (label: string) => `the ${label.charAt(0).toLowerCase()}${label.slice(1)}`;

async function answerRunner(ctx: AskContext): Promise<CommandReply> {
    const t = await readTile<BriefTileData>(ctx, briefTile.id, "whether the runner is online");
    if (isReply(t)) return t;
    const r = t.runner;
    let say: string;
    if (r.online) {
        say = `Yes, the runner is online${r.name ? ` on ${r.name}` : ""}. It last checked in ${speakAgo(r.ageMs ?? 0)}.`;
    } else if (r.lastSeen) {
        say = `No, the runner is offline. It was last seen ${speakAgo(r.ageMs ?? 0)}, at ${speakTime(new Date(r.lastSeen), ctx.now)}.`;
    } else {
        say = "No, the runner hasn't checked in since the server started.";
    }
    const a = t.activeRun;
    if (t.runsNote) {
        say += " The run history is unavailable, so I can't tell whether anything is queued.";
    } else if (a?.status === "running" && !r.online) {
        say += ` It had claimed ${theSkill(a.label)} before it went quiet, so that run may have stalled.`;
    } else if (a?.status === "running") {
        say += ` It's running ${theSkill(a.label)}${t.activeCount > 1 ? `, with ${plural(t.activeCount - 1, "more run")} waiting` : ""}.`;
    } else if (a) {
        say += ` ${t.activeCount === 1 ? "One run is" : `${plural(t.activeCount, "run")} are`} queued${
            r.online ? "" : ", and won't start until the runner is back"}.`;
    }
    const display = (r.online ? `Runner online` : `Runner offline`)
        + (r.name ? ` · ${r.name}` : "")
        + (r.lastSeen ? ` · last poll ${centralTime(new Date(r.lastSeen), ctx.now)}` : " · not seen since the server started")
        + (t.runsNote ? ` · ${t.runsNote}` : "");
    return { kind: "answer", say, display };
}

// ── brief.next ──────────────────────────────────────────────────────────────

async function answerNextBrief(ctx: AskContext): Promise<CommandReply> {
    const t = await readTile<BriefTileData>(ctx, briefTile.id, "when the next brief is");
    if (isReply(t)) return t;
    if (!t.nextRun) {
        return { kind: "answer", say: "The morning brief has no schedule, so it only runs when you ask for it.", display: "No schedule: on demand only" };
    }
    const next = new Date(t.nextRun);
    let say = `The next brief is at ${speakTime(next, ctx.now)}.`;
    if (t.missingToday && t.dueToday) {
        say += ` Today's hasn't arrived yet; it was due at ${speakTime(new Date(t.dueToday), ctx.now)}.`;
    }
    const a = t.activeRun;
    if (a?.skill === BRIEF_SKILL) say += a.status === "running" ? " One is running now." : " One is queued now.";
    return { kind: "answer", say, display: `Next brief ${centralTime(next, ctx.now)}` };
}

// ── usage.week ──────────────────────────────────────────────────────────────

async function answerUsage(ctx: AskContext): Promise<CommandReply> {
    const t = await readTile<UsageTileData>(ctx, usageTile.id, "what you've spent");
    if (isReply(t)) return t;
    const window = `the last ${USAGE_WINDOW_DAYS} days`;
    const w = t.runsWithoutUsage;
    let say: string;
    if (t.costUsd === null) {
        say = `No runs recorded usage in ${window}.`
            + (w ? ` ${plural(w, "run")} finished without recording any.` : "");
    } else {
        say = `In ${window} your runs came to ${speakMoney(t.costUsd)}, API-equivalent, over ${plural(t.runsWithUsage, "run")}.`
            + (w ? ` ${plural(w, "other run")} didn't record usage, so ${w === 1 ? "it isn't" : "they aren't"} counted.` : "");
    }
    const b = t.tier2;
    if (b && b.spentUsd === null) say += " Today's spend on open questions can't be read.";
    else if (b && b.spentUsd > 0) say += ` Open questions have cost ${speakMoney(b.spentUsd)} today, of the ${speakMoney(b.capUsd)} daily cap.`;

    const display = (t.costUsd === null ? "No usage recorded" : `${money(t.costUsd)} API-equivalent`)
        + ` · ${t.runsWithUsage} with usage · ${w} without · last ${USAGE_WINDOW_DAYS} days`
        + (b && b.spentUsd !== null ? ` · open questions today ${budgetMoney(b.spentUsd)} of ${budgetMoney(b.capUsd)}` : "");
    return { kind: "answer", say, display };
}

// ── the patterns ────────────────────────────────────────────────────────────

const PNL_TERMS = any(["p l", "pnl", "p and l", "profit and loss", "profit", "profit or loss"]);
/** Always "my"/"our": "how are stocks doing" is about the market, not the wallet. */
const HOLDINGS = `(?:my |our )${any(["equity", "portfolio", "account", "paper wallet", "wallet", "alpaca account",
    "trading account", "trading", "stocks", "positions", "investments"])}`;
const WHAT = any(["whats", "what is", "hows", "how is", "how are", "how much is"]);
const MY = "(?:my |the |our )?";
const NOW = "(?: today| so far| so far today| right now| now)?";

/** Openers for "… due" / "… overdue": "what's", "anything", "do I have any tasks". */
const DUE_Q = any(["whats", "what is", "whats still", "what else is", "what do i have", "what have i got",
    "what tasks do i have", "what tasks are", "which tasks are", "anything", "is anything", "is there anything",
    "any tasks", "are any tasks", "are there any tasks", "do i have anything", "do i have any tasks"]);
const LIST = any(["plate", "list", "to do list", "todo list", "task list", "agenda"]);
const TODAY = "(?: (?:for )?today)?";
const TOMORROW = " (?:for )?tomorrow";

const RUNNER = `(?:the |my )?${any(["runner", "pc", "computer", "agent runner"])}`;

const BRIEF = `(?:the |my )?(?:next )?(?:morning )?(?:brief|briefing)`;

const SPEND = any([
    "how much (?:have|did) (?:i|we) (?:spent|spend)",
    "how much (?:has|did) (?:claude|the os) cost(?: me| us)?",
    "how much am i spending",
    "what (?:have|did) (?:i|we) (?:spent|spend)",
    `(?:whats|what is) (?:my |our )(?:claude )?(?:spend|spending|usage|cost|costs|bill)`,
    `(?:whats|what is) (?:the )?claude (?:spend|spending|usage|cost|costs|bill)`,
]);
const WEEK = "(?: (?:this|the past|the last|in the last|over the last) (?:week|7 days|seven days)| so far)?";

/** The tier-1 answer commands, in match order (os/commands.ts places them). */
export const ANSWER_COMMANDS: readonly Command[] = [
    {
        intent: "alpaca.pnl",
        pattern: new RegExp([
            `^${ASK}(?:${WHAT} )?${MY}(?:todays |day |daily )?${PNL_TERMS}${NOW}${PLEASE}$`,
            `^${ASK}${WHAT} ${HOLDINGS}(?: doing| looking| worth| at)?${NOW}${PLEASE}$`,
            `^${ASK}(?:am i|are we|how much am i|how much are we) (?:up|down|up or down)${NOW}${PLEASE}$`,
        ].join("|")),
        handler: answerPnl,
    },
    {
        intent: "tasks.due_tomorrow",
        pattern: new RegExp([
            re(`${DUE_Q} due${TOMORROW}`).source,
            re(`(?:whats|what is) on ${MY}${LIST}${TOMORROW}`).source,
            re(`(?:what are )?(?:my )?tasks${TOMORROW}`).source,
            re(`what do i (?:have|need) to do${TOMORROW}`).source,
        ].join("|")),
        handler: tasksAnswer("tomorrow"),
    },
    {
        intent: "tasks.overdue",
        pattern: new RegExp([
            re(`${DUE_Q} overdue`).source,
            re(`(?:what are )?(?:my |the )?overdue tasks`).source,
            re(`what am i behind on`).source,
        ].join("|")),
        handler: tasksAnswer("overdue"),
    },
    {
        intent: "tasks.due_today",
        pattern: new RegExp([
            re(`${DUE_Q} due${TODAY}`).source,
            re(`(?:whats|what is) on ${MY}${LIST}${TODAY}`).source,
            re(`(?:what are )?(?:my |todays )?tasks${TODAY}`).source,
            re(`(?:what do i (?:have|need) to do|what have i got to do|what needs doing)${TODAY}`).source,
        ].join("|")),
        handler: tasksAnswer("today"),
    },
    {
        intent: "runner.status",
        pattern: new RegExp([
            re(`(?:is|are) ${RUNNER} ${any(["online", "offline", "up", "down", "alive", "running", "working", "connected", "on"])}(?: right now| now)?`).source,
            re(`(?:whats|what is) ${MY}runner(?:s)? (?:status|doing)`).source,
            re(`(?:hows|how is) ${MY}runner(?: doing)?`).source,
            re(`runner status`).source,
        ].join("|")),
        handler: answerRunner,
    },
    {
        intent: "brief.next",
        pattern: new RegExp([
            re(`${any(["whens", "when is", "what time is"])} ${BRIEF}(?: due)?`).source,
            re(`${any(["when does", "when will", "what time does", "what time will"])} ${BRIEF} ${any(["run", "come", "come out", "arrive", "be ready", "go out"])}(?: next)?`).source,
        ].join("|")),
        handler: answerNextBrief,
    },
    {
        intent: "usage.week",
        pattern: re(`${SPEND}(?: on claude)?${WEEK}(?: on claude)?`),
        handler: answerUsage,
    },
];
