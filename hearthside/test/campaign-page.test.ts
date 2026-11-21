/**
 * A campaign's page, part 1 (#224, spec #69): who the party is and what each
 * viewer may do to it (make inactive, remove, leave), the torch (pass, claim,
 * who steps down), the details as the page states them, the edit form's
 * fields and what it sends, and every confirmation's words.
 *
 *   cd hearthside && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GM_TITLE,
  campaignFacts,
  campaignForm,
  claimQuestion,
  formPayload,
  gmTitleOf,
  inactiveQuestion,
  inviteLink,
  leaveQuestion,
  memberName,
  partyLine,
  partyView,
  removeQuestion,
  roleLine,
  torchPassQuestion,
  type CampaignDetail,
  type Member,
} from "../src/lib/campaignPage";

const GM = "aaaaaaaa-0000-4000-8000-000000000001";
const P1 = "aaaaaaaa-0000-4000-8000-000000000002";
const P2 = "aaaaaaaa-0000-4000-8000-000000000003";
const OUT = "aaaaaaaa-0000-4000-8000-000000000009";

const campaign = (over: Partial<CampaignDetail> = {}): CampaignDetail => ({
  _id: "c1",
  title: "Curse of the Ashen Crown",
  description: "The old king's crown woke the dead.",
  status: "In Progress",
  startDate: "2026-03-14T00:00:00.000Z",
  endDate: null,
  owner: GM,
  bannerKey: null,
  bannerUrl: null,
  createdAt: "2026-03-01T12:00:00.000Z",
  gmTitle: "Dungeon Master",
  quorum: null,
  tableLink: null,
  discordGuildId: null,
  discordChannelId: null,
  ...over,
});

const member = (id: string, playerId: string | null, name: string, over: Partial<Member> = {}): Member => ({
  _id: id, playerId, status: "Player", isActive: true, person: playerId ? { handle: name } : null, ...over,
});

const party = (): Member[] => [
  member("m1", GM, "geoff", { status: "Game Master" }),
  member("m2", P1, "priya"),
  member("m3", P2, "marcus"),
  member("m4", null, "", { status: "Invited", person: null, email: "bea@example.com" }),
  member("m5", "aaaaaaaa-0000-4000-8000-000000000005", "jordan", { isActive: false }),
];

const user = (id: string) => ({ id, email: null });
const player = { appRole: "user" as const };
const admin = { appRole: "admin" as const };

test("a member is called by their handle, then name, then first and last, never a whole email", () => {
  assert.equal(memberName({ person: { handle: "priya", name: "Priya Shah" } }), "priya");
  assert.equal(memberName({ person: { name: "Priya Shah" } }), "Priya Shah");
  assert.equal(memberName({ person: { firstName: "Priya", lastName: "Shah" } }), "Priya Shah");
  assert.equal(memberName({ person: null, firstName: "Bea", lastName: "Lin" }), "Bea Lin");
  assert.equal(memberName({ person: null, email: "bea@example.com" }), "bea");
  assert.equal(memberName({}), "Unknown Player");
});

test("the Game Master's title is the campaign's own, or Dungeon Master", () => {
  assert.equal(gmTitleOf(campaign({ gmTitle: "Host" })), "Host");
  assert.equal(gmTitleOf(campaign({ gmTitle: null })), DEFAULT_GM_TITLE);
  assert.equal(DEFAULT_GM_TITLE, "Dungeon Master");
});

test("a row's role line names the GM by the campaign's title, and the owner", () => {
  const c = campaign({ gmTitle: "Host" });
  const [gm, p1, , invited] = party();
  assert.equal(roleLine(gm, c), "Host · Owner");
  assert.equal(roleLine(p1, c), "");
  assert.equal(roleLine(p1, campaign({ owner: P1 })), "Owner");
  assert.equal(roleLine(invited, c), "Invited");
});

test("the heading's line counts the active party with accounts and names the GM", () => {
  const view = partyView(campaign(), party(), user(P1), player);
  assert.equal(partyLine(campaign(), view), "3 in the party · geoff is Dungeon Master");
  const two = partyView(campaign(), [...party(), member("m6", "aaaaaaaa-0000-4000-8000-000000000006", "priya2", { status: "Game Master" })], user(P1), player);
  assert.equal(partyLine(campaign(), two), "4 in the party · geoff, priya2 are Dungeon Master");
  const none = partyView(campaign({ owner: null }), party().map((m) => ({ ...m, status: m.status === "Game Master" ? "Player" : m.status })), user(P1), player);
  assert.equal(partyLine(campaign({ owner: null }), none), "3 in the party · no Dungeon Master yet");
  const alone = partyView(campaign(), [member("m1", GM, "geoff", { status: "Game Master" })], user(GM), player);
  assert.equal(partyLine(campaign(), alone), "1 in the party · geoff is Dungeon Master");
});

test("the GM sees the inactive list and can make players inactive and remove them, but not another GM", () => {
  const v = partyView(campaign(), party(), user(GM), player);
  assert.equal(v.isGM, true);
  assert.equal(v.isOwner, true);
  assert.deepEqual(v.active.map((m) => m._id), ["m1", "m2", "m3", "m4"]);
  assert.deepEqual(v.inactive.map((m) => m._id), ["m5"]);
  const [gm, p1, , invited, gone] = party();
  assert.equal(v.canDeactivate(p1), true);
  assert.equal(v.canDeactivate(gm), false);
  // An invite with no account yet can't be made inactive, but can be taken back.
  assert.equal(v.canDeactivate(invited), false);
  assert.equal(v.canRemove(invited), true);
  assert.equal(v.canRemove(p1), true);
  assert.equal(v.canRemove(gone), true);
  assert.equal(v.canRemove(gm), false);
  assert.equal(v.canRemove(member("m9", "x", "co-gm", { status: "Game Master" })), false);
});

test("a player can do nothing to anyone else, and can leave", () => {
  const v = partyView(campaign(), party().filter((m) => m.isActive !== false), user(P1), player);
  assert.equal(v.isGM, false);
  assert.equal(v.isOwner, false);
  for (const m of party()) {
    assert.equal(v.canDeactivate(m), false);
    assert.equal(v.canRemove(m), false);
  }
  assert.equal(v.mine?._id, "m2");
  assert.equal(v.isLastGm, false);
});

test("an admin outside the party can remove anyone, GMs too, and isn't a member", () => {
  const v = partyView(campaign(), party(), user(OUT), admin);
  assert.equal(v.isGM, true);
  assert.equal(v.isOwner, true);
  assert.equal(v.mine, null);
  assert.equal(v.canRemove(party()[0]), true);
});

test("the only GM must pass the torch before leaving anyone behind; alone, they may leave", () => {
  assert.equal(partyView(campaign(), party(), user(GM), player).isLastGm, true);
  const alone = [member("m1", GM, "geoff", { status: "Game Master" })];
  assert.equal(partyView(campaign(), alone, user(GM), player).isLastGm, false);
  const twoGms = [...party(), member("m6", "aaaaaaaa-0000-4000-8000-000000000006", "wren", { status: "Game Master" })];
  assert.equal(partyView(campaign(), twoGms, user(GM), player).isLastGm, false);
});

test("the torch passes to an active party member with an account who isn't a GM", () => {
  const v = partyView(campaign(), party(), user(GM), player);
  assert.deepEqual(v.torchCandidates.map((m) => m._id), ["m2", "m3"]);
  assert.equal(v.torchNeedsFrom, false);
  assert.equal(v.canPassTorch, true);
  // A player sees no Pass the torch.
  assert.equal(partyView(campaign(), party(), user(P1), player).canPassTorch, false);
});

test("an admin who isn't a GM names who steps down when there's more than one GM", () => {
  const twoGms = [...party().slice(0, 2), member("m3", P2, "marcus", { status: "Game Master" })];
  const v = partyView(campaign(), twoGms, user(OUT), admin);
  assert.equal(v.torchNeedsFrom, true);
  assert.deepEqual(v.gameMasters.map((m) => m._id), ["m1", "m3"]);
  // A GM passing it steps down themselves, so never names anyone.
  assert.equal(partyView(campaign(), twoGms, user(GM), player).torchNeedsFrom, false);
});

test("a player of an admin-managed campaign with no GM may claim the torch; nobody else may", () => {
  const noGm = party().map((m) => (m.status === "Game Master" ? { ...m, status: "Player" } : m));
  const open = campaign({ owner: null });
  assert.equal(partyView(open, noGm, user(P1), player).canClaimTorch, true);
  // Owned, or someone holds it, or not in the party, or an admin (who passes it instead): no.
  assert.equal(partyView(campaign({ owner: P2 }), noGm, user(P1), player).canClaimTorch, false);
  assert.equal(partyView(open, party(), user(P1), player).canClaimTorch, false);
  assert.equal(partyView(open, noGm, user(OUT), player).canClaimTorch, false);
  assert.equal(partyView(open, noGm, user(OUT), admin).canClaimTorch, false);
});

test("passing the torch says who steps down and whether ownership moves", () => {
  const c = campaign();
  const [gm, p1] = party();
  assert.equal(
    torchPassQuestion(c, { to: p1, from: gm, viewerIsGm: true }),
    "Pass the torch to priya? They become the Dungeon Master and you become a player. Ownership doesn’t change.",
  );
  assert.equal(
    torchPassQuestion(campaign({ owner: null, gmTitle: "Host" }), { to: p1, from: gm, viewerIsGm: false }),
    "Pass the torch to priya? They become the Host and geoff becomes a player. They become its owner, too.",
  );
  assert.equal(
    torchPassQuestion(campaign({ owner: null }), { to: p1, from: null, viewerIsGm: false }),
    "Pass the torch to priya? They become the Dungeon Master and no one steps down. They become its owner, too.",
  );
});

test("each confirmation names the campaign and what happens", () => {
  const c = campaign();
  const p1 = party()[1];
  assert.equal(claimQuestion(c), "You become the Dungeon Master and owner of Curse of the Ashen Crown, and plan its sessions.");
  assert.equal(leaveQuestion(c), "You’ll need the invite link to rejoin Curse of the Ashen Crown.");
  assert.equal(removeQuestion(c, p1), "priya leaves Curse of the Ashen Crown.");
  assert.equal(
    inactiveQuestion(p1),
    "The campaign leaves priya’s list and they can’t read or post in Table Talk. Their characters and history stay, and you can bring them back.",
  );
});

test("the details state the dates in UTC, the GM title, quorum, table and Discord", () => {
  const facts = campaignFacts(campaign({
    endDate: "2026-09-01T00:00:00.000Z", quorum: 3, tableLink: "https://foundry.example/ashen",
    discordGuildId: "123", discordChannelId: "456",
  }));
  assert.equal(facts.started, "March 14, 2026");
  assert.equal(facts.ended, "September 1, 2026");
  assert.equal(facts.quorum, "3 of the party");
  assert.equal(facts.table, "foundry.example/ashen");
  assert.equal(facts.discord, "Linked (voice channel)");

  const bare = campaignFacts(campaign({ startDate: null }));
  assert.equal(bare.started, null);
  assert.equal(bare.ended, null);
  assert.equal(bare.quorum, "Whole party");
  assert.equal(bare.table, null);
  assert.equal(bare.discord, "Not linked");
  assert.equal(campaignFacts(campaign({ discordGuildId: "123" })).discord, "Linked");
});

test("the edit form starts from the campaign, and sends details and the owner's settings apart", () => {
  const c = campaign({ quorum: 3, tableLink: "https://t.example", gmTitle: "Host", discordGuildId: "123" });
  const form = campaignForm(c);
  assert.deepEqual(form, {
    title: "Curse of the Ashen Crown",
    description: "The old king's crown woke the dead.",
    status: "In Progress",
    startDate: "2026-03-14",
    endDate: "",
    discordGuildId: "123",
    discordChannelId: "",
    quorum: "3",
    tableLink: "https://t.example",
    gmTitle: "Host",
  });
  assert.equal(campaignForm(campaign({ gmTitle: null })).gmTitle, "Dungeon Master");

  const { details, settings } = formPayload({ ...form, title: "  New title ", quorum: "", tableLink: " https://x.example ", discordGuildId: " 9 " });
  assert.deepEqual(details, {
    title: "New title", description: "The old king's crown woke the dead.", status: "In Progress",
    startDate: "2026-03-14", endDate: null, discordGuildId: "9", discordChannelId: "",
  });
  assert.deepEqual(settings, { quorum: null, tableLink: "https://x.example", gmTitle: "Host" });
  assert.equal(formPayload({ ...form, quorum: "4" }).settings.quorum, 4);
});

test("the invite link is Hearthside's own invite page", () => {
  assert.equal(inviteLink("https://hearthside.geoffthedeov.net", "c1"), "https://hearthside.geoffthedeov.net/join/c1");
});
