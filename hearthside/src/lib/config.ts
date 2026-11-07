/**
 * Hearthside's configuration, read at build time: Next inlines
 * `NEXT_PUBLIC_*` values into the bundle when `next build` runs, so each
 * environment's image is built with its own (Dockerfile build args).
 *
 * NEXT_PUBLIC_PORTFOLIO_URL  The portfolio's origin, where the top bar's
 *                            portfolio items go: https://geoffthedeov.net in
 *                            prod, https://deov.geoffthedeov.net on dev.
 *                            Default: the portfolio's local dev server.
 */
export const PORTFOLIO_URL = process.env.NEXT_PUBLIC_PORTFOLIO_URL || 'http://localhost:3000';
