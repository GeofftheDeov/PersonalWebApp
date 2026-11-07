/**
 * Where opening a notification goes (#211). Since #214 a notification's `link`
 * is an absolute Hearthside URL when the backend has HEARTHSIDE_URL, and a
 * relative `/game-night/...` path when it doesn't (and in every older row).
 * The bell follows both: a page of this site through the app's router, another
 * site with a full page load, and nothing it can't trust.
 *
 *   cd packages/shared && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { notificationTarget } from "../src/topbar/notificationLink";

const HERE = "https://geoffthedeov.net/dashboard";

test("a relative link opens in this site's router, query and anchor kept", () => {
  assert.deepEqual(notificationTarget("/game-night/campaigns/c1#notice-board", HERE),
    { kind: "route", href: "/game-night/campaigns/c1#notice-board" });
  assert.deepEqual(notificationTarget("/game-night/sessions/s1?x=1#quests", HERE),
    { kind: "route", href: "/game-night/sessions/s1?x=1#quests" });
});

test("an absolute link to another site (Hearthside) is a full page load", () => {
  assert.deepEqual(notificationTarget("https://hearthside.geoffthedeov.net/sessions/s1#quests", HERE),
    { kind: "page", href: "https://hearthside.geoffthedeov.net/sessions/s1#quests" });
});

test("an absolute link to this same site stays in the router", () => {
  assert.deepEqual(notificationTarget("https://geoffthedeov.net/profile?tab=friends", HERE),
    { kind: "route", href: "/profile?tab=friends" });
});

test("nothing to open, or nothing safe to open, opens nothing", () => {
  assert.equal(notificationTarget(undefined, HERE), null);
  assert.equal(notificationTarget("", HERE), null);
  assert.equal(notificationTarget("javascript:alert(1)", HERE), null);
  assert.equal(notificationTarget("//evil.example/x", HERE)?.kind, "page", "protocol-relative is another host");
  assert.equal(notificationTarget("data:text/html,hi", HERE), null);
});
