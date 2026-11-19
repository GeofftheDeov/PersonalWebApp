/**
 * The overlap picker (#225, spec #69): the availability grid turned to days
 * across and start times down, the heat of each cell, the best times, and
 * the shortlist of two to four nights.
 *
 *   cd hearthside && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PICKS, bestTimes, fromDateInput, heatLevel, hourLabel, overlapGrid, overlapQuery, slotName, toDateInput, togglePick, whoLine,
  type Overlap, type Slot,
} from "../src/lib/overlap";

const HOUR = 3_600_000;
/** A slot `hours` long from a local time. */
function slot(start: Date, headcount: number, over: Partial<Slot> = {}, hours = 4): Slot {
  return {
    start: start.toISOString(), end: new Date(start.getTime() + hours * HOUR).toISOString(),
    headcount, meetsQuorum: headcount >= 2, free: [], busy: [], unknown: [], ...over,
  };
}
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m);
const overlap = (slots: Slot[]): Overlap => ({ quorum: 2, party: [{ id: "a", name: "Ada" }, { id: "b", name: "Bo" }, { id: "c", name: "Cy" }], slots });

test("the grid has a column per day and a row per start hour, from the earliest anyone is free to the latest", () => {
  const from = at(20, 0);
  const data = overlap([slot(at(20, 18), 2), slot(at(20, 18, 30), 3), slot(at(21, 20), 1), slot(at(22, 19), 0)]);
  const grid = overlapGrid(data, from, 3, at(19, 12));
  assert.deepEqual(grid.days.map((d) => [d.weekday, d.label]), [["Fri", "Nov 20"], ["Sat", "21"], ["Sun", "22"]]);
  assert.deepEqual(grid.hours, [18, 19, 20]);
  // cells[row][column]: 6 pm on Friday, 8 pm on Saturday; the half hour isn't a row.
  assert.equal(grid.cells[0][0]?.headcount, 2);
  assert.equal(grid.cells[2][1]?.headcount, 1);
  assert.equal(grid.cells[1][2]?.headcount, 0);
  assert.equal(grid.cells[0][1], null);
});

test("with nobody free, the grid shows the evening; times already past have no cell", () => {
  const data = overlap([slot(at(20, 18), 0), slot(at(21, 18), 0)]);
  const grid = overlapGrid(data, at(20, 0), 2, at(20, 19));
  assert.deepEqual(grid.hours, [17, 18, 19, 20, 21, 22]);
  assert.equal(grid.cells[1][0], null, "Friday 6 pm has passed");
  assert.ok(grid.cells[1][1], "Saturday 6 pm is still to come");
});

test("a month's first day carries its month in the column label", () => {
  const grid = overlapGrid(overlap([]), new Date(2026, 10, 29), 3, at(1, 0));
  assert.deepEqual(grid.days.map((d) => d.label), ["Nov 29", "30", "Dec 1"]);
});

test("the heat runs from nobody (0) through the party's share (1 to 4) to everyone (5)", () => {
  assert.deepEqual([0, 1, 2, 3, 4].map((n) => heatLevel(n, 4)), [0, 1, 2, 3, 5]);
  assert.equal(heatLevel(1, 5), 1);
  assert.equal(heatLevel(4, 5), 4);
  assert.equal(heatLevel(2, 0), 5);
});

test("the best times skip nobody-free, past and overlapping slots, and stop at six", () => {
  const now = at(20, 12);
  const slots = [
    slot(at(20, 10), 3), // past
    slot(at(20, 18), 3),
    slot(at(20, 19), 3), // overlaps 6 pm
    slot(at(21, 18), 0), // nobody
    ...[22, 23, 24, 25, 26, 27, 28].map((d) => slot(at(d, 18), 2)),
  ];
  const best = bestTimes(slots, now);
  assert.equal(best.length, 6);
  assert.equal(best[0].start, at(20, 18).toISOString());
  assert.ok(!best.some((s) => s.start === at(20, 19).toISOString()));
});

test("the shortlist stays in time order, unpicks on a second press, and holds four at most", () => {
  const nights = [24, 21, 23, 22, 25].map((d) => slot(at(d, 18), 2));
  let picked = nights.slice(0, 2).reduce((p, s) => togglePick(p, s), [] as { start: string; end: string }[]);
  assert.deepEqual(picked.map((p) => p.start), [at(21, 18), at(24, 18)].map((d) => d.toISOString()));
  picked = togglePick(picked, nights[0]);
  assert.deepEqual(picked.map((p) => p.start), [at(21, 18).toISOString()]);
  for (const s of nights) picked = togglePick(picked, s);
  // 21 came off again; the rest went on.
  assert.deepEqual(picked.map((p) => p.start), [22, 23, 24, 25].map((d) => at(d, 18).toISOString()));
  assert.equal(picked.length, MAX_PICKS);
  // A fifth doesn't go on.
  assert.deepEqual(togglePick(picked, slot(at(26, 18), 2)), picked);
});

test("names, labels and the query", () => {
  const s = slot(at(20, 19), 2, { busy: ["c"], unknown: ["x"] });
  assert.equal(whoLine(s, new Map([["c", "Cy"]])), "Busy: Cy · Unknown: someone");
  assert.equal(slotName(s, 3), "Fri, Nov 20 · 7–11 pm: 2 of 3 free");
  assert.deepEqual([hourLabel(0), hourLabel(9), hourLabel(12), hourLabel(19)], ["12 am", "9 am", "12 pm", "7 pm"]);
  assert.equal(toDateInput(at(5, 15)), "2026-11-05");
  assert.equal(fromDateInput("2026-11-05")?.getTime(), at(5, 0).getTime());
  assert.equal(fromDateInput("soon"), null);
  const q = new URLSearchParams(overlapQuery(at(20, 0), 14, 3));
  assert.equal(q.get("start"), at(20, 0).toISOString());
  assert.equal(q.get("end"), at(34, 0).toISOString());
  assert.equal(q.get("slotMinutes"), "180");
  assert.equal(q.get("stepMinutes"), "30");
});
