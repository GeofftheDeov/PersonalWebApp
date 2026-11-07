/**
 * Where the top bar's items go on each site (#216, spec #69). On the
 * portfolio they're its own pages, as before. On Hearthside the portfolio's
 * items (the brand, About, Dashboard, the Paperclip menu, Profile) go to the
 * portfolio's host, from configuration, and "Game Night" is Hearthside's own
 * home. Admin stays off Hearthside: the admin portal still takes a token in
 * its URL, which the bar fetches same-origin (#210), until #242 moves it onto
 * the cookie.
 *
 *   cd packages/shared && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { topBarLinks } from "../src/topbar/links";

test("on the portfolio, every item is one of its own pages, as before", () => {
  assert.deepEqual(topBarLinks("portfolio"), {
    home: "/",
    about: "/about",
    dashboard: "/dashboard",
    paperclip: { org: "/paperclip/org", issues: "/paperclip/issues", budgets: "/paperclip/budgets" },
    profile: "/profile",
    gameNight: "/game-night",
    admin: true,
  });
});

test("on the portfolio, a configured portfolio URL changes nothing", () => {
  assert.deepEqual(topBarLinks("portfolio", "https://geoffthedeov.net"), topBarLinks("portfolio"));
});

test("on Hearthside, the portfolio's items go to the portfolio host and Game Night stays home", () => {
  assert.deepEqual(topBarLinks("hearthside", "https://deov.geoffthedeov.net"), {
    home: "https://deov.geoffthedeov.net/",
    about: "https://deov.geoffthedeov.net/about",
    dashboard: "https://deov.geoffthedeov.net/dashboard",
    paperclip: {
      org: "https://deov.geoffthedeov.net/paperclip/org",
      issues: "https://deov.geoffthedeov.net/paperclip/issues",
      budgets: "https://deov.geoffthedeov.net/paperclip/budgets",
    },
    profile: "https://deov.geoffthedeov.net/profile",
    gameNight: "/",
    admin: false,
  });
});

test("on Hearthside, a trailing slash or a path on the portfolio URL doesn't double up", () => {
  const links = topBarLinks("hearthside", "http://localhost:3000/");
  assert.equal(links.about, "http://localhost:3000/about");
  assert.equal(links.home, "http://localhost:3000/");
  assert.equal(topBarLinks("hearthside", "https://geoffthedeov.net/ignored/path").profile, "https://geoffthedeov.net/profile");
});

test("on Hearthside without a usable portfolio URL, it refuses rather than linking to Hearthside's own pages", () => {
  assert.throws(() => topBarLinks("hearthside"), /portfolio URL/);
  assert.throws(() => topBarLinks("hearthside", "not a url"), /portfolio URL/);
  assert.throws(() => topBarLinks("hearthside", "javascript:alert(1)"), /portfolio URL/);
});
