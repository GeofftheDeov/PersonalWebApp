/**
 * How Letters labels things (#221, spec #69): a thread's last activity, the
 * avatar's initials, and who wrote a message.
 *
 *   cd hearthside && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { initials, senderLabel, threadWhen } from "../src/lib/lettersFormat";

const NOW = new Date(2026, 10, 10, 18, 0, 0); // Tue 10 Nov 2026, 6 pm local
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

test("a thread nobody has written in has no time", () => {
  assert.equal(threadWhen(null, NOW), "");
});

test("the last minute is 'now'; earlier today is the time", () => {
  assert.equal(threadWhen(ago(20_000), NOW), "now");
  const earlier = threadWhen(ago(3 * 60 * MIN), NOW);
  assert.equal(earlier, new Date(ago(3 * 60 * MIN)).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).toLowerCase());
});

test("this week is the weekday; before that the date", () => {
  assert.equal(threadWhen(ago(2 * DAY), NOW), new Date(ago(2 * DAY)).toLocaleDateString(undefined, { weekday: "short" }));
  const older = threadWhen(ago(30 * DAY), NOW);
  assert.equal(older, new Date(ago(30 * DAY)).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  const lastYear = threadWhen(ago(400 * DAY), NOW);
  assert.match(lastYear, /2025/);
});

test("initials: up to two, from the words of a name", () => {
  assert.equal(initials("Morwen Ashby"), "MA");
  assert.equal(initials("The Sunken Lantern"), "TS");
  assert.equal(initials("tobin"), "T");
  assert.equal(initials("  "), "?");
});

test("a sender's label: 'You' for your own, an email's name part for old messages", () => {
  assert.equal(senderLabel({ id: "me", name: "Tobin Reed" }, "me"), "You");
  assert.equal(senderLabel({ id: "x", name: "Tobin Reed" }, "me"), "Tobin Reed");
  assert.equal(senderLabel({ id: "x", name: "tobin@party.test" }, "me"), "tobin");
  assert.equal(senderLabel({ id: "x", name: "" }, null), "Someone");
});
