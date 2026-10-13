import { ok, type TileSource } from "../overview.js";
import { esc, money, TIME_ZONE } from "../format.js";
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
 * Later: the per-run sparkline from `points` (#145) and today's tier-2 spend
 * against its daily cap (#156).
 */

/** The window: this many Central calendar days, today included. */
export const USAGE_WINDOW_DAYS = 7;
/** At most this many per-run points (the newest) for the sparkline. */
export const USAGE_MAX_POINTS = 30;
/** The migration that adds the usage columns to agent_runs (#137). */
export const USAGE_MIGRATION = "db/migrations/2026-10-12-agent-run-usage.sql";
const USAGE_COLUMNS = ["cost_usd", "input_tokens", "output_tokens", "duration_ms", "trigger"];

export type UsageTileData = UsageSummary;

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
        return ok(await summariseUsage(db, { now, days: USAGE_WINDOW_DAYS, maxPoints: USAGE_MAX_POINTS }));
    },

    explain(err: any) {
        // 42703 undefined_column on a usage column: #137's migration hasn't been applied here.
        const column = String(err?.message ?? "").match(/column "?(?:\w+\.)?(\w+)"? does not exist/)?.[1];
        if (err?.code === "42703" && column && USAGE_COLUMNS.includes(column)) {
            return `usage column missing (${column}): apply ${USAGE_MIGRATION}`;
        }
        return undefined;
    },

    render(t) {
        const window = `${shortDay(new Date(t.from))} – ${shortDay(new Date(new Date(t.to).getTime() - 1))} CT`;
        const without = t.runsWithoutUsage
            ? `<div class="stat-meta"><span class="warn">${esc(plural(t.runsWithoutUsage, "run"))} without usage</span>, not in the totals</div>`
            : "";
        if (t.costUsd === null) {
            return `
            <div class="stat-label">API-equivalent cost · last ${USAGE_WINDOW_DAYS} days</div>
            <div class="stat-delta">no runs with usage in the last ${USAGE_WINDOW_DAYS} days</div>
            ${without}
            <div class="stat-meta">${esc(window)}</div>`;
        }
        return `
            <div class="stat-label">API-equivalent cost · last ${USAGE_WINDOW_DAYS} days</div>
            <div class="stat-value">${esc(cost(t.costUsd))}</div>
            <div class="stat-delta">${esc(tokens(t.inputTokens))} input · ${esc(tokens(t.outputTokens))} output tokens · ${esc(plural(t.runsWithUsage, "run"))}</div>
            ${without}
            <div class="stat-meta">${esc(window)} · not a bill: subscription runs aren't billed</div>`;
    },
};
