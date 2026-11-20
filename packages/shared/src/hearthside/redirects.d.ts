/** Types for ./redirects.js, the portfolio's 308 redirects to Hearthside (#234). */

/** One entry of Next's `redirects()`. */
export interface HearthsideRedirect {
  source: string;
  destination: string;
  permanent: true;
}

/** The redirects to Hearthside for the portfolio's Next config, or none when Hearthside isn't configured. */
export function hearthsideRedirects(setting: string | null | undefined): HearthsideRedirect[];

/** The same rule as `hearthsideOrigin` in ./paths.ts, restated for `require()`. */
export function hearthsideOrigin(setting: string | null | undefined): string | null;
