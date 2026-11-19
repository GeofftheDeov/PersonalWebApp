/**
 * Another player's page (#231, spec #69): what it keeps of
 * `GET /api/users/players/:id` (the public person, never their campaigns),
 * the head's line, and what the Friends pill and "Write a letter" do for a
 * friend and for anyone else.
 *
 *   cd hearthside && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { friendship, visitorLine, visitorView, type PlayerReply } from "../src/lib/room";

const reply: PlayerReply = {
  _id: "p2", recordType: "User", name: "Hal Brask", handle: "hal", userNumber: 77,
  profilePicture: null, favoriteGames: ["Root"], discordId: "42", discordHandle: "halb",
  createdAt: "2025-03-14T12:00:00Z",
  isFriend: true,
  sharedCampaigns: [{ _id: "c1", title: "The Drowned Stair", status: "In Progress", isGameMaster: false }],
};

test("the page keeps the public person and whether you're friends, and drops their campaigns", () => {
  const { person, friends } = visitorView(reply);
  assert.equal(friends, true);
  assert.equal(person.name, "Hal Brask");
  assert.equal(person.handle, "hal");
  assert.deepEqual(person.favoriteGames, ["Root"]);
  assert.equal("sharedCampaigns" in person, false);
  assert.equal("isFriend" in person, false);
  assert.equal(JSON.stringify(person).includes("Drowned Stair"), false);
});

test("anything the public view doesn't send stays off the page, even if a reply carries it", () => {
  const { person } = visitorView({ ...reply, email: "hal@party.test", phone: "555-0101", userDigit: "US-7" } as PlayerReply);
  assert.equal(person.email, undefined);
  assert.equal(person.phone, undefined);
  assert.equal(person.userDigit, undefined);
});

test("not a friend unless the reply says so", () => {
  assert.equal(visitorView({ ...reply, isFriend: false }).friends, false);
  assert.equal(visitorView({ _id: "p3", name: "Ada" }).friends, false);
});

test("the head says since when, and never counts campaigns", () => {
  assert.equal(visitorLine(reply), "Since March 2025");
  assert.equal(visitorLine({ name: "Ada" }), null);
});

test("a friend gets the Friends pill and Write a letter; anyone else neither, and why", () => {
  assert.deepEqual(friendship(true), { pill: "Friends", canWrite: true, note: null });
  const stranger = friendship(false);
  assert.equal(stranger.pill, null);
  assert.equal(stranger.canWrite, false);
  assert.match(stranger.note ?? "", /friends/i);
});
