import { centralDay, TIME_ZONE } from "./format.js";

/**
 * Phrasing for speech (spec #135): what an ask reply's `say` uses for money,
 * percentages, times and counts, so it reads naturally aloud. "up 412 dollars,
 * 0.4 percent", not "+$412.00 (0.40%)"; "6:45 tomorrow morning", not
 * "Oct 12, 6:45 AM CT". Times are Central. os/format.ts is for the screen
 * (and a reply's `display` line); this is for the ear.
 */

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** "1 task" / "3 tasks". */
export const plural = (n: number, one: string, many = `${one}s`) => `${whole.format(n)} ${n === 1 ? one : many}`;

/**
 * An amount of money, unsigned: "412 dollars" (whole dollars from 100 up),
 * "4 dollars and 12 cents", "1 dollar", "35 cents", "less than a cent", "0 dollars".
 */
export function speakMoney(v: number): string {
    const a = Math.abs(v);
    if (a === 0) return "0 dollars";
    if (a < 0.005) return "less than a cent";
    if (a >= 100) return plural(Math.round(a), "dollar");
    const cents = Math.round(a * 100);
    const d = Math.floor(cents / 100), c = cents % 100;
    if (d === 0) return plural(c, "cent");
    return c === 0 ? plural(d, "dollar") : `${plural(d, "dollar")} and ${plural(c, "cent")}`;
}

/** A change in money: "up 412 dollars", "down 4 dollars and 12 cents", "flat" (rounds to zero). */
export function speakChange(v: number): string {
    if (Math.abs(v) < 0.005) return "flat";
    return `${v > 0 ? "up" : "down"} ${speakMoney(v)}`;
}

/** A percentage, unsigned, to one decimal: "0.4 percent", "12 percent", "less than 0.1 percent". */
export function speakPercent(v: number): string {
    const a = Math.abs(v);
    if (a === 0) return "0 percent";
    if (a < 0.05) return "less than 0.1 percent";
    const r = Number(a.toFixed(1));
    return `${r.toLocaleString("en-US", { maximumFractionDigits: 1 })} percent`;
}

/** "just now", "a minute ago", "12 minutes ago", "an hour ago", "3 hours ago", "2 days ago". */
export function speakAgo(ms: number): string {
    if (ms < 60_000) return "just now";
    const min = Math.floor(ms / 60_000);
    if (min < 60) return min === 1 ? "a minute ago" : `${min} minutes ago`;
    const h = Math.floor(min / 60);
    if (h < 48) return h === 1 ? "an hour ago" : `${h} hours ago`;
    return `${Math.floor(h / 24)} days ago`;
}

/** "A", "A and B", "A, B and C". */
export function speakList(items: readonly string[]): string {
    if (items.length <= 1) return items.join("");
    return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "October 11": an instant's Central calendar day, spoken. */
export const speakDate = (d: Date) => d.toLocaleDateString("en-US", { timeZone: TIME_ZONE, month: "long", day: "numeric" });

const DAY_MS = 86_400_000;
/** Whole Central calendar days from `now`'s day to `d`'s (negative in the past). */
const dayOffset = (d: Date, now: Date) =>
    Math.round((Date.parse(`${centralDay(d)}T00:00:00Z`) - Date.parse(`${centralDay(now)}T00:00:00Z`)) / DAY_MS);

/**
 * A Central time, spoken relative to now: "6:45 this morning", "9 tonight",
 * "6:45 tomorrow morning", "4:30 yesterday afternoon", "6:45 Monday morning"
 * (coming), "6:45 on Monday morning" (past), "6:45 next Monday morning",
 * "noon tomorrow", "6:45 in the morning on October 11".
 */
export function speakTime(d: Date, now: Date): string {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
        timeZone: TIME_ZONE, hourCycle: "h23", hour: "2-digit", minute: "2-digit",
    }).formatToParts(d).map((p) => [p.type, p.value]));
    const h = Number(parts.hour), m = Number(parts.minute);
    const offset = dayOffset(d, now);
    const weekday = d.toLocaleDateString("en-US", { timeZone: TIME_ZONE, weekday: "long" });
    const date = speakDate(d);
    // A weekday this past week reads "on Monday"; a coming one, plain "Monday".
    const recent = offset < 0 ? `on ${weekday}` : weekday;

    // Noon and midnight have no part of the day.
    if (m === 0 && (h === 12 || h === 0)) {
        const name = h === 12 ? "noon" : "midnight";
        const day = offset === 0 ? "today" : offset === 1 ? "tomorrow" : offset === -1 ? "yesterday"
            : offset === 7 ? `next ${weekday}` : Math.abs(offset) < 7 ? recent : `on ${date}`;
        return `${name} ${day}`;
    }

    const clock = `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
    const part = h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "night";
    if (offset === 0) return `${clock} ${part === "night" ? "tonight" : `this ${part}`}`;
    if (offset === 1) return `${clock} tomorrow ${part}`;
    if (offset === -1) return `${clock} ${part === "night" ? "last night" : `yesterday ${part}`}`;
    if (offset === 7) return `${clock} next ${weekday} ${part}`;
    if (Math.abs(offset) < 7) return `${clock} ${recent} ${part}`;
    return `${clock} ${part === "night" ? "at night" : `in the ${part}`} on ${date}`;
}

/** A reason as the end of a sentence: trimmed, with its full stop. */
export const sentence = (reason: string) => {
    const r = reason.trim();
    return /[.!?…]$/.test(r) ? r : `${r}.`;
};
