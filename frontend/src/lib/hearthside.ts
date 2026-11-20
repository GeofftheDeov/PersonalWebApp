import { campaignPageUrl, hearthsideOrigin } from '@gtd/shared/hearthside';

/**
 * Hearthside's origin, built in at build time (`NEXT_PUBLIC_HEARTHSIDE_URL`,
 * #217), or null while Hearthside isn't live: the deploy passes `""` then.
 * Next inlines `process.env.NEXT_PUBLIC_*` only when written out in full.
 */
export const HEARTHSIDE_URL = hearthsideOrigin(process.env.NEXT_PUBLIC_HEARTHSIDE_URL);

/** A campaign's page: on Hearthside when it's configured, else the portfolio's own (#233). */
export const campaignHref = (campaignId: string) => campaignPageUrl(campaignId, HEARTHSIDE_URL);
