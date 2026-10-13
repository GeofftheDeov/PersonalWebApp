/**
 * Formatting for the overview tiles. Every time is shown in Central; every
 * signed value carries an explicit + or − (U+2212), so direction never relies
 * on colour.
 */

export const TIME_ZONE = "America/Chicago";
const MINUS = "−";

export const esc = (v: unknown) => String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** $100,412.10 */
export const money = (v: number) => usd.format(v);

/** Sign of a value as shown at `digits` decimals: no sign for a value that rounds to zero. */
const sign = (v: number, digits: number) => {
    const r = Number(v.toFixed(digits));
    return r > 0 ? "+" : r < 0 ? MINUS : "";
};

/** +$412.10 / −$500.00 / $0.00 */
export const signedMoney = (v: number) => sign(v, 2) + usd.format(Math.abs(v));

/** +0.41% / −0.50%, or — when there is no percentage. */
export const signedPct = (v: number | null, digits = 2) =>
    v === null || !Number.isFinite(v) ? "—" : `${sign(v, digits)}${Math.abs(v).toFixed(digits)}%`;

const centralDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: TIME_ZONE });

/** "9:41 AM CT" today (Central), "Oct 11, 9:41 AM CT" on another day. */
export function centralTime(d: Date, now: Date): string {
    const time = d.toLocaleTimeString("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" });
    if (centralDay(d) === centralDay(now)) return `${time} CT`;
    const day = d.toLocaleDateString("en-US", { timeZone: TIME_ZONE, month: "short", day: "numeric" });
    return `${day}, ${time} CT`;
}

/** "just now", "4 min ago", "3 h ago", "2 d ago". */
export function ago(ms: number): string {
    if (ms < 60_000) return "just now";
    const min = Math.floor(ms / 60_000);
    if (min < 60) return `${min} min ago`;
    const h = Math.floor(min / 60);
    if (h < 48) return `${h} h ago`;
    return `${Math.floor(h / 24)} d ago`;
}
