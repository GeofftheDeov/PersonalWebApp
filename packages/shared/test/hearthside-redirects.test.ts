/**
 * The portfolio's 308 redirects to Hearthside (#234, spec #69): `/game-night`,
 * `/game-night/*` and `/players/:id` go to the matching Hearthside page, prefix
 * stripped and query string kept, but only once Hearthside is configured.
 *
 * The redirects are plain JS (src/hearthside/redirects.js), because the
 * portfolio's next.config.js loads them with require(). These tests keep them
 * in step with `hearthsidePath` and `hearthsideOrigin` (src/hearthside/paths.ts),
 * which the bell and the portfolio's links use: each path is run through Next's
 * own route matcher and destination builder, as the portfolio's server does,
 * and the Location it would send is compared with `hearthsidePath`'s answer.
 * Then the portfolio's real next.config.js is loaded with and without the
 * setting, which is the "no Hearthside configured" half of the gate.
 *
 *   cd packages/shared && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import querystring from "node:querystring";
import url from "node:url";
import { hearthsideOrigin, hearthsidePath } from "../src/hearthside/paths";
import { hearthsideOrigin as originForConfig, hearthsideRedirects } from "../src/hearthside/redirects.js";

// Next's own matcher and destination builder (next 13.5), the ones its router
// uses for `redirects()` (server/lib/router-utils/filesystem.js and resolve-routes.js).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getPathMatch } = require("next/dist/shared/lib/router/utils/path-match");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { prepareDestination } = require("next/dist/shared/lib/router/utils/prepare-destination");

const HEARTHSIDE = "https://hearthside.geoffthedeov.test:51240";

/**
 * Where the portfolio's server would redirect `requestPath` (the path and query
 * a browser sends: no anchor), with these redirects, or null if none matches.
 * Status and Location as Next would send them.
 */
function nextRedirect(redirects: ReturnType<typeof hearthsideRedirects>, requestPath: string) {
  const parsed = url.parse(requestPath, true);
  // Next's own trailing-slash redirect (trailingSlash: false) runs first, so a
  // custom redirect only ever sees the path without one.
  const pathname = (parsed.pathname ?? "/").replace(/(.)\/+$/, "$1");
  for (const route of redirects) {
    const params = getPathMatch(route.source, { strict: true, removeUnnamedParams: true })(pathname);
    if (!params) continue;
    const { parsedDestination } = prepareDestination({
      appendParamsToQuery: false,
      destination: route.destination,
      params,
      query: parsed.query,
    });
    const { query } = parsedDestination;
    delete parsedDestination.query;
    parsedDestination.search = querystring.stringify(query);
    return { status: route.permanent ? 308 : 307, location: url.format(parsedDestination) };
  }
  return null;
}

/**
 * What `hearthsidePath` says, on the Hearthside host: where the redirect must
 * go. For the path the custom redirect sees, after Next's trailing-slash one.
 */
function expected(requestPath: string): string | null {
  const to = hearthsidePath(requestPath.replace(/^(\/[^?#]*?)\/+(?=$|[?#])/, "$1"));
  return to === null ? null : `${HEARTHSIDE}${to}`;
}

const REDIRECTED = [
  "/game-night",
  "/game-night/",
  "/game-night?tab=sessions",
  "/game-night/join/0b6f6c1e-6f4f-4c5e-9a3b-2a4c1d9e8f70",
  "/game-night/campaigns/c1",
  "/game-night/campaigns/c1?x=1",
  "/game-night/campaigns/c1?x=1&y=two%20words",
  "/game-night/sessions/s1",
  "/game-night/sessions/s1/",
  "/game-night/characters/a1",
  "/game-night/characters/a1?tab=sheet",
  "/players/p1",
  "/players/p1?from=bell",
  "/players/p1/",
];

const LEFT_ALONE = [
  "/",
  "/dashboard",
  "/profile",
  "/game-nightly",
  "/game-night-recap",
  "/games/night",
  "/players",
  "/players/p1/campaigns",
  "/paperclip/org",
];

test("each Game Night path and /players/:id redirects (308) where hearthsidePath says, query kept", () => {
  const redirects = hearthsideRedirects(HEARTHSIDE);
  for (const requestPath of REDIRECTED) {
    const want = expected(requestPath);
    assert.ok(want, `hearthsidePath should map ${requestPath}`);
    assert.deepEqual(nextRedirect(redirects, requestPath), { status: 308, location: want }, requestPath);
  }
});

test("the ticket's examples", () => {
  const redirects = hearthsideRedirects(HEARTHSIDE);
  assert.equal(nextRedirect(redirects, "/game-night/join/c1")?.location, `${HEARTHSIDE}/join/c1`);
  assert.equal(nextRedirect(redirects, "/game-night/campaigns/c1?x=1")?.location, `${HEARTHSIDE}/campaigns/c1?x=1`);
  assert.equal(nextRedirect(redirects, "/players/p1")?.location, `${HEARTHSIDE}/players/p1`);
  assert.equal(nextRedirect(redirects, "/game-night")?.location, `${HEARTHSIDE}/`);
});

test("every other path, look-alikes included, is left alone, as hearthsidePath leaves it", () => {
  const redirects = hearthsideRedirects(HEARTHSIDE);
  for (const requestPath of LEFT_ALONE) {
    assert.equal(expected(requestPath), null, `hearthsidePath should leave ${requestPath} alone`);
    assert.equal(nextRedirect(redirects, requestPath), null, requestPath);
  }
});

test("the target host is the configured one, so dev's portfolio redirects to dev's Hearthside", () => {
  const dev = hearthsideRedirects("https://deov.hearthside.geoffthedeov.net/");
  assert.equal(nextRedirect(dev, "/game-night/sessions/s1")?.location, "https://deov.hearthside.geoffthedeov.net/sessions/s1");
});

test("with no Hearthside configured there are no redirects", () => {
  for (const setting of [undefined, null, "", "   ", "not a url", "javascript:alert(1)", "ftp://hearthside.example"]) {
    assert.deepEqual(hearthsideRedirects(setting), [], String(setting));
  }
});

test("the config's copy of hearthsideOrigin agrees with paths.ts", () => {
  const settings = [
    undefined, null, "", "  ", "not a url", "javascript:alert(1)", "ftp://h.example",
    "https://hearthside.geoffthedeov.net", "https://hearthside.geoffthedeov.net/", " https://h.example:8443// ",
    "http://localhost:3002", "https://h.example/base/", "HTTPS://H.Example",
  ];
  for (const setting of settings) assert.equal(originForConfig(setting), hearthsideOrigin(setting), String(setting));
});

/** The portfolio's next.config.js as `next build` would load it, with this NEXT_PUBLIC_HEARTHSIDE_URL. */
async function portfolioRedirects(setting: string | undefined) {
  const configPath = path.resolve(__dirname, "../../../frontend/next.config.js");
  const before = process.env.NEXT_PUBLIC_HEARTHSIDE_URL;
  const log = console.log;
  if (setting === undefined) delete process.env.NEXT_PUBLIC_HEARTHSIDE_URL;
  else process.env.NEXT_PUBLIC_HEARTHSIDE_URL = setting;
  console.log = () => {};
  try {
    delete require.cache[require.resolve(configPath)];
    return (await require(configPath).redirects()) as { source: string; destination: string; permanent?: boolean }[];
  } finally {
    console.log = log;
    if (before === undefined) delete process.env.NEXT_PUBLIC_HEARTHSIDE_URL;
    else process.env.NEXT_PUBLIC_HEARTHSIDE_URL = before;
  }
}

test("the portfolio's Next config: no Hearthside host (unset or the deploy's \"\"), no Game Night redirects", async () => {
  for (const setting of [undefined, ""]) {
    const redirects = await portfolioRedirects(setting);
    assert.deepEqual(redirects.filter((r) => /^\/(game-night|players)\b/.test(r.source)), [], JSON.stringify(setting));
    // Its other redirects are untouched.
    assert.ok(redirects.some((r) => r.source === "/paperclip/cfo"));
  }
});

test("the portfolio's Next config: with the host, it has exactly these redirects", async () => {
  const redirects = await portfolioRedirects(HEARTHSIDE);
  for (const r of hearthsideRedirects(HEARTHSIDE)) assert.ok(redirects.some((c) => c.source === r.source && c.destination === r.destination && c.permanent === true), r.source);
  assert.ok(redirects.some((r) => r.source === "/paperclip/cfo"));
});
