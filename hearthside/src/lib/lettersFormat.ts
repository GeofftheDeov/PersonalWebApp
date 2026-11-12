/**
 * How Letters labels things (#221): plain functions, so they're the same
 * wherever a thread or message is drawn (the shell's Letters, and later
 * Table Talk on a campaign's page).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** A time of day as the design system writes it: "7:02 pm". */
export const timeOfDay = (d: Date) =>
  d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLowerCase();

/**
 * A thread's last activity, for the list: "now", "7:02 pm" today, "Tue" this
 * week, "Oct 3" this year, "Oct 3, 2025" before that, and nothing if nobody
 * has written yet.
 */
export function threadWhen(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  const ago = now.getTime() - d.getTime();
  if (ago < 60_000) return 'now';
  if (sameDay(d, now)) return timeOfDay(d);
  if (ago < 6 * DAY_MS) return d.toLocaleDateString(undefined, { weekday: 'short' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** A message's time in the log: the time today, else the date and time. */
export function messageWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  return sameDay(d, now)
    ? timeOfDay(d)
    : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${timeOfDay(d)}`;
}

/** Up to two initials for an avatar: "Morwen Ashby" → "MA". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return words.slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
}

/** Who wrote a message: "You" for your own; older messages stored an email as the name, so show its name part. */
export function senderLabel(sender: { id: string; name?: string }, myId: string | null): string {
  if (myId && sender.id === myId) return 'You';
  const name = sender.name?.trim() || '';
  if (!name) return 'Someone';
  return name.includes('@') ? name.split('@')[0] : name;
}
