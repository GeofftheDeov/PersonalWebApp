/**
 * Your Room's Availability tab (#275): the week and what Save sends, a new
 * window, overnight windows, an exception's span and its line, the busy
 * sources' lines and buttons, and the preview's rows.
 *
 *   cd hearthside && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PREVIEW_DAYS, ago, blankException, clock, describeException, exceptionSpan, nextWindow, overnightNote,
  previewDays, previewQuery, previewStart, sourceActions, sourceLine, timeZones, weekChanged, weekOf,
  windowsBody, withException, type AvailabilityException, type BusySource,
} from "../src/lib/availability";

/** Local times, so the tests hold in any zone the machine is in. */
const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);
const iso = (...a: Parameters<typeof local>) => local(...a).toISOString();

test("the week takes its time zone from its windows, else the device's", () => {
  const w = weekOf({ windows: [{ weekday: 5, start: "18:00", end: "23:00", timeZone: "America/Denver" }], exceptions: [] }, "UTC");
  assert.deepEqual(w, { windows: [{ weekday: 5, start: "18:00", end: "23:00" }], timeZone: "America/Denver" });
  assert.equal(weekOf({ windows: [], exceptions: [] }, "Europe/London").timeZone, "Europe/London");
});

test("Save sends each window with the week's time zone, and only a change counts as unsaved", () => {
  const w = { windows: [{ weekday: 1, start: "19:00", end: "22:00" }], timeZone: "America/Chicago" };
  assert.deepEqual(windowsBody(w), { windows: [{ weekday: 1, start: "19:00", end: "22:00", timeZone: "America/Chicago" }] });
  assert.equal(weekChanged(w, { ...w, windows: [...w.windows] }), false);
  assert.equal(weekChanged(w, { ...w, timeZone: "UTC" }), true);
  assert.equal(weekChanged(w, { ...w, windows: [{ weekday: 1, start: "19:00", end: "23:00" }] }), true);
});

test("a new window is the day after the last, at its times; the first is Saturday evening", () => {
  assert.deepEqual(nextWindow([]), { weekday: 6, start: "18:00", end: "23:00" });
  assert.deepEqual(nextWindow([{ weekday: 6, start: "17:00", end: "21:30" }]), { weekday: 0, start: "17:00", end: "21:30" });
});

test("a window ending before it starts runs into the next day, and says when", () => {
  assert.equal(clock("18:30"), "6:30 PM");
  assert.equal(clock("00:00"), "12 AM");
  assert.equal(clock("12:00"), "12 PM");
  assert.equal(overnightNote({ weekday: 5, start: "20:00", end: "02:00" }), "Ends Sat 2 AM");
  assert.equal(overnightNote({ weekday: 6, start: "22:00", end: "01:30" }), "Ends Sun 1:30 AM");
  assert.equal(overnightNote({ weekday: 5, start: "18:00", end: "23:00" }), null);
  assert.equal(overnightNote({ weekday: 5, start: "18:00", end: "18:00" }), null);
});

test("an exception covers the whole day, or from–until, running past midnight when until is earlier", () => {
  const d = { ...blankException(), date: "2026-12-04" };
  assert.deepEqual(exceptionSpan(d), { start: local(2026, 12, 4), end: local(2026, 12, 5) });
  assert.deepEqual(exceptionSpan({ ...d, allDay: false, start: "18:00", end: "23:00" }), { start: local(2026, 12, 4, 18), end: local(2026, 12, 4, 23) });
  assert.deepEqual(exceptionSpan({ ...d, allDay: false, start: "21:00", end: "01:00" }), { start: local(2026, 12, 4, 21), end: local(2026, 12, 5, 1) });
  assert.deepEqual(exceptionSpan({ ...d, date: "" }), { error: "Pick a date." });
  assert.deepEqual(exceptionSpan({ ...d, allDay: false, start: "19:00", end: "19:00" }), { error: "Start and end can’t be the same time." });
});

test("an exception reads as a day, a run of days, or a span of hours", () => {
  assert.equal(describeException({ start: iso(2026, 12, 4), end: iso(2026, 12, 5) }), "Fri, Dec 4 · All day");
  assert.equal(describeException({ start: iso(2026, 12, 4), end: iso(2026, 12, 7) }), "Fri, Dec 4 – Sun, Dec 6");
  assert.equal(describeException({ start: iso(2026, 12, 4, 18), end: iso(2026, 12, 4, 23) }), "Fri, Dec 4 · 6:00 PM – 11:00 PM");
  assert.equal(describeException({ start: iso(2026, 12, 4, 21), end: iso(2026, 12, 5, 1) }), "Fri, Dec 4 · 9:00 PM – 1:00 AM");
});

test("a new exception goes in date order", () => {
  const x = (id: string, start: string): AvailabilityException => ({ id, start, end: start, kind: "unavailable", note: null });
  const list = [x("a", "2026-12-01T00:00:00.000Z"), x("c", "2026-12-20T00:00:00.000Z")];
  assert.deepEqual(withException(list, x("b", "2026-12-10T00:00:00.000Z")).map((e) => e.id), ["a", "b", "c"]);
});

const source = (over: Partial<BusySource>): BusySource => ({
  source: "google", enabled: false, connected: false, ready: false, needsReconsent: false,
  problem: null, syncedAt: null, lastError: null, freshMinutes: 15, ...over,
});

test("each busy source says where it stands", () => {
  const now = new Date("2026-11-24T12:00:00Z");
  assert.equal(ago("2026-11-24T11:48:00Z", now), "12 min ago");
  assert.equal(ago("2026-11-24T11:59:40Z", now), "just now");
  assert.equal(ago("2026-11-24T09:00:00Z", now), "3 h ago");
  assert.equal(ago("2026-11-20T12:00:00Z", now), "4 days ago");
  assert.equal(sourceLine(source({ enabled: true, syncedAt: "2026-11-24T11:48:00Z" }), now), "Synced 12 min ago · refreshed when older than 15 min");
  assert.equal(sourceLine(source({ enabled: true }), now), "Not synced yet.");
  assert.match(sourceLine(source({ connected: true, needsReconsent: true }), now), /ask you once more/);
  assert.equal(sourceLine(source({ ready: true, source: "discord" }), now), "Off: your Discord events busy time doesn’t count yet.");
  assert.equal(sourceLine(source({ source: "discord", problem: "Add your Discord user ID to your record." }), now), "Add your Discord user ID to your record.");
  assert.equal(sourceLine(source({}), now), "Not connected.");
});

test("a source's buttons: Connect or Reconnect Google, Sync now when on, and Turn on or off", () => {
  assert.deepEqual(sourceActions(source({})), { connect: "Connect Google", sync: false, toggle: null });
  assert.deepEqual(sourceActions(source({ connected: true, needsReconsent: true })), { connect: "Reconnect Google", sync: false, toggle: null });
  assert.deepEqual(sourceActions(source({ connected: true, ready: true })), { connect: null, sync: false, toggle: "Turn on" });
  assert.deepEqual(sourceActions(source({ connected: true, ready: true, enabled: true })), { connect: null, sync: true, toggle: "Turn off" });
  // Discord never connects here: its user ID is on the record.
  assert.deepEqual(sourceActions(source({ source: "discord" })), { connect: null, sync: false, toggle: null });
});

test("the preview is two weeks of half hours from midnight today, unknown where nothing says", () => {
  const from = previewStart(local(2026, 11, 24, 15, 20));
  assert.deepEqual(from, local(2026, 11, 24));
  const q = new URLSearchParams(previewQuery(from));
  assert.equal(q.get("start"), from.toISOString());
  assert.equal(q.get("end"), local(2026, 12, 8).toISOString());

  const days = previewDays(from, [
    { start: iso(2026, 11, 24, 18), end: iso(2026, 11, 24, 23), presence: "free" },
    { start: iso(2026, 11, 25, 0), end: iso(2026, 11, 26, 0), presence: "busy" },
  ]);
  assert.equal(days.length, PREVIEW_DAYS);
  assert.equal(days[0].label, "Tue, Nov 24");
  assert.equal(days[0].cells.length, 48);
  assert.equal(days[0].freeHours, 5);
  assert.equal(days[0].cells[36], "free");
  assert.equal(days[0].cells[46], "unknown");
  assert.ok(days[1].cells.every((c) => c === "busy"));
  assert.ok(days[13].cells.every((c) => c === "unknown"));
});

test("the zone list always holds the current zone", () => {
  assert.ok(timeZones("UTC").includes("UTC"));
  assert.equal(timeZones("Mars/Olympus_Mons")[0], "Mars/Olympus_Mons");
});
