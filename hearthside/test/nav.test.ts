/**
 * The rail's nav (#216, spec #69): The Hearth, Campaigns, Almanac, Adventurers
 * and Your Room, with the page you're on marked, and the floor's page for each
 * route (the prototypes pan the floor one step per nav item: The Hearth 0 …
 * Your Room 4).
 *
 *   cd hearthside && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NAV, currentNav, floorPage } from "../src/lib/nav";

test("the nav offers the five places, in order, at Hearthside's own paths", () => {
  assert.deepEqual(NAV.map((n) => [n.label, n.href]), [
    ["The Hearth", "/"],
    ["Campaigns", "/campaigns"],
    ["Almanac", "/almanac"],
    ["Adventurers", "/characters"],
    ["Your Room", "/room"],
  ]);
});

test("each place is marked on its own page and the pages under it", () => {
  const marked = (p: string) => currentNav(p)?.label ?? null;
  assert.equal(marked("/"), "The Hearth");
  assert.equal(marked("/campaigns"), "Campaigns");
  assert.equal(marked("/campaigns/c1"), "Campaigns");
  assert.equal(marked("/sessions/s1"), "Campaigns", "a session belongs to its campaign");
  assert.equal(marked("/almanac"), "Almanac");
  assert.equal(marked("/characters"), "Adventurers");
  assert.equal(marked("/characters/a1"), "Adventurers");
  assert.equal(marked("/room"), "Your Room");
  assert.equal(marked("/room/"), "Your Room");
});

test("pages that aren't one of the places mark nothing", () => {
  for (const p of ["/players/p1", "/login", "/join/c1", "/campaignsx", "/roomy", "/nowhere"]) {
    assert.equal(currentNav(p), null, p);
  }
});

test("the floor's page follows the nav, and stays where it is elsewhere", () => {
  assert.equal(floorPage("/"), 0);
  assert.equal(floorPage("/campaigns/c1"), 1);
  assert.equal(floorPage("/sessions/s1"), 1);
  assert.equal(floorPage("/almanac"), 2);
  assert.equal(floorPage("/characters/a1"), 3);
  assert.equal(floorPage("/room"), 4);
  assert.equal(floorPage("/players/p1"), null);
  assert.equal(floorPage("/login"), null);
});
