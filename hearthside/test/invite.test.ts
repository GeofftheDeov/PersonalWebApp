/**
 * The campaign invite page (#232): which pending invite is this campaign's,
 * who sent it, whether the viewer already has a seat, and where signing in
 * comes back to.
 *
 *   cd hearthside && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasSeat, inviterName, joinPath, partyCount, pendingInviteFor, type PendingInvite } from "../src/lib/invite";
import { withReturn } from "../src/lib/signIn";
import type { Member } from "../src/lib/campaignPage";

const C1 = "aaaaaaaa-0000-4000-8000-0000000000c1";
const C2 = "aaaaaaaa-0000-4000-8000-0000000000c2";
const ME = "aaaaaaaa-0000-4000-8000-000000000001";
const GM = "aaaaaaaa-0000-4000-8000-000000000002";

const invite = (over: Partial<PendingInvite> = {}): PendingInvite => ({
  _id: "i1",
  campaign: { _id: C1, title: "Curse of the Ashen Crown" },
  from: { _id: GM, handle: "morwen", name: "Morwen Ashby" },
  status: "pending",
  ...over,
});

test("the pending invite to this campaign is found, populated or not, whatever the id's case", () => {
  const mine = [invite({ _id: "other", campaign: { _id: C2 } }), invite()];
  assert.equal(pendingInviteFor(mine, C1)?._id, "i1");
  assert.equal(pendingInviteFor(mine, C1.toUpperCase())?._id, "i1");
  assert.equal(pendingInviteFor([invite({ campaign: C1 })], C1)?._id, "i1");
  assert.equal(pendingInviteFor([invite({ campaign: { id: C1 } })], C1)?._id, "i1");
});

test("no invite when there's none for this campaign, none pending, or the list couldn't be read", () => {
  assert.equal(pendingInviteFor([invite({ campaign: { _id: C2 } })], C1), null);
  assert.equal(pendingInviteFor([invite({ status: "declined" })], C1), null);
  assert.equal(pendingInviteFor([invite({ campaign: null })], C1), null);
  assert.equal(pendingInviteFor([], C1), null);
  assert.equal(pendingInviteFor(null, C1), null);
});

test("the newest invite wins when there are two (the list comes newest first)", () => {
  assert.equal(pendingInviteFor([invite({ _id: "new" }), invite({ _id: "old" })], C1)?._id, "new");
});

test("the inviter is named by handle, else by name, else not at all", () => {
  assert.equal(inviterName(invite()), "@morwen");
  assert.equal(inviterName(invite({ from: { name: "Morwen Ashby", handle: null } })), "Morwen Ashby");
  assert.equal(inviterName(invite({ from: { name: "  " } })), null);
  assert.equal(inviterName(invite({ from: null })), null);
  assert.equal(inviterName(null), null);
});

const member = (over: Partial<Member>): Member => ({ _id: crypto.randomUUID(), status: "Player", isActive: true, ...over });

test("a seat means an active place in the party; the party unread means none", () => {
  const party = [member({ playerId: GM, status: "Game Master" }), member({ playerId: ME })];
  assert.equal(hasSeat(party, ME), true);
  assert.equal(hasSeat([member({ playerId: GM }), member({ playerId: ME, isActive: false })], ME), false);
  assert.equal(hasSeat([member({ playerId: GM })], ME), false);
  assert.equal(hasSeat(null, ME), false);
  assert.equal(hasSeat(party, null), false);
});

test("the party's size counts active people, and says nothing when it can't be read", () => {
  assert.equal(partyCount([member({ playerId: GM }), member({ playerId: ME })]), "2 at the table");
  assert.equal(partyCount([member({ playerId: GM }), member({ playerId: ME, isActive: false }), member({ playerId: null })]), "1 at the table");
  assert.equal(partyCount([]), null);
  assert.equal(partyCount(null), null);
});

test("signing in or up from an invite comes back to it", () => {
  assert.equal(joinPath(C1), `/join/${C1}`);
  assert.equal(withReturn("/login", joinPath(C1)), `/login?redirect=${encodeURIComponent(`/join/${C1}`)}`);
  assert.equal(withReturn("/signup", joinPath(C1)), `/signup?redirect=${encodeURIComponent(`/join/${C1}`)}`);
  assert.equal(withReturn("/check-email", joinPath(C1)), `/check-email?redirect=${encodeURIComponent(`/join/${C1}`)}`);
});
