/**
 * How Letters labels things (#221): plain functions, so they're the same
 * wherever a thread or message is drawn (the shell's Letters, and later
 * Table Talk on a campaign's page).
 */

// The times are shared with the portfolio's dashboard (#233).
export { messageWhen, threadWhen, timeOfDay } from '@gtd/shared/letters';

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
