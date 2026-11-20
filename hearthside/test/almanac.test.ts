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
  DEFAULT_PAGE_SIZE, PAGE_SIZES, VIEW_KEY, dayButtonLabel, firstRange, firstReach, keepView, mergeOlder, nextReach,
  olderPath, openQuestsOn, pageAfterResize, playedPage, questMark, reached, sheetQuests, storedView,
  type AlmanacSession, type ViewStorage,
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

// ── #252 ────────────────────────────────────────────────────────────────────

test("a session's mark counts its open quests on its sheet, shows done once they're ticked, and the day's name agrees", () => {
  const day = new Date(2026, 10, 24);
  const onItsDay = quest("a", "n", at(2026, 11, 24, 17));
  const undated = quest("b", "n", null);
  const early = quest("c", "n", at(2026, 11, 22, 20)); // a slip on the 22nd, not on the sheet
  const s = { ...nextWeek, quests: [onItsDay, undated, early] };
  assert.deepEqual(sheetQuests(s).map((q) => q.id), ["a", "b"]);
  assert.deepEqual(questMark(s), { open: 2, label: "2 quests", done: false });
  assert.equal(openQuestsOn([s], day), 2);
  assert.equal(dayButtonLabel(day, 1, openQuestsOn([s], day)), "Tuesday, November 24, 1 session, 2 quests");
  // The slip counts on its own day instead.
  assert.equal(openQuestsOn([s], new Date(2026, 10, 22)), 1);

  const oneDone = { ...s, quests: [{ ...onItsDay, status: "done" as const }, undated, early] };
  assert.deepEqual(questMark(oneDone), { open: 1, label: "1 quest", done: false });
  assert.equal(openQuestsOn([oneDone], day), 1);
  const allDone = { ...s, quests: [{ ...onItsDay, status: "done" as const }, { ...undated, status: "done" as const }, early] };
  assert.deepEqual(questMark(allDone), { open: 0, label: "Quests done", done: true });
  assert.equal(dayButtonLabel(day, 1, openQuestsOn([allDone], day)), "Tuesday, November 24, 1 session");

  assert.equal(questMark(nextWeek), null, "no quests: no mark");
  assert.equal(questMark({ ...s, status: "cancelled" }), null, "a cancelled session carries none");
  // A ticked slip leaves the day's count too.
  const slipDone = { ...s, quests: [{ ...early, status: "done" as const }] };
  assert.equal(openQuestsOn([slipDone], new Date(2026, 10, 22)), 0);
});

test("Played reads back from the first read's start, a page at a time, until the API says there are no more", () => {
  const reach = firstReach(firstRange(NOW));
  assert.equal(reach.before, new Date(2026, 4, 21).toISOString());
  assert.equal(olderPath(reach), `/api/quests/almanac?before=${encodeURIComponent(reach.before)}&limit=50`);
  const a = session("a", at(2025, 3, 1, 19));
  const b = session("b", at(2025, 2, 1, 19));
  const next = nextReach(reach, { sessions: [a, b], more: true });
  assert.deepEqual(next, { before: b.date, beforeId: "b" });
  assert.equal(olderPath(next!, 10), `/api/quests/almanac?before=${encodeURIComponent(b.date)}&beforeId=b&limit=10`);
  assert.equal(nextReach(next!, { sessions: [], more: false }), null);
  assert.deepEqual(nextReach(reach, { sessions: [], more: true }), reach, "an odd empty page that says more: try again from the same place");

  // Reached: everything from the cursor on; at its instant, ids from its own on (the API's order).
  assert.equal(reached(played, reach), true);
  assert.equal(reached(a, reach), false);
  assert.equal(reached(b, next), true);
  assert.equal(reached({ id: "c", date: b.date }, next), true);
  assert.equal(reached({ id: "a", date: b.date }, next), false);
  assert.equal(reached(session("z", at(2020, 1, 1)), null), true, "all read");

  const merged = mergeOlder([played, { ...a, title: "old" }], [a, b]);
  assert.deepEqual(merged.map((s) => [s.id, s.title]), [["p", "Session p"], ["a", "Session a"], ["b", "Session b"]]);
});

test("Played pages: one page at the size chosen, the range shown, and whether to read further back", () => {
  assert.deepEqual([...PAGE_SIZES], [10, 25, 50]);
  assert.equal(DEFAULT_PAGE_SIZE, 10);
  const list = Array.from({ length: 23 }, (_, i) => session(`s${i}`, at(2026, 10, 30 - i, 19)));

  const first = playedPage(list, 0, 10, false);
  assert.deepEqual([first.rows.length, first.range, first.hasPrev, first.hasNext, first.short], [10, "1–10 of 23", false, true, false]);
  const last = playedPage(list, 2, 10, false);
  assert.deepEqual([last.rows.map((s) => s.id), last.range, last.hasNext], [["s20", "s21", "s22"], "21–23 of 23", false]);
  assert.equal(playedPage(list, 9, 10, false).page, 2, "past the end: the last page");
  assert.equal(playedPage(list, 0, 25, false).range, "1–23 of 23");
  assert.equal(playedPage([], 0, 10, false).range, "");

  // More may be left: "+", and a page that can't be filled (or can't tell if there's a next) asks for more.
  const more = playedPage(list, 1, 10, true);
  assert.deepEqual([more.range, more.hasNext, more.short], ["11–20 of 23+", true, false]);
  assert.deepEqual([playedPage(list, 2, 10, true).short, playedPage(list.slice(0, 20), 1, 10, true).short], [true, true]);
  assert.equal(playedPage(list, 4, 10, true).page, 4, "while more may come, the page asked for stays");

  // A new size keeps the first row shown on the page.
  assert.equal(pageAfterResize(2, 10, 25), 0);
  assert.equal(pageAfterResize(3, 10, 25), 1);
  assert.equal(pageAfterResize(1, 25, 10), 2);
});

test("the view is remembered, and the list opens when storage has nothing or refuses", () => {
  const kept = new Map<string, string>();
  const storage: ViewStorage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => { kept.set(k, v); } };
  assert.equal(storedView(storage), "list");
  keepView(storage, "calendar");
  assert.equal(kept.get(VIEW_KEY), "calendar");
  assert.equal(storedView(storage), "calendar");
  kept.set(VIEW_KEY, "nonsense");
  assert.equal(storedView(storage), "list");
  const refusing: ViewStorage = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  assert.equal(storedView(refusing), "list");
  assert.doesNotThrow(() => keepView(refusing, "calendar"));
  assert.equal(storedView(null), "list");
});
