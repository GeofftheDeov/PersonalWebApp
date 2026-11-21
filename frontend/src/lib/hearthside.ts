import { campaignPageUrl, hearthsideOrigin, hearthsidePath } from '@gtd/shared/hearthside';

/**
 * Hearthside's origin, built in at build time (`NEXT_PUBLIC_HEARTHSIDE_URL`,
 * #217), or null while Hearthside isn't live: the deploy passes `""` then.
 * Next inlines `process.env.NEXT_PUBLIC_*` only when written out in full.
 */
export const HEARTHSIDE_URL = hearthsideOrigin(process.env.NEXT_PUBLIC_HEARTHSIDE_URL);

/** A campaign's page: on Hearthside when it's configured, else the portfolio's own (#233). */
export const campaignHref = (campaignId: string) => campaignPageUrl(campaignId, HEARTHSIDE_URL);

/**
 * A portfolio Game Night link (`/game-night/...`, `/players/:id`): straight to
 * its Hearthside page when Hearthside is configured, rather than through the
 * portfolio's 308 (#234); unchanged otherwise, or for any other path.
 *
 *   gameNightHref('/game-night/sessions/s1')  // "https://hearthside.geoffthedeov.net/sessions/s1", or as given
 */
export function gameNightHref(path: string): string {
    const there = HEARTHSIDE_URL ? hearthsidePath(path) : null;
    return there ? `${HEARTHSIDE_URL}${there}` : path;
}
