/** Which site the bar is on. */
export type TopBarSite = "portfolio" | "hearthside";

/** Where each of the top bar's items goes, on one site. */
export interface TopBarLinks {
  /** The brand. */
  home: string;
  about: string;
  dashboard: string;
  paperclip: { org: string; issues: string; budgets: string };
  profile: string;
  gameNight: string;
  /** Whether the Admin item shows (to admins). */
  admin: boolean;
}

const PORTFOLIO_PATHS = {
  home: "/",
  about: "/about",
  dashboard: "/dashboard",
  paperclip: { org: "/paperclip/org", issues: "/paperclip/issues", budgets: "/paperclip/budgets" },
  profile: "/profile",
} as const;

/**
 * Where the top bar's items go (#216, spec #69).
 *
 * - On the portfolio: its own pages, as they always were. "Game Night" is
 *   still `/game-night` until #234 points it at Hearthside.
 * - On Hearthside: the portfolio's items (the brand, About, Dashboard, the
 *   Paperclip menu, Profile) go to `portfolioUrl`, the portfolio's origin from
 *   the app's configuration; "Game Night" is Hearthside's `/`. Admin doesn't
 *   show: the admin portal still takes a token in its URL, which the bar asks
 *   for same-origin (#210), until #242 moves the portal onto the cookie.
 *
 * Throws on Hearthside without a usable http(s) `portfolioUrl`, rather than
 * pointing the portfolio's items at Hearthside pages that don't exist.
 */
export function topBarLinks(site: TopBarSite, portfolioUrl?: string): TopBarLinks {
  if (site === "portfolio") {
    return { ...PORTFOLIO_PATHS, paperclip: { ...PORTFOLIO_PATHS.paperclip }, gameNight: "/game-night", admin: true };
  }
  const origin = httpOrigin(portfolioUrl);
  if (!origin) throw new Error(`The top bar on Hearthside needs the portfolio URL (got ${JSON.stringify(portfolioUrl)})`);
  const on = (path: string) => `${origin}${path}`;
  return {
    home: on(PORTFOLIO_PATHS.home),
    about: on(PORTFOLIO_PATHS.about),
    dashboard: on(PORTFOLIO_PATHS.dashboard),
    paperclip: {
      org: on(PORTFOLIO_PATHS.paperclip.org),
      issues: on(PORTFOLIO_PATHS.paperclip.issues),
      budgets: on(PORTFOLIO_PATHS.paperclip.budgets),
    },
    profile: on(PORTFOLIO_PATHS.profile),
    gameNight: "/",
    admin: false,
  };
}

function httpOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}
