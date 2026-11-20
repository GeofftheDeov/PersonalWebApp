import { hearthsideJoinPath, hearthsidePath, hearthsidePlayerPath } from "../hearthside/paths";
import type { TopBarSite } from "./links";

/** How to open a notification: a page of this site through the app's router, or a full page load elsewhere. */
export type NotificationTarget = { kind: "route" | "page"; href: string };

export interface NotificationSite {
  /** Which site the bell is on. The portfolio when left out. */
  site?: TopBarSite;
  /** The portfolio's origin, which Hearthside's bell sends portfolio-only paths to. */
  portfolioUrl?: string;
}

/**
 * Where a notification's `link` goes, seen from the page at `here`. The
 * backend sends a relative `/game-night/...` path, or (with HEARTHSIDE_URL
 * set, #214) an absolute Hearthside URL. Only http(s) links open; anything
 * else (`javascript:`, `data:`) opens nothing.
 *
 * On the portfolio, a link on this site opens through the router and any
 * other with a full page load, as always.
 *
 * On Hearthside (#220), a relative link was made for the portfolio: an old
 * `/game-night/...` path opens its Hearthside page through the router, prefix
 * stripped (`hearthsidePath`; a player's `/players/:id` keeps its path), and
 * any other path opens on the portfolio's host (given `portfolioUrl`). An
 * absolute link to the portfolio's host is treated the same way.
 */
export function notificationTarget(
  link: string | null | undefined,
  here: string,
  { site = "portfolio", portfolioUrl }: NotificationSite = {},
): NotificationTarget | null {
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link, here);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const path = `${url.pathname}${url.search}${url.hash}`;
  const sameOrigin = url.origin === new URL(here).origin;

  if (site === "hearthside") {
    const portfolio = originOf(portfolioUrl);
    const relative = link.startsWith("/") && !link.startsWith("//");
    if (relative || (portfolio && url.origin === portfolio)) {
      const onHearthside = hearthsidePath(path);
      if (onHearthside) return { kind: "route", href: onHearthside };
      if (portfolio) return { kind: "page", href: `${portfolio}${path}` };
    }
  }

  if (sameOrigin) return { kind: "route", href: path };
  return { kind: "page", href: url.href };
}

/** What `hearthsideNoticePath` reads of a bell row. */
export interface NoticeRow {
  type: string;
  meta?: { campaignId?: string; inviteId?: string; fromUserId?: string; friendAnswer?: string } | null;
}

/**
 * Where a row with no link of its own opens on Hearthside (#251), or null:
 *
 * - a campaign invite opens its invite page, `/join/:campaignId` (JOIN and
 *   DECLINE still answer it in the bell);
 * - "@x accepted (or declined) your friend request" opens that person's
 *   `/players/:id`. Rows made before #251 don't say who, so they open nothing.
 *
 * The portfolio's bell doesn't use it: there these rows open nothing, as before.
 */
export function hearthsideNoticePath(n: NoticeRow): string | null {
  const meta = n.meta ?? {};
  if (n.type === "campaign_invite" && meta.campaignId) return hearthsideJoinPath(meta.campaignId);
  if (n.type === "system" && (meta.friendAnswer === "accepted" || meta.friendAnswer === "declined") && meta.fromUserId) {
    return hearthsidePlayerPath(meta.fromUserId);
  }
  return null;
}

function originOf(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}
