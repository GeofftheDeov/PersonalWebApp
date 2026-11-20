/**
 * Where the portfolio's Game Night paths live on Hearthside (spec #69, "Route
 * ownership and redirects"): the `/game-night` prefix stripped, a player's
 * page at the same path, query string and anchor kept. Hearthside's bell uses
 * it for old notifications (#220); the portfolio's redirects (#234) follow it.
 *
 *   cd packages/shared && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hearthsideCampaignPath, hearthsidePath } from "../src/hearthside/paths";

test("each Game Night page maps to its Hearthside page, prefix stripped", () => {
  assert.equal(hearthsidePath("/game-night/campaigns/c1"), "/campaigns/c1");
  assert.equal(hearthsidePath("/game-night/sessions/s1"), "/sessions/s1");
  assert.equal(hearthsidePath("/game-night/characters/a1"), "/characters/a1");
  assert.equal(hearthsidePath("/game-night/join/c1"), "/join/c1");
});

test("/game-night itself is Hearthside's home", () => {
  assert.equal(hearthsidePath("/game-night"), "/");
  assert.equal(hearthsidePath("/game-night/"), "/");
  assert.equal(hearthsidePath("/game-night?tab=sessions"), "/?tab=sessions");
});

test("the query string and anchor are kept", () => {
  assert.equal(hearthsidePath("/game-night/campaigns/c1?x=1#notice-board"), "/campaigns/c1?x=1#notice-board");
  assert.equal(hearthsidePath("/game-night/sessions/s1#quests"), "/sessions/s1#quests");
});

test("a player's page keeps its path", () => {
  assert.equal(hearthsidePath("/players/p1"), "/players/p1");
  assert.equal(hearthsidePath("/players/p1#record"), "/players/p1#record");
});

test("the portfolio's own pages, look-alikes and non-paths aren't Hearthside's", () => {
  for (const p of ["/", "/profile", "/dashboard", "/game-nightly", "/game-nights/x", "/players", "/players/p1/edit",
    "game-night/campaigns/c1", "//evil.example/game-night", "https://hearthside.geoffthedeov.net/campaigns/c1",
    "/game-night/../profile"]) {
    assert.equal(hearthsidePath(p), null, p);
  }
});

test("accepting an invite lands on the campaign's Hearthside page", () => {
  assert.equal(hearthsideCampaignPath("c1"), "/campaigns/c1");
});
