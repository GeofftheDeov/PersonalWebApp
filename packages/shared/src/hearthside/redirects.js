/**
 * The portfolio's 308 redirects to Hearthside (#234, spec #69, "Route
 * ownership and redirects"), as entries for `redirects()` in
 * `frontend/next.config.js`.
 *
 *   /game-night            → <hearthside>/
 *   /game-night/<rest>     → <hearthside>/<rest>     (e.g. /game-night/join/:id → /join/:id)
 *   /players/:id           → <hearthside>/players/:id
 *
 * Next passes the query string through to the destination, and browsers keep
 * the `#` anchor across a redirect. A trailing slash (`/game-night/`) first
 * takes Next's own redirect to the path without it, then this one.
 *
 * Gated: with no Hearthside configured (`setting` unset, blank, or not an
 * http(s) URL, as `hearthsideOrigin` reads it) there are no redirects, and the
 * portfolio's own `/game-night` pages keep serving. The setting is the
 * portfolio's build-time `NEXT_PUBLIC_HEARTHSIDE_URL` (#217): Next evaluates
 * `redirects()` at `next build` and bakes the result into the build, so the
 * switch takes effect with the image built after it changes, as the
 * portfolio's links to Hearthside do.
 *
 * Plain CommonJS, not TypeScript like the rest of the package: Next 13 loads
 * `next.config.js` with `require()`, before anything is compiled. So the rules
 * of `hearthsidePath` and `hearthsideOrigin` (./paths.ts) are restated here as
 * redirect patterns; test/hearthside-redirects.test.ts runs these entries
 * through Next's own route matcher and keeps the two in step.
 */

/** Same rule as `hearthsideOrigin` in ./paths.ts. */
function hearthsideOrigin(setting) {
  const raw = (setting == null ? "" : String(setting)).trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/**
 * The redirects to Hearthside for the portfolio's Next config, or none when
 * Hearthside isn't configured.
 *
 *   hearthsideRedirects("https://hearthside.geoffthedeov.net")  // three 308s
 *   hearthsideRedirects("")                                     // []
 */
function hearthsideRedirects(setting) {
  const origin = hearthsideOrigin(setting);
  if (!origin) return [];
  return [
    { source: "/game-night", destination: `${origin}/`, permanent: true },
    { source: "/game-night/:path+", destination: `${origin}/:path+`, permanent: true },
    { source: "/players/:id", destination: `${origin}/players/:id`, permanent: true },
  ];
}

module.exports = { hearthsideRedirects, hearthsideOrigin };
