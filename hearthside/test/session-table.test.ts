/**
 * A session's round table (#227, spec #69): who sits where, which adventurer
 * a seat shows, how attendance and the ready check mark the seats, who may
 * tick or add quests, and what the card in the middle shows.
 *
 *   cd hearthside && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adventurerOf, attendanceDraft, canAddQuests, canTick, countdown, headOf, middleCard, readyTally,
  recordingUrl, seatMark, seatPositions, slipsBySeat, tableSeats, type Attendance, type CampaignCharacter,
} from "../src/lib/sessionTable";
import type { Quest } from "../src/lib/quests";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 10, 10, 12, 0); // Tue Nov 10 2026, noon, local time
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

const party = [
  { id: "p1", name: "Avery" },
  { id: "p2", name: "Kestrel" },
  { id: "p3", name: "Juno" },
];

const character = (id: string, playerId: string, extra: Partial<CampaignCharacter> = {}): CampaignCharacter =>
  ({ _id: id, name: `Hero ${id}`, player: { _id: playerId, name: "x" }, isDead: false, ...extra });

test("the head of the table is the stand-in when there is one, else the campaign's GM", () => {
  assert.equal(headOf(party, ["p1"], null), "p1");
  assert.equal(headOf(party, ["p1"], "p3"), "p3");
  // Several GMs: the first in the party's order.
  assert.equal(headOf(party, ["p3", "p2"], null), "p2");
  // A GM who isn't in the party (an admin) leaves the head empty.
  assert.equal(headOf(party, ["zz"], null), null);
  // A stand-in who has left the party falls back to the GM.
  assert.equal(headOf(party, ["p1"], "gone"), "p1");
});

test("a seat shows the player's adventurer only when they have exactly one who hasn't fallen", () => {
  const chars = [
    character("c1", "p2"),
    character("c2", "p3"), character("c3", "p3"),
    character("c4", "p1", { isDead: true }), character("c5", "p1"),
  ];
  assert.equal(adventurerOf(chars, "p2")?.name, "Hero c1");
  assert.equal(adventurerOf(chars, "p3"), null, "two living adventurers: show the player");
  assert.equal(adventurerOf(chars, "p1")?.name, "Hero c5", "a fallen one doesn't count");
  assert.equal(adventurerOf([character("c6", "p2", { isDead: true })], "p2"), null);
  assert.equal(adventurerOf(null, "p2"), null);
  // The player may come as a bare id.
  assert.equal(adventurerOf([{ _id: "c7", name: "Brass", player: "p2" } as CampaignCharacter], "p2")?.name, "Brass");
});

test("the head sits first, the rest in the party's order, each with their adventurer", () => {
  const seats = tableSeats(party, "p2", [character("c1", "p3")]);
  assert.deepEqual(seats.map((s) => [s.personId, s.head, s.adventurer]), [
    ["p2", true, null],
    ["p1", false, null],
    ["p3", false, "Hero c1"],
  ]);
  // No head: everyone sits round the table.
  assert.deepEqual(tableSeats(party, null, null).map((s) => s.head), [false, false, false]);
  // The GM at the head shows as themself, not as an adventurer.
  assert.equal(tableSeats(party, "p3", [character("c1", "p3")])[0].adventurer, null);
});

test("seats go evenly round the table, the head at the top, inside its edges", () => {
  const four = seatPositions(4);
  assert.deepEqual(four[0], { x: 50, y: 12 });
  assert.deepEqual(four[1], { x: 88, y: 50 });
  assert.deepEqual(four[2], { x: 50, y: 88 });
  assert.deepEqual(four[3], { x: 12, y: 50 });
  for (const n of [1, 2, 3, 5, 6, 7, 9]) {
    for (const p of seatPositions(n)) assert.ok(p.x >= 12 && p.x <= 88 && p.y >= 12 && p.y <= 88, `${n} seats: ${p.x},${p.y}`);
  }
});

const readyCheck = { sentAt: at(-30 * MIN), responses: [
  { playerId: "p2", name: "Kestrel", ready: true },
  { playerId: "p3", name: "Juno", ready: false },
] };

test("before attendance is confirmed, the ready check colours the seats", () => {
  assert.equal(seatMark("p2", { phase: "before", readyCheck }), "ready");
  assert.equal(seatMark("p3", { phase: "before", readyCheck }), "not-ready");
  assert.equal(seatMark("p1", { phase: "before", readyCheck }), null);
  assert.equal(seatMark("p2", { phase: "before", readyCheck: null }), null);
  // Still shown after the session until attendance is taken.
  assert.equal(seatMark("p2", { phase: "after", readyCheck, attendance: attendance(null, []) }), "ready");
  // A cancelled session has no one to be ready.
  assert.equal(seatMark("p2", { phase: "cancelled", readyCheck }), null);
});

function attendance(confirmedAt: string | null, attended: string[], ready: Record<string, boolean> = {}): Attendance {
  return {
    sessionId: "s", confirmedAt, confirmedBy: null, canConfirm: true, open: true,
    people: party.map((p) => ({ playerId: p.id, name: p.name, active: true, attended: attended.includes(p.id), ready: ready[p.id] ?? null })),
  };
}

test("once attendance is confirmed, whoever was away has a grey seat", () => {
  const a = attendance(at(-HOUR), ["p1", "p2"]);
  assert.equal(seatMark("p1", { phase: "after", readyCheck, attendance: a }), "came");
  assert.equal(seatMark("p2", { phase: "after", readyCheck, attendance: a }), "came");
  assert.equal(seatMark("p3", { phase: "after", readyCheck, attendance: a }), "away");
  // Nobody came: everyone's away.
  assert.equal(seatMark("p1", { phase: "after", attendance: attendance(at(-HOUR), []) }), "away");
});

test("while the GM takes attendance, the seats follow their taps", () => {
  const draft = new Set(["p3"]);
  assert.equal(seatMark("p3", { phase: "after", draft, attendance: attendance(at(-HOUR), ["p1"]) }), "came");
  assert.equal(seatMark("p1", { phase: "after", draft, attendance: attendance(at(-HOUR), ["p1"]) }), "away");
});

test("the GM's taps start from the record, or before it's taken from who said they were ready", () => {
  assert.deepEqual([...attendanceDraft(attendance(at(-HOUR), ["p1"], { p2: true }))], ["p1"]);
  assert.deepEqual([...attendanceDraft(attendance(null, ["p1"], { p2: true, p3: false }))].sort(), ["p1", "p2"]);
});

test("the ready tally counts the seats that said ready", () => {
  assert.deepEqual(readyTally(readyCheck, ["p1", "p2", "p3"]), { ready: 1, answered: 2, total: 3 });
  assert.deepEqual(readyTally(null, ["p1"]), { ready: 0, answered: 0, total: 1 });
});

const quest = (id: string, assigneeId: string | null, status: Quest["status"] = "open"): Quest => ({
  id, sessionId: "s", kind: "custom", title: `Quest ${id}`, notes: null,
  assignee: assigneeId ? { id: assigneeId, name: "x" } : null,
  dueAt: null, status, reminderOffsets: [], remindersSent: [], createdBy: null, createdAt: at(-DAY), completedAt: null,
  session: { id: "s", title: "S", date: at(DAY), endDate: null, status: "scheduled", campaign: { id: "c", title: "C" } },
});

test("each seat's slips are its player's quests; unowned ones sit at no seat", () => {
  const slips = slipsBySeat([quest("q1", "p2"), quest("q2", null), quest("q3", "p2"), quest("q4", "p1")]);
  assert.deepEqual(slips.get("p2")?.map((q) => q.id), ["q1", "q3"]);
  assert.deepEqual(slips.get("p1")?.map((q) => q.id), ["q4"]);
  assert.equal(slips.get("p3"), undefined);
});

test("players tick (and untick) their own quests, and the GM anyone's", () => {
  const me = { id: "p2", isGameMaster: false };
  assert.equal(canTick(quest("q1", "p2"), me), true);
  assert.equal(canTick(quest("q1", "p3"), me), false);
  assert.equal(canTick(quest("q1", "p3"), { id: "p1", isGameMaster: true }), true);
  assert.equal(canTick(quest("q1", "p2", "done"), me), true, "a done quest ticks back on");
  assert.equal(canTick(quest("q1", "p3", "done"), me), false);
  assert.equal(canTick(quest("q1", "p2", "cancelled"), me), false);
  assert.equal(canTick(quest("q1", "p2"), null), false);
});

test("the GM adds quests from the seats only before the session", () => {
  assert.equal(canAddQuests({ status: "scheduled" }, "before", true), true);
  assert.equal(canAddQuests({ status: "planning" }, "before", true), true);
  assert.equal(canAddQuests({ status: "scheduled" }, "before", false), false);
  assert.equal(canAddQuests({ status: "scheduled" }, "after", true), false);
  assert.equal(canAddQuests({ status: "cancelled" }, "cancelled", true), false);
});

test("the countdown reads in the two largest units", () => {
  assert.equal(countdown(at(3 * DAY + 4 * HOUR + 10 * MIN), NOW), "3 days, 4 hours");
  assert.equal(countdown(at(DAY), NOW), "1 day");
  assert.equal(countdown(at(4 * HOUR + 12 * MIN), NOW), "4 hours, 12 minutes");
  assert.equal(countdown(at(HOUR + 30_000), NOW), "1 hour");
  assert.equal(countdown(at(22 * MIN), NOW), "22 minutes");
  assert.equal(countdown(at(MIN), NOW), "1 minute");
  assert.equal(countdown(at(20_000), NOW), "under a minute");
});

test("the middle card: a countdown before, the recording or none after, and nothing to record when cancelled", () => {
  assert.deepEqual(middleCard({ status: "scheduled", date: at(2 * DAY + 3 * HOUR) }, "before", NOW),
    { kind: "countdown", when: "Thursday", left: "2 days, 3 hours" });
  assert.deepEqual(middleCard({ status: "planning", date: null }, "before", NOW), { kind: "unscheduled" });
  assert.deepEqual(middleCard({ status: "scheduled", date: at(-HOUR), endDate: at(2 * HOUR) }, "before", NOW), { kind: "under-way" });
  assert.deepEqual(middleCard({ status: "scheduled", date: at(-DAY), vodUrl: "https://youtu.be/x" }, "after", NOW),
    { kind: "recording", url: "https://youtu.be/x" });
  assert.deepEqual(middleCard({ status: "scheduled", date: at(-DAY), vodUrl: "" }, "after", NOW), { kind: "no-recording" });
  assert.deepEqual(middleCard({ status: "scheduled", date: at(-DAY), vodUrl: "javascript:alert(1)" }, "after", NOW), { kind: "no-recording" });
  assert.deepEqual(middleCard({ status: "cancelled", date: at(DAY) }, "cancelled", NOW), { kind: "cancelled" });
});

test("only a web link counts as a recording", () => {
  assert.equal(recordingUrl(" https://twitch.tv/v/1 "), "https://twitch.tv/v/1");
  assert.equal(recordingUrl("http://example.com/a"), "http://example.com/a");
  assert.equal(recordingUrl("javascript:alert(1)"), null);
  assert.equal(recordingUrl("www.example.com"), null);
  assert.equal(recordingUrl(null), null);
});
