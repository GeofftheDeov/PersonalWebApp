/**
 * Your Room's rules (#230, spec #69): the head's counts, the record's rows
 * (what only you see), what Save sends, the photo rule, favourite games,
 * Coming up and Played with the campaign filter, the Google Calendar lines
 * and `/players/<own id>`.
 *
 *   cd hearthside && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bySessionFilter, comingUp, displayName, filterOptions, gcalResult, gcalState, headLine, isOwnPage,
  photoProblem, played, recordDraft, recordEdits, recordRows, roomTab, uniqueIdOf, withGame, withoutGame,
  type LedgerPerson,
} from "../src/lib/room";

const me: LedgerPerson = {
  _id: "p1", name: "Wren Talbot", handle: "wren", userNumber: "4821", userDigit: "US-0042",
  email: "wren@party.test", phone: "555-0101", sfObject: "User",
  discordHandle: "wren_t", discordId: "123456789012345678", favoriteGames: ["Gloomhaven"], createdAt: "2025-03-14T12:00:00Z",
};

test("the head counts sessions and campaigns, and says since when", () => {
  assert.equal(headLine({ sessions: 12, campaigns: 3, since: me.createdAt }), "12 sessions · 3 campaigns · since March 2025");
  assert.equal(headLine({ sessions: 1, campaigns: 1, since: null }), "1 session · 1 campaign");
});

test("the unique ID needs a handle and a number", () => {
  assert.equal(uniqueIdOf(me), "@wren#4821");
  assert.equal(uniqueIdOf({ ...me, handle: null }), "");
  assert.equal(displayName({ firstName: "Ada", lastName: "Quill" }), "Ada Quill");
  assert.equal(displayName({}), "A player");
});

test("your own record has every field; another player's leaves out what only you see", () => {
  const own = recordRows(me, true);
  assert.deepEqual(own.map((r) => r.label), [
    "Name", "Handle", "Unique ID", "Internal ID", "Email", "Phone", "Record type", "Discord", "Discord user ID", "Joined",
  ]);
  assert.deepEqual(own.filter((r) => r.mine).map((r) => r.label), ["Internal ID", "Email", "Phone", "Record type"]);
  assert.equal(own.find((r) => r.label === "Record type")?.value, "User");
  // The internal ID is for User records only, as on the portfolio.
  assert.ok(!recordRows({ ...me, sfObject: "Lead" }, true).some((r) => r.label === "Internal ID"));
  const theirs = recordRows({ ...me, email: undefined, phone: undefined }, false).map((r) => r.label);
  assert.deepEqual(theirs, ["Name", "Handle", "Unique ID", "Discord", "Discord user ID", "Joined"]);
  // Unset fields say so.
  const bare = recordRows({ name: "Pell" }, true);
  assert.equal(bare.find((r) => r.label === "Handle")?.value, null);
  assert.equal(bare.find((r) => r.label === "Discord")?.empty, "Not linked");
});

test("Save sends only what changed, trimmed, and the handle without its @", () => {
  const draft = recordDraft(me);
  assert.deepEqual(recordEdits(draft, me), {});
  assert.deepEqual(recordEdits({ ...draft, name: " Wren Ashby ", handle: "@@wrenna" }, me), { name: "Wren Ashby", handle: "wrenna" });
  assert.deepEqual(recordEdits({ ...draft, phone: "" }, me), { phone: "" });
  assert.deepEqual(recordEdits({ name: "Pell", handle: "", phone: "", discordHandle: "pell", discordId: "" }, { name: "Pell" }), { discordHandle: "pell" });
});

test("a photo is a JPG, PNG, GIF or WEBP of 5 MB at most", () => {
  assert.equal(photoProblem({ type: "image/png", size: 1000 }), null);
  assert.equal(photoProblem({ type: "image/webp", size: 5 * 1024 * 1024 }), null);
  assert.match(photoProblem({ type: "image/svg+xml", size: 10 })!, /JPG, PNG, GIF or WEBP/);
  assert.ok(photoProblem({ type: "image/jpeg", size: 5 * 1024 * 1024 + 1 }));
});

test("favourite games take no blanks or repeats", () => {
  assert.deepEqual(withGame(["Gloomhaven"], " Root "), ["Gloomhaven", "Root"]);
  assert.deepEqual(withGame(["Gloomhaven"], "gloomhaven"), ["Gloomhaven"]);
  assert.deepEqual(withGame(["Gloomhaven"], "  "), ["Gloomhaven"]);
  assert.deepEqual(withoutGame(["Gloomhaven", "Root"], "Gloomhaven"), ["Root"]);
});

const now = new Date("2026-11-18T12:00:00Z");
const crown = { _id: "c1", title: "The Ashen Crown" };
const lantern = { _id: "c2", title: "The Lantern Road" };

test("Coming up is the dated sessions still to come, soonest first", () => {
  const list = comingUp([
    { _id: "s1", title: "Later", date: "2026-12-01T19:00:00Z", campaign: crown },
    { _id: "s2", title: "", date: "2026-11-20T19:00:00Z", campaign: lantern },
    { _id: "s3", title: "Over", date: "2026-11-01T19:00:00Z", endDate: "2026-11-01T22:00:00Z", campaign: crown },
    { _id: "s4", title: "Undated", date: null, status: "planning", campaign: crown },
    { _id: "s5", title: "Called off", date: "2026-11-25T19:00:00Z", status: "cancelled", campaign: crown },
    { _id: "s6", title: "Tonight", date: "2026-11-18T10:00:00Z", campaign: crown },
  ], now);
  assert.deepEqual(list.map((s) => s.title), ["Tonight", "Session", "Later"]);
  assert.deepEqual(list[1].campaign, { id: "c2", title: "The Lantern Road" });
});

test("Played is the sessions attended, latest first, once each", () => {
  const list = played([
    { sessionId: "a", title: "First", date: "2026-01-01T19:00:00Z", campaign: { id: "c1", title: "The Ashen Crown" } },
    { sessionId: "b", title: "Second", date: "2026-02-01T19:00:00Z", campaign: { id: "c2", title: "The Lantern Road" } },
    { sessionId: "a", title: "First", date: "2026-01-01T19:00:00Z", campaign: { id: "c1", title: "The Ashen Crown" } },
  ]);
  assert.deepEqual(list.map((s) => s.title), ["Second", "First"]);
});

test("the campaign filter lists each campaign in either list and narrows both", () => {
  const up = comingUp([{ _id: "s1", title: "Next", date: "2026-12-01T19:00:00Z", campaign: crown }], now);
  const done = played([
    { sessionId: "a", title: "Old", date: "2026-01-01T19:00:00Z", campaign: { id: "c1", title: "The Ashen Crown" } },
    { sessionId: "b", title: "Older", date: "2025-01-01T19:00:00Z", campaign: { id: "c2", title: "The Lantern Road" } },
  ]);
  assert.deepEqual(filterOptions(up, done), [
    { id: "c1", title: "The Ashen Crown", count: 2 },
    { id: "c2", title: "The Lantern Road", count: 1 },
  ]);
  assert.deepEqual(bySessionFilter(up, "c2"), []);
  assert.deepEqual(bySessionFilter(done, "c2").map((s) => s.title), ["Older"]);
  assert.equal(bySessionFilter(done, "all").length, 2);
});

test("Google Calendar: the result line from ?gcal=, and the card's state", () => {
  assert.equal(gcalResult("connected"), "Google Calendar connected!");
  assert.match(gcalResult("denied")!, /cancelled/);
  assert.match(gcalResult("noRefreshToken")!, /refresh token/);
  assert.equal(gcalResult("nonsense"), null);
  assert.equal(gcalResult(null), null);
  assert.equal(gcalState(null).pill, "Not connected");
  assert.equal(gcalState({ connected: true }).pill, "Connected");
  assert.deepEqual(gcalState({ connected: true, needsReconsent: true }).tone, "seal");
});

test("the tab: ?tab= when it's one, Integrations after Google, else the Record", () => {
  assert.equal(roomTab("sessions", null), "sessions");
  assert.equal(roomTab(null, "connected"), "integrations");
  // Connect started on Availability comes back to it (#275).
  assert.equal(roomTab("availability", "connected"), "availability");
  assert.equal(roomTab("vault", null), "record");
});

test("/players/<own id> is Your Room", () => {
  assert.equal(isOwnPage("p1", { id: "p1" }), true);
  assert.equal(isOwnPage("p2", { id: "p1" }), false);
  assert.equal(isOwnPage("p1", null), false);
});
