/**
 * The Almanac (#228, spec #69): what the list and the calendar show, which
 * day things sit on, the filters and their counts, and how reads merge.
 *
 *   cd hearthside && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NO_FILTER, addDays, almanacLists, applyFilter, campaignChoices, chronicleWeeks, covered, dayKey, filterCounts,
  firstDay, headLine, isFiltered, mergeRange, monthDays, placeLine, questsDueOn, sealOf, sessionDays, sessionsOn,
  timeOnDay, toggleCampaign, weekLabel, weekTitle, whenLine, withRail,
  type AlmanacSession,
} from "../src/lib/almanac";
import type { Quest } from "../src/lib/quests";

const HOUR = 3_600_000;
// Thu Nov 19 2026, noon, local time.
const NOW = new Date(2026, 10, 19, 12, 0);
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).toISOString();

function quest(id: string, sessionId: string, dueAt: string | null, status: Quest["status"] = "open"): Quest {
  return {
    id, sessionId, kind: "custom", title: `Quest ${id}`, notes: null, assignee: { id: "me", name: "Me" }, dueAt, status,
    reminderOffsets: [], remindersSent: [], createdBy: null, createdAt: at(2026, 11, 1), completedAt: null,
    session: { id: sessionId, title: "x", date: null, endDate: null, status: "scheduled", campaign: { id: "c", title: "c" } },
  };
}

function session(id: string, date: string, extra: Partial<AlmanacSession> = {}): AlmanacSession {
  return {
    id, title: `Session ${id}`, date, endDate: new Date(Date.parse(date) + 3 * HOUR).toISOString(), status: "scheduled",
    isOnline: false, location: "The Gull", campaign: { id: "ca", title: "Ashen Crown" }, quests: [], ...extra,
  };
}

const played = session("p", at(2026, 11, 12, 19));
const tonight = session("t", at(2026, 11, 19, 19), { isOnline: true, location: null, campaign: { id: "sf", title: "Starfall" } });
const nextWeek = session("n", at(2026, 11, 24, 18, 30));
const weekend = session("w", at(2026, 11, 27, 18), { endDate: at(2026, 11, 29, 14) });
const later = session("l", at(2026, 12, 9, 19), { isOnline: true, campaign: { id: "sf", title: "Starfall" } });
const ALL = [later, weekend, played, nextWeek, tonight];

test("Coming up is every session not over, soonest first; Played is the ones that are, latest first", () => {
  const { comingUp, played: past } = almanacLists(ALL, NOW);
  assert.deepEqual(comingUp.map((s) => s.id), ["t", "n", "w", "l"]);
  assert.deepEqual(past.map((s) => s.id), ["p"]);
  // Under way counts as coming up until it ends; with no end, 4 hours after it starts (the session page's rule).
  const underWay = session("u", at(2026, 11, 19, 10), { endDate: null });
  assert.deepEqual(almanacLists([underWay], NOW).comingUp.map((s) => s.id), ["u"]);
  assert.deepEqual(almanacLists([underWay], new Date(2026, 10, 19, 14, 1)).played.map((s) => s.id), ["u"]);
  // The backend never marks a session completed, but if it did it's played.
  assert.deepEqual(almanacLists([session("c", at(2026, 11, 30), { status: "completed" })], NOW).played.map((s) => s.id), ["c"]);
});

test("the list runs by week from Monday, each session under the day it starts (under way since yesterday: today)", () => {
  const sinceYesterday = session("y", at(2026, 11, 18, 22), { endDate: at(2026, 11, 19, 15) });
  const weeks = chronicleWeeks(almanacLists([...ALL, sinceYesterday], NOW).comingUp, NOW);
  assert.deepEqual(weeks.map((w) => w.label), ["This week · Nov 16 – 22", "Next week · Nov 23 – 29", "Week of Dec 7 – 13"]);
  assert.deepEqual(weeks[0].days.map((d) => [dayKey(d.day), d.sessions.map((s) => s.id)]), [["2026-11-19", ["y", "t"]]]);
  assert.deepEqual(weeks[1].days.map((d) => dayKey(d.day)), ["2026-11-24", "2026-11-27"]);
  assert.equal(weekLabel(new Date(2026, 10, 30), NOW), "Week of Nov 30 – Dec 6");
});

test("a session is on every day from its start to its end; one ending at midnight doesn't spill over", () => {
  assert.deepEqual(sessionDays(weekend).map(dayKey), ["2026-11-27", "2026-11-28", "2026-11-29"]);
  assert.deepEqual(sessionDays(session("m", at(2026, 11, 20, 20), { endDate: at(2026, 11, 21) })).map(dayKey), ["2026-11-20"]);
  assert.deepEqual(sessionDays(session("x", at(2026, 11, 20, 20), { endDate: null })).map(dayKey), ["2026-11-20"]);
  assert.deepEqual(sessionsOn(ALL, new Date(2026, 10, 28)).map((s) => s.id), ["w"]);
  assert.equal(timeOnDay(weekend, new Date(2026, 10, 27), true), "6 pm onward");
  assert.equal(timeOnDay(weekend, new Date(2026, 10, 28), true), "All day");
  assert.equal(timeOnDay(weekend, new Date(2026, 10, 29), true), "Until 2 pm");
  assert.equal(timeOnDay(nextWeek, new Date(2026, 10, 24), true), "6:30–9:30 pm");
  assert.equal(timeOnDay(nextWeek, new Date(2026, 10, 24), false), "6:30 pm");
});

test("a quest sits on the calendar on its due day, unless that's a day of its own session", () => {
  const early = quest("q1", "n", at(2026, 11, 22, 20));
  const sameDay = quest("q2", "n", at(2026, 11, 24, 17));
  const undated = quest("q3", "n", null);
  const s = { ...nextWeek, quests: [early, sameDay, undated] };
  assert.deepEqual(questsDueOn([s], new Date(2026, 10, 22)).map((q) => q.id), ["q1"]);
  assert.deepEqual(questsDueOn([s], new Date(2026, 10, 24)), []);
  // During a weekend-long session, a quest due on its second day stays with it.
  const w = { ...weekend, quests: [quest("q4", "w", at(2026, 11, 28, 8))] };
  assert.deepEqual(questsDueOn([w], new Date(2026, 10, 28)), []);
});

test("filters: any campaigns (none means all) and anywhere, in person or online", () => {
  assert.equal(isFiltered(NO_FILTER), false);
  const sf = toggleCampaign(NO_FILTER, "sf");
  assert.deepEqual(sf.campaigns, ["sf"]);
  assert.deepEqual(toggleCampaign(sf, "sf").campaigns, []);
  assert.deepEqual(applyFilter(ALL, sf).map((s) => s.id).sort(), ["l", "t"]);
  assert.deepEqual(applyFilter(ALL, { campaigns: [], where: "online" }).map((s) => s.id).sort(), ["l", "t"]);
  assert.deepEqual(applyFilter(ALL, { campaigns: ["sf"], where: "person" }), []);
  assert.deepEqual(applyFilter(ALL, { campaigns: ["sf", "ca"], where: "person" }).map((s) => s.id).sort(), ["n", "p", "w"]);
  assert.deepEqual(campaignChoices(ALL), [{ id: "ca", title: "Ashen Crown" }, { id: "sf", title: "Starfall" }]);
});

test("each choice counts the sessions coming up it would leave, given the rest of the filter", () => {
  assert.deepEqual(filterCounts(ALL, NO_FILTER, NOW), { campaigns: { ca: 2, sf: 2 }, where: { all: 4, person: 2, online: 2 } });
  assert.deepEqual(filterCounts(ALL, { campaigns: ["sf"], where: "online" }, NOW),
    { campaigns: { ca: 0, sf: 2 }, where: { all: 2, person: 0, online: 2 } });
});

test("the calendar's month is whole weeks from Monday, and it opens on the next day with something on", () => {
  const nov = monthDays(new Date(2026, 10, 1));
  assert.equal(nov.length, 42);
  assert.equal(dayKey(nov[0]), "2026-10-26");
  assert.equal(dayKey(nov[nov.length - 1]), "2026-12-06");
  assert.equal(monthDays(new Date(2027, 1, 1)).length, 28, "February 2027 starts on a Monday");
  const inNov = nov.filter((d) => d.getMonth() === 10);
  const busy = (d: Date) => sessionsOn(ALL, d).length > 0;
  assert.equal(dayKey(firstDay(inNov, new Date(2026, 10, 20), busy)), "2026-11-24");
  assert.equal(dayKey(firstDay(inNov, new Date(2026, 10, 30), busy)), "2026-11-30", "nothing ahead: today");
  assert.equal(dayKey(firstDay(inNov, new Date(2026, 11, 20), busy)), "2026-11-12", "another month: its first busy day");
  assert.equal(dayKey(firstDay(inNov, new Date(2026, 11, 20), () => false)), "2026-11-01");
});

test("words: the night, the place, the week, the seal and the heading's count", () => {
  assert.equal(whenLine(nextWeek), "Tue Nov 24 · 6:30–9:30 pm");
  assert.equal(whenLine(weekend), "Fri Nov 27, 6 pm – Sun Nov 29, 2 pm");
  assert.equal(placeLine(tonight), "Online");
  assert.equal(placeLine(nextWeek), "The Gull");
  assert.equal(placeLine({ isOnline: false, location: " " }), "Place to be decided");
  assert.equal(weekTitle(new Date(2026, 10, 30)), "Nov 30 – Dec 6, 2026");
  assert.equal(weekTitle(new Date(2026, 11, 28)), "Dec 28, 2026 – Jan 3, 2027");
  assert.equal(sealOf(played, NOW).label, "Played");
  assert.equal(sealOf(tonight, NOW).label, "Night set");
  assert.equal(sealOf({ ...tonight, status: "cancelled" }, NOW).label, "Cancelled");
  const withQuests = [{ ...tonight, quests: [quest("a", "t", null), quest("b", "t", null, "done")] }, { ...played, quests: [quest("c", "p", null)] }];
  assert.equal(headLine([...withQuests, nextWeek, later, session("far", at(2026, 12, 18, 19))], NOW), "3 sessions in the next four weeks · 1 quest open");
});

test("a quest ticked in Your Quests shows done in the Almanac", () => {
  const s = { ...tonight, quests: [quest("a", "t", null), quest("b", "t", null)] };
  const [after] = withRail([s], [quest("a", "t", null, "done")]);
  assert.deepEqual(after.quests.map((q) => q.status), ["done", "open"]);
  assert.equal(withRail([s], [quest("a", "t", null)])[0], s, "nothing done there: unchanged");
});

test("reads: a range read is kept, and a newer read of it replaces what was known there", () => {
  const r = { start: new Date(2026, 10, 1), end: new Date(2026, 11, 1) };
  assert.equal(covered([r], { start: new Date(2026, 10, 2), end: new Date(2026, 10, 9) }), true);
  assert.equal(covered([r], { start: new Date(2026, 10, 30), end: addDays(new Date(2026, 10, 30), 7) }), false);
  const moved = { ...nextWeek, date: at(2026, 12, 2, 18) };
  const merged = mergeRange([played, nextWeek, later], r, [moved, tonight]);
  // `played` (in the range) is gone; `nextWeek` moved out and is replaced; `later` (outside) stays.
  assert.deepEqual(merged.map((s) => s.id).sort(), ["l", "n", "t"]);
  assert.equal(merged.find((s) => s.id === "n")?.date, moved.date);
});
