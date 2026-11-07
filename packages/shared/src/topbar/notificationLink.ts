/** How to open a notification: a page of this site through the app's router, or a full page load elsewhere. */
export type NotificationTarget = { kind: "route" | "page"; href: string };

/**
 * Where a notification's `link` goes, seen from the page at `here`. The
 * backend sends a relative `/game-night/...` path, or (with HEARTHSIDE_URL
 * set, #214) an absolute Hearthside URL. Only http(s) links open; anything
 * else (`javascript:`, `data:`) opens nothing.
 */
export function notificationTarget(link: string | null | undefined, here: string): NotificationTarget | null {
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link, here);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.origin === new URL(here).origin) return { kind: "route", href: `${url.pathname}${url.search}${url.hash}` };
  return { kind: "page", href: url.href };
}
