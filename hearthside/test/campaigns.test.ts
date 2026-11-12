/**
 * The Campaigns page's rules (#223, spec #69): the status filters and their
 * counts, what a card says about a campaign's dates, the dyed-cloth fallback's
 * initials and colours, and who sees the banner controls.
 *
 *   cd hearthside && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STATUS_FILTERS,
  campaignDates,
  campaignInitials,
  canManageBanner,
  clothFor,
  countByStatus,
  filterByStatus,
  statusLabel,
  type CampaignSummary,
} from "../src/lib/campaigns";

const c = (over: Partial<CampaignSummary>): CampaignSummary => ({
  _id: "11111111-1111-4111-8111-111111111111",
  title: "Curse of the Ashen Crown",
  description: "",
  status: "In Progress",
  startDate: "2026-03-14T00:00:00.000Z",
  endDate: null,
  owner: null,
  bannerKey: null,
  bannerUrl: null,
  ...over,
});

test("the filters are All, In progress, Not started and Completed, in that order", () => {
  assert.deepEqual(STATUS_FILTERS.map(statusLabel), ["All", "In progress", "Not started", "Completed"]);
});

test("each filter counts its campaigns, and All counts them all", () => {
  const list = [
    c({ _id: "a", status: "In Progress" }),
    c({ _id: "b", status: "In Progress" }),
    c({ _id: "c", status: "Not Started" }),
    c({ _id: "d", status: "Completed" }),
  ];
  assert.deepEqual(countByStatus(list), { All: 4, "In Progress": 2, "Not Started": 1, Completed: 1 });
  assert.deepEqual(countByStatus([]), { All: 0, "In Progress": 0, "Not Started": 0, Completed: 0 });
  assert.deepEqual(filterByStatus(list, "All").map((x) => x._id), ["a", "b", "c", "d"]);
  assert.deepEqual(filterByStatus(list, "In Progress").map((x) => x._id), ["a", "b"]);
  assert.deepEqual(filterByStatus(list, "Completed").map((x) => x._id), ["d"]);
});

test("a card's dates read as the campaign's state: Starts, Since, or the span", () => {
  // Campaign dates are calendar days, stored at midnight UTC: they read the same in every time zone.
  assert.equal(campaignDates(c({ status: "Not Started", startDate: "2026-11-07T00:00:00.000Z" })), "Starts Nov 7, 2026");
  assert.equal(campaignDates(c({ status: "In Progress", startDate: "2026-03-14T00:00:00.000Z" })), "Since Mar 14, 2026");
  assert.equal(
    campaignDates(c({ status: "Completed", startDate: "2025-09-06T00:00:00.000Z", endDate: "2026-02-21T00:00:00.000Z" })),
    "Sep 6, 2025 – Feb 21, 2026",
  );
  assert.equal(campaignDates(c({ status: "Completed", startDate: "2025-09-06T00:00:00.000Z", endDate: null })), "Since Sep 6, 2025");
  assert.equal(campaignDates(c({ startDate: null, endDate: null })), "");
  assert.equal(campaignDates(c({ startDate: "not a date" })), "");
});

test("the cloth's initials skip a leading article and small words, two letters at most", () => {
  assert.equal(campaignInitials("Curse of the Ashen Crown"), "CA");
  assert.equal(campaignInitials("The Lantern Road"), "LR");
  assert.equal(campaignInitials("Bones of the Brinewood"), "BB");
  assert.equal(campaignInitials("starfall"), "S");
  assert.equal(campaignInitials("  (the) 'quiet' war  "), "QW");
  assert.equal(campaignInitials("Ünder the Ätherwald"), "ÜÄ");
  assert.equal(campaignInitials("The"), "T");
  assert.equal(campaignInitials("!!!"), "?");
});

test("each campaign keeps its own cloth, picked from Hearthside's dyes", () => {
  const a = clothFor("11111111-1111-4111-8111-111111111111");
  assert.deepEqual(clothFor("11111111-1111-4111-8111-111111111111"), a, "the same campaign, the same cloth");
  const seen = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map((s) => clothFor(s).join()));
  assert.ok(seen.size > 1, "different campaigns can differ");
  for (const [from, to] of [a]) {
    assert.match(from, /^#[0-9a-f]{6}$/);
    assert.match(to, /^#[0-9a-f]{6}$/);
  }
});

test("only the campaign's owner, or an admin, sees the banner controls", () => {
  const owned = c({ owner: "me" });
  const me = { id: "me" };
  assert.equal(canManageBanner(owned, me, { appRole: "user" }), true);
  assert.equal(canManageBanner(owned, { id: "someone-else" }, { appRole: "user" }), false);
  assert.equal(canManageBanner(owned, { id: "someone-else" }, { appRole: "admin" }), true);
  assert.equal(canManageBanner(c({ owner: null }), me, { appRole: "user" }), false, "admin-managed: no owner");
  assert.equal(canManageBanner(owned, null, null), false, "signed out, or still loading");
});
