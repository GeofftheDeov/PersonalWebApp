/**
 * When things happened, as Letters writes it on both sites (#221, #233):
 * plain functions, so the portfolio's dashboard and Hearthside's Letters label
 * a thread's last activity and a message's time the same way. Each site
 * styles the text (the portfolio upper-cases it).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** A time of day: "7:02 pm". */
export const timeOfDay = (d: Date) =>
  d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).toLowerCase();

/**
 * A thread's last activity, for the list: "now", "7:02 pm" today, "Tue" this
 * week, "Oct 3" this year, "Oct 3, 2025" before that, and nothing if nobody
 * has written yet.
 */
export function threadWhen(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  const ago = now.getTime() - d.getTime();
  if (ago < 60_000) return "now";
  if (sameDay(d, now)) return timeOfDay(d);
  if (ago < 6 * DAY_MS) return d.toLocaleDateString(undefined, { weekday: "short" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** A message's time in the log: the time today, else the date and time. */
export function messageWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  return sameDay(d, now)
    ? timeOfDay(d)
    : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${timeOfDay(d)}`;
}
