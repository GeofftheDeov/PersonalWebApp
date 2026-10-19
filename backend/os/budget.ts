import type { Queryable } from "./overview.js";
import { centralDay, money, TIME_ZONE } from "./format.js";

/**
 * Tier 2's daily budget (spec #135 W3, #156): the only metered API spend has
 * a hard ceiling.
 *
 * The gate (os/tier2.ts askModel, after the key gate) calls the model only
 * while today's spend is below the cap; the usage tile (os/tiles/usage.ts)
 * shows the same two numbers. "Today" is the Central calendar day of the ask,
 * computed in Postgres so it holds across DST (a 23- or 25-hour day).
 */

/** The cap when OS_ASK_DAILY_BUDGET_USD is unset or malformed. */
export const DEFAULT_DAILY_BUDGET_USD = 0.25;
export const BUDGET_ENV = "OS_ASK_DAILY_BUDGET_USD";

/** The malformed value last warned about, so a bad setting logs once, not on every ask and page load. */
let warnedAbout: string | null = null;

/**
 * The daily cap in USD, read from OS_ASK_DAILY_BUDGET_USD on each call. A
 * plain non-negative decimal sets it; 0 turns tier 2 off. Anything else
 * (unset, empty, negative, not a number) gives the $0.25 default, so a typo
 * can't lift the ceiling.
 */
export function dailyBudgetFromEnv(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env[BUDGET_ENV]?.trim();
    if (!raw) return DEFAULT_DAILY_BUDGET_USD;
    if (/^(\d+(\.\d*)?|\.\d+)$/.test(raw)) {
        const v = Number(raw);
        if (Number.isFinite(v)) return v;
    }
    if (warnedAbout !== raw) {
        warnedAbout = raw;
        console.warn(`[os] ${BUDGET_ENV}=${JSON.stringify(raw.slice(0, 40))} isn't a dollar amount; using $${DEFAULT_DAILY_BUDGET_USD}`);
    }
    return DEFAULT_DAILY_BUDGET_USD;
}

/** A budget amount: to the cent, or to four places under a cent so a small cap doesn't read "$0.00". */
export const budgetMoney = (v: number) => (v > 0 && v < 0.01 ? `$${Number(v.toFixed(4))}` : money(v));

/**
 * Priced calls whose os_asks row couldn't be written, by Central day: the
 * call was made and billed, so it still counts against this process's cap.
 * Only today's entry is kept. Per process: another backend task can't see it.
 */
const unlogged = new Map<string, number>();

/** Holds a priced call's cost after its ask row failed to write (routes/osRoutes.ts). */
export function noteUnloggedSpend(at: Date, usd: number): void {
    if (!(usd > 0) || !Number.isFinite(usd)) return;
    const day = centralDay(at);
    for (const d of unlogged.keys()) if (d !== day) unlogged.delete(d);
    unlogged.set(day, (unlogged.get(day) ?? 0) + usd);
}

/**
 * Today's tier-2 spend in USD: every priced model call logged in os_asks on
 * `now`'s Central day, from any account (the cap is on the API key, not the
 * asker), plus any this process couldn't log. It sums cost_usd whatever tier
 * the row ended at, so a model-made run proposal (#157, logged at tier 3)
 * still counts; only model calls carry a cost. A call that failed before a
 * response came back has no usage and costs nothing here. Throws if os_asks
 * can't be read, or holds a cost that isn't a number; the caller decides.
 */
export async function tier2SpendToday(db: Queryable, now: Date): Promise<number> {
    const { rows: [r] } = await db.query<{ spent: number | null }>(
        `WITH d AS (
           SELECT date_trunc('day', $1::timestamptz AT TIME ZONE $2) AT TIME ZONE $2 AS from_ts,
                  (date_trunc('day', $1::timestamptz AT TIME ZONE $2) + interval '1 day') AT TIME ZONE $2 AS to_ts
         )
         SELECT sum(a.cost_usd)::float8 AS spent
           FROM d JOIN os_asks a ON a.asked_at >= d.from_ts AND a.asked_at < d.to_ts
          WHERE a.cost_usd IS NOT NULL`,
        [now, TIME_ZONE]);
    const spent = Number(r?.spent ?? 0) + (unlogged.get(centralDay(now)) ?? 0);
    // numeric accepts NaN, and CHECK (cost_usd >= 0) lets it through: an unreadable total is a failed read.
    if (!Number.isFinite(spent)) throw new Error("today's tier-2 spend isn't a number");
    return spent;
}
