/**
 * Adventurers (#229, spec #69): whose adventurers hang on the roster and in
 * the Hall of Heroes, the next session under each portrait, the brass plate's
 * line, who may edit, Travels with, and the shared New adventurer / Edit form.
 *
 *   cd hearthside && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_ADVENTURER, adventurerPayload, campaignChoices, canEditAdventurer, classLine, formOf, formProblem, initialsOf,
  nextLabel, nextSessions, playedByLine, rosterOf, statusOf, travelsWith,
  type Adventurer, type RosterSession,
} from "../src/lib/adventurers";
import type { PartyCharacter } from "../src/lib/campaignRecords";

const ME = "me-1";
const NOW = new Date("2026-11-19T12:00:00Z");
const a = (id: string, over: Partial<Adventurer> = {}): Adventurer => ({ _id: id, name: id, player: ME, ...over });

test("the roster is the viewer's own adventurers, the fallen apart in the Hall of Heroes, each by name", () => {
  const list = [
    a("Wren"),
    a("kestrel", { name: "Kestrel" }),
    a("Pip", { isDead: true }),
    a("theirs", { player: "someone-else" }),
    a("populated", { name: "Ada", player: { _id: ME, name: "me", handle: null } }),
  ];
  const r = rosterOf(list, ME);
  assert.deepEqual(r.adventuring.map((c) => c.name), ["Ada", "Kestrel", "Wren"]);
  assert.deepEqual(r.fallen.map((c) => c.name), ["Pip"]);
  assert.deepEqual(rosterOf([a("x", { player: "other" })], ME), { adventuring: [], fallen: [] });
});

test("the next session in each campaign is the soonest not yet over, with a night, not called off", () => {
  const s = (id: string, campaign: string, date: string | null, over: Partial<RosterSession> = {}): RosterSession =>
    ({ _id: id, campaign: { _id: campaign }, date, status: "scheduled", ...over });
  const next = nextSessions([
    s("past", "c1", "2026-11-10T19:00:00Z"),
    s("later", "c1", "2026-12-10T19:00:00Z"),
    s("soon", "c1", "2026-11-26T19:00:00Z"),
    s("off", "c1", "2026-11-20T19:00:00Z", { status: "cancelled" }),
    s("undated", "c1", null, { status: "planning" }),
    // Started at 10:00, no end: under way until 14:00, so still the next one at noon.
    s("now", "c2", "2026-11-19T10:00:00Z"),
    s("bare-id", "c3", "2026-11-30T19:00:00Z", { campaign: "c3" }),
  ], NOW);
  assert.equal(next.get("c1")?._id, "soon");
  assert.equal(next.get("c2")?._id, "now");
  assert.equal(next.get("c3")?._id, "bare-id");
  assert.equal(next.size, 3);
});

test("the next session reads as a short day, with the year only when it isn't this one", () => {
  assert.equal(nextLabel({ date: new Date(2026, 10, 26, 19).toISOString() }, NOW), "Next: Thu Nov 26");
  assert.equal(nextLabel({ date: new Date(2027, 0, 7, 19).toISOString() }, NOW), "Next: Thu Jan 7, 2027");
});

test("the brass plate says class and level; the sheet says whether they've fallen", () => {
  assert.equal(classLine({ class: "Envoy", level: 3 }), "Envoy · Level 3");
  assert.equal(classLine({ class: "  ", level: 1 }), "Level 1");
  assert.equal(classLine({ class: null, level: null }), "No class set");
  assert.equal(statusOf({ isDead: true }), "Fallen");
  assert.equal(statusOf({}), "Adventuring");
});

test("the fallback portrait stitches on the name's initials, skipping a title", () => {
  assert.equal(initialsOf("Kestrel Vane"), "KV");
  assert.equal(initialsOf("Dr. Ada Marsh"), "AM");
  assert.equal(initialsOf("Brother Odran"), "O");
  assert.equal(initialsOf("pip"), "P");
  assert.equal(initialsOf("Élodie de la Tour"), "ÉD");
  assert.equal(initialsOf("  "), "?");
  assert.equal(initialsOf("7th Son"), "S");
});

test("only the player and admins may edit; anyone else reads it", () => {
  const c = a("k", { player: { _id: ME, name: "me", handle: null } });
  assert.equal(canEditAdventurer(c, { id: ME }, { appRole: "user" }), true);
  assert.equal(canEditAdventurer(c, { id: "friend" }, { appRole: "user" }), false);
  assert.equal(canEditAdventurer(c, { id: "admin" }, { appRole: "admin" }), true);
  assert.equal(canEditAdventurer(c, null, null), false);
});

test("Played by is You for your own, the handle or name otherwise", () => {
  assert.equal(playedByLine(a("k"), ME), "You");
  assert.equal(playedByLine(a("k", { player: { _id: "p", name: "Hal", handle: "hal" } }), ME), "@hal");
  assert.equal(playedByLine(a("k", { player: { _id: "p", name: "Hal Brask", handle: null } }), ME), "Hal Brask");
  assert.equal(playedByLine(a("k", { player: "p" }), ME), "Someone");
});

test("Travels with is the rest of the party still travelling, by name", () => {
  const m = (id: string, over: Partial<PartyCharacter> = {}): PartyCharacter =>
    ({ _id: id, name: id, player: null, playerActive: true, ...over });
  assert.deepEqual(
    travelsWith([m("self"), m("zed"), m("Ash"), m("gone", { playerActive: false }), m("fell", { isDead: true })], "self").map((x) => x._id),
    ["Ash", "zed"],
  );
});

test("the form fills from an adventurer, and needs a name and a level from 1 to 20", () => {
  const f = formOf(a("k", { name: "Kestrel", class: "Envoy", level: 4, gameType: "Starfinder", campaign: { _id: "c1", title: "Starfall" }, isDead: true }));
  assert.deepEqual(f, { name: "Kestrel", class: "Envoy", level: "4", gameType: "Starfinder", campaign: "c1", isDead: true });
  assert.deepEqual(formOf(a("k", { name: "Bare", class: null, level: null, campaign: null })),
    { ...EMPTY_ADVENTURER, name: "Bare" });

  assert.equal(formProblem({ ...EMPTY_ADVENTURER, name: "Wren" }), null);
  assert.equal(formProblem({ ...EMPTY_ADVENTURER, name: "  " }), "Every adventurer needs a name.");
  for (const level of ["0", "21", "", "2.5", "-1", "abc"]) {
    assert.match(formProblem({ ...EMPTY_ADVENTURER, name: "Wren", level }) ?? "", /^The level is a whole number from 1 to 20/, level);
  }
});

test("New adventurer and Edit send today's fields, trimmed, with the level as a number", () => {
  const f = { name: "  Wren  ", class: " Bard ", level: "2", gameType: "D&D 5e", campaign: "", isDead: true };
  assert.deepEqual(adventurerPayload(f), { name: "Wren", class: "Bard", level: 2, gameType: "D&D 5e", campaign: "", isDead: true });
});

test("the campaigns offered are the viewer's, plus the one it's already in", () => {
  const mine = [{ _id: "c1", title: "Starfall" }];
  assert.deepEqual(campaignChoices(mine, null), mine);
  assert.deepEqual(campaignChoices(mine, a("k", { campaign: { _id: "c1", title: "Starfall" } })), mine);
  assert.deepEqual(campaignChoices(mine, a("k", { campaign: { _id: "old", title: "The Lantern Road" } })),
    [...mine, { _id: "old", title: "The Lantern Road" }]);
});
