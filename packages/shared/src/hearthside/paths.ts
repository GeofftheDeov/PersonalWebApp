/**
 * The portfolio's Game Night paths, and where each one lives on Hearthside now
 * (spec #69, "Route ownership and redirects").
 *
 * Hearthside's paths are the portfolio's with the `/game-night` prefix
 * stripped: `/game-night/campaigns/:id` is `/campaigns/:id`, likewise
 * `/sessions/:id`, `/characters/:id` and `/join/:id` (the campaign's invite),
 * and `/game-night` itself is Hearthside's home, `/`. A player's page,
 * `/players/:id`, keeps its path. The query string and `#` anchor are kept
 * (`#notice-board`, `#quests`).
 *
 * Used by Hearthside's bell for notifications made before HEARTHSIDE_URL
 * (#220), whose links are relative `/game-night/...` paths. The portfolio's
 * 308 redirects (#234) follow the same rule. Framework-free, so the portfolio's
 * Next config, either app and their tests can all use it.
 */

/** The prefix the portfolio's Game Night pages sit under. */
export const GAME_NIGHT_PREFIX = "/game-night";

/** Portfolio paths Hearthside now serves at the same path. */
const SAME_PATH = /^\/players\/[^/]+\/?$/;

/**
 * The Hearthside path (with its query string and anchor) for a portfolio path
 * that Hearthside now owns, or null for any other path.
 *
 *   hearthsidePath("/game-night/campaigns/c1?x=1#notice-board")  // "/campaigns/c1?x=1#notice-board"
 *   hearthsidePath("/game-night")                                // "/"
 *   hearthsidePath("/players/p1")                                // "/players/p1"
 *   hearthsidePath("/profile")                                   // null
 *
 * `path` is a path, not a URL: anything that doesn't start with a single `/`
 * is null.
 */
export function hearthsidePath(path: string): string | null {
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  let url: URL;
  try {
    url = new URL(path, "http://portfolio.invalid");
  } catch {
    return null;
  }
  const rest = `${url.search}${url.hash}`;
  const { pathname } = url;
  if (pathname === GAME_NIGHT_PREFIX || pathname === `${GAME_NIGHT_PREFIX}/`) return `/${rest}`;
  if (pathname.startsWith(`${GAME_NIGHT_PREFIX}/`)) return `${pathname.slice(GAME_NIGHT_PREFIX.length)}${rest}`;
  if (SAME_PATH.test(pathname)) return `${pathname}${rest}`;
  return null;
}

/** A campaign's page on Hearthside, where accepting its invite lands. */
export const hearthsideCampaignPath = (campaignId: string): string => `/campaigns/${encodeURIComponent(campaignId)}`;

/**
 * Hearthside's origin from an app's build-time setting (the portfolio's
 * `NEXT_PUBLIC_HEARTHSIDE_URL`, #217), or null when Hearthside isn't
 * configured: unset, blank (the deploy passes `""` while Hearthside isn't
 * live) or not an http(s) URL. Trailing slashes are dropped.
 *
 *   hearthsideOrigin("https://hearthside.geoffthedeov.net/")  // "https://hearthside.geoffthedeov.net"
 *   hearthsideOrigin("")                                      // null
 */
export function hearthsideOrigin(setting: string | null | undefined): string | null {
  const raw = (setting ?? "").trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/**
 * Where a campaign's "Open in Hearthside" link goes (#233): its page on
 * Hearthside when Hearthside is configured (`hearthsideOrigin`), otherwise the
 * portfolio's own campaign page.
 *
 *   campaignPageUrl("c1", "https://hearthside.example")  // "https://hearthside.example/campaigns/c1"
 *   campaignPageUrl("c1", null)                          // "/game-night/campaigns/c1"
 */
export function campaignPageUrl(campaignId: string, hearthside: string | null): string {
  const path = hearthsideCampaignPath(campaignId);
  return hearthside ? `${hearthside}${path}` : `${GAME_NIGHT_PREFIX}${path}`;
}
