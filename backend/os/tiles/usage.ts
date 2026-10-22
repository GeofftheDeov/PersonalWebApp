import { describeError, ok, unavailable, type Queryable, type TileSource } from "../overview.js";
import { centralTime, esc, money, TIME_ZONE } from "../format.js";
import { budgetMoney, dailyBudgetFromEnv, tier2SpendToday } from "../budget.js";
import { summariseUsage, type UsagePoint, type UsageSummary } from "../../services/agentRuns.js";

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
 * Under the totals, a per-run cost sparkline (#145) plots `points`: one mark
 * per run with usage, so a ballooning run explains itself. Runs without usage
 * aren't plotted at all (never as $0); they're only in the "without usage" count.
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

/**
 * The sparkline's drawing box, in viewBox units. The SVG scales to the tile's
 * width (CSS .spark in os/page.ts), so these set its proportions, not its size.
 */
const SPARK_W = 320;
const SPARK_H = 64;
/** Room for the end marker and its ring: dots never clip at the edges. */
const SPARK_PAD = 6;

/** One point's tooltip: when (Central), what, why, how much. Plain text; escaped by the caller. */
function pointTitle(p: UsagePoint, now: Date): string {
    const parts = [
        centralTime(new Date(p.finishedAt), now), p.skill, p.trigger, cost(p.costUsd),
        `${tokens(p.inputTokens)} in / ${tokens(p.outputTokens)} out tokens`,
    ];
    if (!p.ok) parts.push("failed");
    return parts.join(" · ");
}

/**
 * The per-run cost sparkline (#145): inline SVG built here, no chart library.
 * One series, so no legend: the caption names it. Runs are evenly spaced,
 * oldest to newest; cost rises from a $0 baseline to the window's peak. Every
 * point carries a <title> (the hover tooltip) inside a full-height hit band,
 * since a 4px dot is too small to aim at; the newest run is the accent dot,
 * and a failed run is a hollow one (shape, not colour). The table under it
 * holds the same values for anyone who can't hover.
 */
function sparkline(all: UsagePoint[], now: Date): string {
    // summariseUsage already caps and filters these; the plot holds to the same rules on its own.
    const points = all.filter((p) => Number.isFinite(p.costUsd)).slice(-USAGE_MAX_POINTS);
    if (points.length === 0) return "";
    const n = points.length;
    const peak = points.reduce((best, p) => (p.costUsd > best.costUsd ? p : best), points[0]);
    const scale = peak.costUsd > 0 ? peak.costUsd : 1; // all $0: a flat line on the baseline
    const top = SPARK_PAD, base = SPARK_H - SPARK_PAD;
    const step = n > 1 ? (SPARK_W - 2 * SPARK_PAD) / (n - 1) : SPARK_W;
    const at = (i: number, p: UsagePoint) => ({
        x: n > 1 ? SPARK_PAD + i * step : SPARK_W / 2,
        y: base - (p.costUsd / scale) * (base - top),
    });
    const f = (v: number) => v.toFixed(1);
    const xy = points.map((p, i) => at(i, p));
    const latest = points[n - 1];

    const line = n > 1
        ? `<polyline class="spark-line" points="${xy.map((c) => `${f(c.x)},${f(c.y)}`).join(" ")}"/>`
        : "";
    const marks = points.map((p, i) => {
        const { x, y } = xy[i];
        const last = i === n - 1;
        // The hit band runs halfway to each neighbour, the full height of the plot.
        const x0 = Math.max(0, x - step / 2), x1 = Math.min(SPARK_W, x + step / 2);
        const cls = `spark-pt${last ? " spark-last" : ""}${p.ok ? "" : " spark-failed"}`;
        return `<g class="${cls}" data-run="${esc(p.id)}"><title>${esc(pointTitle(p, now))}</title>`
            + `<rect class="spark-hit" x="${f(x0)}" y="0" width="${f(x1 - x0)}" height="${SPARK_H}"/>`
            + `<circle class="spark-dot" cx="${f(x)}" cy="${f(y)}" r="${last ? 4 : 2.5}"/></g>`;
    }).join("");
    const label = `Cost per run for the last ${plural(n, "run")} with usage, oldest to newest: `
        + `peak ${cost(peak.costUsd)} (${peak.skill}), latest ${cost(latest.costUsd)} (${latest.skill}).`;
    const svg = `<svg class="spark" viewBox="0 0 ${SPARK_W} ${SPARK_H}" role="img" aria-label="${esc(label)}" focusable="false">`
        + `<line class="spark-base" x1="0" y1="${base}" x2="${SPARK_W}" y2="${base}"/>${line}${marks}</svg>`;

    const peakAt = shortDay(new Date(peak.finishedAt));
    const caption = `Cost per run, ${n === 1 ? "1 run" : `last ${n} runs`} with usage · peak ${cost(peak.costUsd)} (${peak.skill}, ${peakAt})`;
    const rows = points.slice().reverse().map((p) => `
                    <tr${p.ok ? "" : ` class="warn"`}><td>${esc(centralTime(new Date(p.finishedAt), now))}</td><td>${esc(p.skill)}</td>`
        + `<td>${esc(p.trigger)}${p.ok ? "" : " (failed)"}</td><td class="num">${esc(cost(p.costUsd))}</td>`
        + `<td class="num">${esc(tokens(p.inputTokens))} / ${esc(tokens(p.outputTokens))}</td></tr>`).join("");
    return `
            <div class="spark-wrap">
                ${svg}
                <div class="stat-meta spark-cap">${esc(caption)}</div>
                <details class="spark-runs">
                    <summary>Runs as a table</summary>
                    <div class="spark-scroll"><table>
                    <thead><tr><th>Finished</th><th>Skill</th><th>Trigger</th><th class="num">Cost</th><th class="num">Tokens in / out</th></tr></thead>
                    <tbody>${rows}</tbody>
                    </table></div>
                </details>
            </div>`;
}

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

    render(t, view) {
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
            ${sparkline(t.points, view.now)}
            ${withoutLine(", not in the totals")}
            ${tier2Line}
            <div class="stat-meta">${esc(window)} · not a bill: subscription runs aren't billed</div>`;
    },
};
