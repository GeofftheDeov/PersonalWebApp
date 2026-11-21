/**
 * A session's page (#226, spec #69): where the session stands (before, after
 * or cancelled), which tabs it has and which one it opens on for the viewer,
 * the previous and next sessions in its campaign, and how its night reads.
 *
 *   cd hearthside && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canWritePrepNotes, defaultTab, nightLine, sessionNeighbours, sessionPhase, sessionTabs, taleParagraphs, whenFromNow,
} from "../src/lib/sessionPage";

const HOUR = 3_600_000;
const NOW = new Date(2026, 10, 10, 12, 0); // Tue Nov 10 2026, noon, local time
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

test("a session is before until it ends, then after; cancelled is its own", () => {
  assert.equal(sessionPhase({ status: "planning", date: null }, NOW), "before");
  assert.equal(sessionPhase({ status: "scheduled", date: null }, NOW), "before");
  assert.equal(sessionPhase({ status: "scheduled", date: at(HOUR), endDate: at(4 * HOUR) }, NOW), "before");
  // Started but not over: still before (the GM is running it from their prep notes).
  assert.equal(sessionPhase({ status: "scheduled", date: at(-HOUR), endDate: at(2 * HOUR) }, NOW), "before");
  assert.equal(sessionPhase({ status: "scheduled", date: at(-5 * HOUR), endDate: at(-HOUR) }, NOW), "after");
  // No end time: over four hours after it starts, as the backend counts it.
  assert.equal(sessionPhase({ status: "scheduled", date: at(-3 * HOUR) }, NOW), "before");
  assert.equal(sessionPhase({ status: "scheduled", date: at(-5 * HOUR) }, NOW), "after");
  assert.equal(sessionPhase({ status: "completed", date: at(HOUR) }, NOW), "after");
  assert.equal(sessionPhase({ status: "cancelled", date: at(-48 * HOUR) }, NOW), "cancelled");
});

test("Prep notes are there only for those the server sent the agenda to", () => {
  assert.equal(canWritePrepNotes({ agenda: null }), true);
  assert.equal(canWritePrepNotes({ agenda: "Handout 3" }), true);
  assert.equal(canWritePrepNotes({}), false);
});

test("the tabs: The tale and Details for everyone, Prep notes for the GM; cancelled keeps only Details", () => {
  assert.deepEqual(sessionTabs("before", false), ["tale", "details"]);
  assert.deepEqual(sessionTabs("after", false), ["tale", "details"]);
  assert.deepEqual(sessionTabs("before", true), ["tale", "details", "prep"]);
  assert.deepEqual(sessionTabs("cancelled", false), ["details"]);
  assert.deepEqual(sessionTabs("cancelled", true), ["details", "prep"]);
});

test("the default tab: the GM on Prep notes before and Details after; a player on Details before and The tale after", () => {
  assert.equal(defaultTab("before", true), "prep");
  assert.equal(defaultTab("after", true), "details");
  assert.equal(defaultTab("before", false), "details");
  assert.equal(defaultTab("after", false), "tale");
  assert.equal(defaultTab("cancelled", true), "details");
  assert.equal(defaultTab("cancelled", false), "details");
});

test("previous and next walk the campaign's sessions by night, undated ones last", () => {
  const list = [
    { _id: "c", date: at(48 * HOUR), createdAt: at(-10 * HOUR), title: "Third" },
    { _id: "plan", date: null, createdAt: at(-HOUR), title: "" },
    { _id: "a", date: at(-96 * HOUR), createdAt: at(-200 * HOUR), title: "First" },
    { _id: "b", date: at(-48 * HOUR), createdAt: at(-100 * HOUR), title: "Second" },
    { _id: "plan0", date: null, createdAt: at(-2 * HOUR), title: "Being planned" },
  ];
  const first = sessionNeighbours(list, "a");
  assert.equal(first.number, 1);
  assert.equal(first.prev, null);
  assert.deepEqual(first.next, { id: "b", title: "Second" });

  const mid = sessionNeighbours(list, "c");
  assert.equal(mid.number, 3);
  assert.deepEqual(mid.prev, { id: "b", title: "Second" });
  assert.deepEqual(mid.next, { id: "plan0", title: "Being planned" });

  // An untitled session is called by its number.
  const last = sessionNeighbours(list, "plan");
  assert.equal(last.number, 5);
  assert.deepEqual(last.prev, { id: "plan0", title: "Being planned" });
  assert.equal(last.next, null);
  assert.deepEqual(sessionNeighbours(list, "plan0").next, { id: "plan", title: "Session 5" });
});

test("a session missing from the list has no neighbours or number", () => {
  assert.deepEqual(sessionNeighbours([{ id: "x", date: null, title: "X" }], "y"), { number: null, prev: null, next: null });
});

test("the night reads as a long day and a time span", () => {
  const start = new Date(2026, 10, 3, 19, 30), end = new Date(2026, 10, 3, 23, 0);
  assert.equal(nightLine(start.toISOString(), end.toISOString()), "Tuesday, November 3, 2026 · 7:30–11 pm");
  assert.equal(nightLine(new Date(2026, 10, 3, 11, 0).toISOString(), new Date(2026, 10, 3, 14, 15).toISOString()),
    "Tuesday, November 3, 2026 · 11 am–2:15 pm");
  assert.equal(nightLine(start.toISOString(), null), "Tuesday, November 3, 2026 · 7:30 pm");
  assert.equal(nightLine(null, null), "No night yet");
});

test("how far off it is, in days", () => {
  assert.equal(whenFromNow(new Date(2026, 10, 10, 19).toISOString(), NOW), "Tonight");
  assert.equal(whenFromNow(new Date(2026, 10, 11, 19).toISOString(), NOW), "Tomorrow");
  assert.equal(whenFromNow(new Date(2026, 10, 14, 19).toISOString(), NOW), "Saturday");
  assert.equal(whenFromNow(new Date(2026, 10, 19, 19).toISOString(), NOW), "Next Thursday");
  assert.equal(whenFromNow(new Date(2026, 10, 30, 19).toISOString(), NOW), "In 20 days");
});

test("the tale's paragraphs are split on blank lines", () => {
  assert.deepEqual(taleParagraphs("One.\nStill one.\n\n  \nTwo.\n\n"), ["One.\nStill one.", "Two."]);
  assert.deepEqual(taleParagraphs("   "), []);
  assert.deepEqual(taleParagraphs(null), []);
});
