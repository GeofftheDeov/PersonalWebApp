import { describeError, ok, unavailable, type Queryable, type TileSource } from "../overview.js";
import { esc, money, TIME_ZONE } from "../format.js";
import { budgetMoney, dailyBudgetFromEnv, tier2SpendToday } from "../budget.js";
import { summariseUsage, type UsageSummary } from "../../services/agentRuns.js";

/**
 * The Claude usage tile (#144): what the OS's skill runs consumed over the
 * last week, from agent_runs.
 *
 * The cost is the API-equivalent Claude Code reports, not a bill: subscription
 * runs aren't billed, and the cost is a consistent yardstick. Runs that
 * reported no usage are counted on their own line, never added in as $0, and a
 * window with no usage says so instead of showing $0.00.
 *
 * It also shows today's tier-2 spend against its daily cap (#156, the only
 * metered API spend, from os_asks via os/budget.ts). Without the os_asks table
 * (its migration not applied) only that line goes; the tile stays ok.
 *
 * Later: the per-run sparkline from `points` (#145).
 */

/** The window: this many Central calendar days, today included. */
export const USAGE_WINDOW_DAYS = 7;
/** At most this many per-run points (the newest) for the sparkline. */
export const USAGE_MAX_POINTS = 30;
/** The migration that adds the usage columns to agent_runs (#137). */
export const USAGE_MIGRATION = "db/migrations/2026-10-12-agent-run-usage.sql";
const USAGE_COLUMNS = ["cost_usd", "input_tokens", "output_tokens", "duration_ms", "trigger"];

/**
 * Today's (Central) tier-2 spend and the daily cap it's held to, both USD.
 * spentUsd is null when the spend couldn't be read (a timeout, a cost that
 * isn't a number), with the reason; the gate keeps tier 2 shut then too.
 */
export type Tier2Budget =
    | { spentUsd: number; capUsd: number }
    | { spentUsd: null; capUsd: number; reason: string };

export type UsageTileData = UsageSummary & {
    /** null when os_asks or a column of it is missing (its migration isn't applied): the line is dropped. */
    tier2: Tier2Budget | null;
};

/** Today's tier-2 budget. Never throws, so tier 2 can't take the run usage down with it. */
async function tier2Budget(db: Queryable, now: Date): Promise<Tier2Budget | null> {
    const capUsd = dailyBudgetFromEnv();
    try {
        return { spentUsd: await tier2SpendToday(db, now), capUsd };
    } catch (err: any) {
        if (err?.code === "42P01" || err?.code === "42703") return null;
        console.error("[os] tile usage: today's tier-2 spend failed:", err?.message ?? err);
        return { spentUsd: null, capUsd, reason: describeError(err) };
    }
}

/** 1,284 / 12.9K / 4.2M */
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const tokens = (v: number | null) => (v === null ? "—" : compact.format(v));
/** A cost that rounds to $0.00 but isn't zero shows as "<$0.01": cheap is not empty. */
const cost = (v: number) => (v > 0 && v < 0.005 ? "<$0.01" : money(v));
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const shortDay = (d: Date) => d.toLocaleDateString("en-US", { timeZone: TIME_ZONE, month: "short", day: "numeric" });

export const usageTile: TileSource<UsageTileData> = {
    id: "usage",
    title: "Claude usage",
    href: "/admin/briefs",

    async build({ now, db }) {
        const [summary, tier2] = await Promise.all([
            summariseUsage(db, { now, days: USAGE_WINDOW_DAYS, maxPoints: USAGE_MAX_POINTS }),
            tier2Budget(db, now),
        ]);
        // numeric accepts NaN (and NaN passes CHECK >= 0); completeRun never stores one, but a
        // hand-written row could, and a NaN total would read "$NaN" here and null in the JSON.
        if (summary.costUsd !== null && !Number.isFinite(summary.costUsd)) {
            return unavailable("a run in the window has a cost that isn't a number");
        }
        return ok({ ...summary, tier2 });
    },

    explain(err: any) {
        // 42703 undefined_column on a usage column: #137's migration hasn't been applied here.
        const msg = String(err?.message ?? "");
        if (err?.code === "42703" && USAGE_COLUMNS.some((c) => new RegExp(`\\b${c}\\b`).test(msg))) {
            return `${describeError(err)}: apply ${USAGE_MIGRATION}`;
        }
        return undefined;
    },

    render(t) {
        const window = `${shortDay(new Date(t.from))} – ${shortDay(new Date(new Date(t.to).getTime() - 1))} CT`;
        const withoutLine = (note: string) => t.runsWithoutUsage
            ? `<div class="stat-meta"><span class="warn">${esc(plural(t.runsWithoutUsage, "run"))} without usage</span>${note}</div>`
            : "";
        // Tier 2 is billed per call, unlike the runs above: its spend against the hard daily cap.
        const tier2Line = (() => {
            const b = t.tier2;
            if (!b) return "";
            const cap = `the ${budgetMoney(b.capUsd)} daily cap`;
            if (b.spentUsd === null) {
                return `<div class="stat-meta">Open questions today: <span class="warn">spend unreadable (${esc(b.reason)}), so they're off</span> · ${esc(cap)}</div>`;
            }
            const spent = b.spentUsd > 0 ? `${budgetMoney(b.spentUsd)} spent` : "nothing spent";
            const reached = b.spentUsd >= b.capUsd ? ` · <span class="warn">budget reached</span>` : "";
            return `<div class="stat-meta">Open questions today: ${esc(`${spent} of ${cap}`)}${reached}</div>`;
        })();
        if (t.costUsd === null) {
            const without = withoutLine("");
            return `
            <div class="stat-label">API-equivalent cost · last ${USAGE_WINDOW_DAYS} days</div>
            <div class="stat-delta">no runs with usage in the last ${USAGE_WINDOW_DAYS} days</div>
            ${without}
            ${tier2Line}
            <div class="stat-meta">${esc(window)}</div>`;
        }
        return `
            <div class="stat-label">API-equivalent cost · last ${USAGE_WINDOW_DAYS} days</div>
            <div class="stat-value">${esc(cost(t.costUsd))}</div>
            <div class="stat-delta">${esc(tokens(t.inputTokens))} input · ${esc(tokens(t.outputTokens))} output tokens · ${esc(plural(t.runsWithUsage, "run"))}</div>
            ${withoutLine(", not in the totals")}
            ${tier2Line}
            <div class="stat-meta">${esc(window)} · not a bill: subscription runs aren't billed</div>`;
    },
};
