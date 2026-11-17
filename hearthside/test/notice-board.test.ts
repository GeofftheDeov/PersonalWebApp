/**
 * The Notice Board (#222, spec #69): which sessions being planned go on the
 * Hearth, and in what order; each sheet's numbered steps, its seal and its
 * vote tally; and the Hearth's greeting.
 *
 *   cd hearthside && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  boardSheets, greeting, hearthLine, needsMyVote, optionWhen, placeLine, plannerSteps, sheetSeal, voteTally, waitingOn,
  type Board, type PlanningState, type Poll,
} from "../src/lib/noticeBoard";

const ME = "me";
const GM = "gm";
const ISOLDE = "isolde";
const PARTY = [{ id: GM, name: "Morwen Ashby" }, { id: ME, name: "Tobin Reed" }, { id: ISOLDE, name: "Isolde Varga" }];

function poll(over: Partial<Poll> = {}): Poll {
  return {
    id: "p1", kind: "night", round: 1, status: "open", result: null, closedReason: null, quorum: 2,
    eligibleIds: [GM, ME, ISOLDE], voted: [], winningOptionId: null, tiedOptionIds: [],
    options: [
      { id: "a", start: "2026-11-20T19:00:00", end: "2026-11-20T23:00:00", venueId: null, suggestedBy: null, approvals: [], meetsQuorum: false },
      { id: "b", start: "2026-11-21T19:00:00", end: "2026-11-21T23:00:00", venueId: null, suggestedBy: null, approvals: [], meetsQuorum: false },
    ],
    ...over,
  };
}

function planning(over: { session?: Partial<PlanningState["session"]>; viewer?: Partial<PlanningState["viewer"]> } & Partial<Omit<PlanningState, "session" | "viewer">> = {}): PlanningState {
  const { session, viewer, ...rest } = over;
  return {
    session: {
      id: "s1", campaignId: "c1", title: "The Drowned Chapel", status: "planning", stage: "night", isOnline: true,
      foodMode: null, foodOwnerId: null, date: null, endDate: null, location: null, venue: null, hostId: null, gmOverride: null,
      ...session,
    },
    campaign: { id: "c1", title: "The Sunken Lantern", gmTitle: "Game Master", quorum: null, tableLink: null, gameMasterIds: [GM] },
    party: PARTY,
    quorum: 3,
    viewer: { id: ME, isGameMaster: false, canPassTorch: false, ...viewer },
    night: null, nightRounds: [], venue: null, venueRounds: [], venues: [], food: null,
    ...rest,
  };
}

const board = (...states: PlanningState[]): Board => ({ canPlan: false, gmTitle: "Game Master", party: PARTY, planning: states, upcoming: [] });

test("a session needs my vote while its step's vote is open, I'm on it, and I haven't voted", () => {
  assert.equal(needsMyVote(planning()), false, "no vote open yet");
  assert.equal(needsMyVote(planning({ night: poll() })), true);
  assert.equal(needsMyVote(planning({ night: poll({ voted: [ME] }) })), false);
  assert.equal(needsMyVote(planning({ night: poll({ eligibleIds: [GM, ISOLDE] }) })), false, "joined after it opened");
  assert.equal(needsMyVote(planning({ night: poll({ status: "closed", result: "tie" }) })), false);
  // On the venue step, the venue vote counts, not the old night round.
  const venueStep = { session: { stage: "venue" as const, isOnline: false, foodMode: "potluck" as const } };
  assert.equal(needsMyVote(planning({ ...venueStep, night: poll({ status: "closed" }), venue: poll({ kind: "venue" }) })), true);
  assert.equal(needsMyVote(planning({ ...venueStep, night: poll(), venue: null })), false);
});

test("the Hearth shows the sessions being planned in my campaigns, the ones waiting on my vote first", () => {
  const voted = planning({ session: { id: "voted" }, night: poll({ voted: [ME] }) });
  const waiting = planning({ session: { id: "waiting" }, night: poll() });
  const quiet = planning({ session: { id: "quiet" } });
  const other = planning({ session: { id: "other", campaignId: "c2" }, night: poll() });
  assert.deepEqual(boardSheets([board(voted, waiting), null, board(quiet, other)]).map((s) => s.session.id),
    ["waiting", "other", "voted", "quiet"]);
});

test("an admin outside the party doesn't get its sessions on their Hearth; a stand-in does", () => {
  const notMine = planning({ session: { id: "theirs" }, party: PARTY.filter((p) => p.id !== ME), viewer: { isGameMaster: true } });
  const standIn = planning({
    session: { id: "stand-in", gmOverride: { id: ME, name: "Tobin Reed" } },
    party: PARTY.filter((p) => p.id !== ME),
  });
  assert.deepEqual(boardSheets([board(notMine, standIn)]).map((s) => s.session.id), ["stand-in"]);
});

test("online: one step, the night", () => {
  assert.deepEqual(plannerSteps(planning()), [{ key: "night", n: 1, title: "Pick the night", state: "live" }]);
});

test("in person: the night, the venue, then the food, each live in turn", () => {
  const inPerson = { isOnline: false, foodMode: "potluck" as const };
  const at = (stage: "night" | "venue" | "food", venue = stage === "food") => plannerSteps(planning({
    session: { ...inPerson, stage, venue: venue ? { id: "v", name: "The Rusty Anchor", kind: "store", hostId: null, address: null, lastUsedAt: null } : null },
  })).map((s) => `${s.n} ${s.title}: ${s.state}`);
  assert.deepEqual(at("night"), ["1 Pick the night: live", "2 The venue: later", "3 Food: later"]);
  assert.deepEqual(at("venue"), ["1 The night: done", "2 Pick the venue: live", "3 Food: later"]);
  assert.deepEqual(at("food"), ["1 The night: done", "2 The venue: done", "3 Sort the food: live"]);
  // A scheduled session's night being changed (#87) keeps its venue; no venue vote or food step follows.
  assert.deepEqual(at("night", true), ["1 Pick the night: live", "2 The venue: done"]);
  // Without a food mode (kicked off before #93), there's no food step.
  assert.deepEqual(plannerSteps(planning({ session: { isOnline: false, stage: "venue" } })).map((s) => s.key), ["night", "venue"]);
});

test("the seal says where the session stands", () => {
  assert.deepEqual(sheetSeal(planning({ night: poll({ voted: [GM] }) })), { label: "Awaiting votes · 1 of 3", tone: "vote" });
  assert.deepEqual(sheetSeal(planning({ night: poll({ status: "closed", result: "tie" }) })), { label: "Tie · the Game Master decides", tone: "tie" });
  assert.deepEqual(sheetSeal(planning()), { label: "Waiting on the Game Master", tone: "wait" });
  assert.deepEqual(sheetSeal(planning({ viewer: { isGameMaster: true } })), { label: "Pick some nights", tone: "wait" });
  assert.deepEqual(sheetSeal(planning({ night: poll({ status: "closed", result: "no_quorum" }), viewer: { isGameMaster: true } })),
    { label: "Pick some nights", tone: "wait" });
  const venue = { session: { stage: "venue" as const, isOnline: false } };
  assert.deepEqual(sheetSeal(planning({ ...venue, venue: poll({ kind: "venue", voted: [ME, GM] }) })), { label: "Pick the venue · 2 of 3", tone: "vote" });
  const food = (quests: { assignee: { id: string; name: string } | null }[], gm = false) => sheetSeal(planning({
    session: { stage: "food", isOnline: false, foodMode: "potluck" },
    viewer: { isGameMaster: gm },
    food: { mode: "potluck", ownerId: null, quests: quests.map((q, i) => ({ id: `q${i}`, title: "Snacks", notes: null, status: "open" as const, dueAt: null, createdBy: GM, ...q })) },
  }));
  assert.deepEqual(food([{ assignee: null }, { assignee: PARTY[1] }]), { label: "Food · 1 unclaimed", tone: "tie" });
  assert.deepEqual(food([{ assignee: PARTY[1] }]), { label: "Food · waiting on the Game Master", tone: "wait" });
  assert.deepEqual(food([{ assignee: PARTY[1] }], true), { label: "Confirm the food", tone: "wait" });
});

test("the tally: approvals out of the voters, who they are, and the leaders marked", () => {
  const p = poll({
    options: [
      { ...poll().options[0], approvals: [GM, ME], meetsQuorum: true },
      { ...poll().options[1], approvals: [ISOLDE], meetsQuorum: false },
    ],
  });
  const name = (id: string) => PARTY.find((m) => m.id === id)?.name ?? "someone";
  assert.deepEqual(voteTally(p, name, ME), [
    { id: "a", count: 2, of: 3, share: 2 / 3, lead: true, mine: true, meetsQuorum: true, voters: ["Morwen Ashby", "Tobin Reed"] },
    { id: "b", count: 1, of: 3, share: 1 / 3, lead: false, mine: false, meetsQuorum: false, voters: ["Isolde Varga"] },
  ]);
  // Nobody has voted: nobody leads.
  assert.ok(voteTally(poll(), name, ME).every((r) => !r.lead && r.count === 0 && r.share === 0));
  // A tie leads together.
  const tied = poll({ options: poll().options.map((o) => ({ ...o, approvals: [GM] })) });
  assert.deepEqual(voteTally(tied, name, ME).map((r) => r.lead), [true, true]);
  // No one eligible (a party of none) doesn't divide by zero.
  assert.equal(voteTally(poll({ eligibleIds: [] }), name, ME)[0].share, 0);
});

test("waiting on: who can vote and hasn't", () => {
  assert.deepEqual(waitingOn(poll({ voted: [GM] })), [ME, ISOLDE]);
  assert.deepEqual(waitingOn(null), []);
});

test("a night on the vote reads short: weekday, date and its hours", () => {
  assert.equal(optionWhen("2026-11-20T19:00:00", "2026-11-20T23:00:00"), "Fri, Nov 20 · 7–11 pm");
  assert.equal(optionWhen("2026-11-21T11:30:00", "2026-11-21T14:00:00"), "Sat, Nov 21 · 11:30 am–2 pm");
  assert.equal(optionWhen("2026-11-21T19:00:00", null), "Sat, Nov 21 · 7 pm");
});

test("where the session will be, on its sheet", () => {
  const name = (id: string) => PARTY.find((m) => m.id === id)?.name ?? "someone";
  assert.equal(placeLine(planning(), name), "Online");
  assert.equal(placeLine(planning({ session: { isOnline: false, foodMode: "potluck" } }), name), "In person · potluck");
  assert.equal(placeLine(planning({
    session: { isOnline: false, foodMode: "provided", foodOwnerId: ISOLDE, venue: { id: "v", name: "The Rusty Anchor", kind: "store", hostId: null, address: null, lastUsedAt: null } },
  }), name), "In person · The Rusty Anchor · food by Isolde Varga");
  assert.equal(placeLine(planning({ session: { isOnline: false, foodMode: "provided", foodOwnerId: ME } }), name), "In person · food by you");
});

test("the greeting: the time of day and the person's first name", () => {
  const at = (h: number) => new Date(2026, 10, 13, h, 0);
  assert.equal(greeting(at(9), { name: "Tobin Reed" }), "Good morning, Tobin");
  assert.equal(greeting(at(14), { name: "Tobin Reed", firstName: "Toby" }), "Good afternoon, Toby");
  assert.equal(greeting(at(20), { name: "Tobin Reed" }), "Good evening, Tobin");
  assert.equal(greeting(at(2), { name: "Tobin Reed" }), "Good evening, Tobin");
  assert.equal(greeting(at(20), null), "Good evening");
  assert.equal(greeting(at(20), { name: "  " }), "Good evening");
});

test("the line under the greeting counts what's pinned up and what waits on you", () => {
  assert.equal(hearthLine([]), "Nothing’s pinned to the Notice Board.");
  assert.equal(hearthLine([planning()]), "One session is being planned.");
  assert.equal(hearthLine([planning(), planning()]), "2 sessions are being planned.");
  assert.equal(hearthLine([planning({ night: poll() })]), "One session needs your vote.");
  assert.equal(hearthLine([planning({ night: poll() }), planning(), planning({ night: poll() })]), "3 sessions are being planned, and 2 need your vote.");
  assert.equal(hearthLine([planning({ night: poll() }), planning()]), "2 sessions are being planned, and one needs your vote.");
});
