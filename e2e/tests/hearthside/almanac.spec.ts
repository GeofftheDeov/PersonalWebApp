/**
 * The Almanac (#228): the list and the calendar each show a seeded session,
 * Month and Week keep the chosen day, a quest ticked on the calendar stays
 * done, the filters narrow both views and Clear filters resets them, and at
 * 375px nothing scrolls sideways and Week is a list of days. Each test makes
 * its own GM, player, campaigns and sessions, so the seeded party is left
 * alone, and signs the player in.
 *
 * Days are the browser's: sessions are seeded at an hour of a day counted
 * from today in the browser's own time zone, and the day labels the
 * calendar's buttons carry are worked out there too.
 */
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { test, expect } from "../../fixtures";

const HOUR = 60 * 60 * 1000;
/** A first visit compiles the route in dev mode, which can take most of the 15s assertion budget. */
const FIRST_LOAD = { timeout: 45_000 };

/** A campaign `gm` runs that each of `players` has joined. */
async function campaignOf(gm: APIRequestContext, players: APIRequestContext[], title: string) {
  const made = await gm.post("/api/campaigns", {
    data: { title, description: "For the Almanac (#228).", status: "In Progress", startDate: new Date().toISOString() },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const campaignId = String((await made.json()).campaign.id);
  for (const p of players) expect((await p.post(`/api/campaigns/${campaignId}/join`)).ok()).toBe(true);
  return campaignId;
}

/** A three-hour session starting at `start` (ISO). */
async function sessionOf(gm: APIRequestContext, campaignId: string, title: string, start: string, extra: Record<string, unknown> = {}) {
  const made = await gm.post("/api/tabletop/sessions", {
    data: { title, campaign: campaignId, date: start, endDate: new Date(Date.parse(start) + 3 * HOUR).toISOString(), location: "The Gull", ...extra },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const s = await made.json();
  return String(s._id ?? s.id);
}

async function questFor(gm: APIRequestContext, sessionId: string, assigneeId: string, title: string, dueAt: string) {
  const made = await gm.post(`/api/quests/sessions/${sessionId}`, { data: { title, assigneeId, dueAt } });
  expect(made.ok(), await made.text()).toBe(true);
  return String((await made.json()).id);
}

/** `days` from today at `hour` o'clock, in the browser's time zone, as ISO. */
const dayAt = (page: Page, days: number, hour: number) =>
  page.evaluate(([n, h]) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(h, 0, 0, 0); return d.toISOString(); }, [days, hour] as const);

/** The calendar's name for a day: "Thursday, November 26". */
const dayName = (page: Page, iso: string) =>
  page.evaluate((i) => new Date(i).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }), iso);

const heading = (page: Page) => page.getByRole("heading", { level: 1, name: "The Almanac" });
const comingUp = (page: Page) => page.getByRole("tabpanel", { name: /^Coming up/ });
const calendar = (page: Page) => page.getByRole("region", { name: "Calendar" });
const show = (page: Page, view: "List" | "Calendar") =>
  page.getByRole("group", { name: "Show the Almanac as" }).getByRole("button", { name: view }).click();
const sheet = (scope: Page | Locator, title: string) => scope.getByRole("article", { name: title });

/** Moves the month calendar on to the month `iso` is in (it opens on this month). */
async function showMonthOf(page: Page, iso: string) {
  const ahead = await page.evaluate((i) => {
    const d = new Date(i), t = new Date();
    return (d.getFullYear() - t.getFullYear()) * 12 + d.getMonth() - t.getMonth();
  }, iso);
  const title = await page.evaluate((i) => new Date(i).toLocaleDateString("en-US", { month: "long", year: "numeric" }), iso);
  for (let i = 0; i < ahead; i++) await calendar(page).getByRole("button", { name: "Next month" }).click();
  await expect(calendar(page).getByRole("heading", { level: 2 })).toHaveText(title);
}

/** A GM and a player in a fresh campaign (or several), the player signed in. */
async function partyOf({ newPerson, apiAs }: { newPerson: (n: string) => Promise<any>; apiAs: (p: any) => Promise<APIRequestContext> }, ...titles: string[]) {
  const [gm, player] = await Promise.all([newPerson("Odile Marsh"), newPerson("Piet Lark")]);
  const gmApi = await apiAs(gm);
  const playerApi = await apiAs(player);
  const campaigns: string[] = [];
  for (const t of titles) campaigns.push(await campaignOf(gmApi, [playerApi], t));
  return { gm, player, gmApi, campaigns };
}

test("the list and the calendar each show a seeded session", async ({ page, signIn, apiAs, newPerson }) => {
  const { player, gmApi, campaigns: [campaignId] } = await partyOf({ newPerson, apiAs }, "t228 The Ashen Crown");
  const start = await dayAt(page, 2, 18);
  const title = "t228 Supper at the Gull";
  const id = await sessionOf(gmApi, campaignId, title, start);
  await questFor(gmApi, id, player.id, "Bring the lamp oil", start);

  await signIn(player);
  await page.goto("/almanac");
  await expect(heading(page)).toBeVisible(FIRST_LOAD);

  // The list (the default): the session's sheet, with the player's quest on it and a way to its page.
  const list = comingUp(page);
  const card = sheet(list, title);
  await expect(card).toBeVisible();
  await expect(card.getByText("t228 The Ashen Crown")).toBeVisible();
  await expect(card.getByRole("list", { name: "Your quests" }).getByRole("checkbox", { name: "Bring the lamp oil: mark done" })).toBeVisible();
  await expect(card.getByRole("link", { name: "Open the session" })).toHaveAttribute("href", `/sessions/${id}`);
  await expect(page.getByRole("tab", { name: "Played 0" })).toBeVisible();

  // The calendar: on its day, and on parchment under the calendar once that day is chosen.
  await show(page, "Calendar");
  await showMonthOf(page, start);
  await expect(calendar(page).getByText(title)).toBeVisible();
  const label = await dayName(page, start);
  await calendar(page).getByRole("button", { name: `${label}, 1 session`, exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: new RegExp(`^${label}`) })).toBeVisible();
  await expect(sheet(page, title)).toBeVisible();
});

test("switching between Month and Week keeps the chosen day", async ({ page, signIn, apiAs, newPerson }) => {
  const { player, gmApi, campaigns: [campaignId] } = await partyOf({ newPerson, apiAs }, "t228 Starfall Salvage");
  await sessionOf(gmApi, campaignId, "t228 Into the Hold", await dayAt(page, 2, 19));
  // A quiet day, so it isn't the one the calendar would choose by itself.
  const quiet = await dayAt(page, 9, 12);
  const label = await dayName(page, quiet);

  await signIn(player);
  await page.goto("/almanac");
  await expect(heading(page)).toBeVisible(FIRST_LOAD);
  await show(page, "Calendar");
  await showMonthOf(page, quiet);

  const cal = calendar(page);
  const day = cal.getByRole("button", { name: label, exact: true });
  await day.click();
  await expect(day).toHaveAttribute("aria-pressed", "true");
  const chosen = page.getByRole("heading", { level: 2, name: new RegExp(`^${label}`) });
  await expect(chosen).toBeVisible();

  await cal.getByRole("tab", { name: "Week" }).click();
  await expect(cal.getByRole("tab", { name: "Week" })).toHaveAttribute("aria-selected", "true");
  const week = cal.getByRole("list", { name: "Days of the week" });
  await expect(week.locator(":scope > li")).toHaveCount(7);
  await expect(week.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(chosen).toBeVisible();

  await cal.getByRole("tab", { name: "Month" }).click();
  await expect(cal.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(chosen).toBeVisible();
});

test("a quest ticked on the calendar stays done", async ({ page, signIn, apiAs, newPerson }) => {
  const { player, gmApi, campaigns: [campaignId] } = await partyOf({ newPerson, apiAs }, "t228 Bones of the Brinewood");
  const id = await sessionOf(gmApi, campaignId, "t228 The Drowned Wood", await dayAt(page, 3, 13));
  // Due two days before the session, so it sits on its own day on the calendar.
  const due = await dayAt(page, 1, 20);
  const title = "t228 Paint the witch's teeth";
  const questId = await questFor(gmApi, id, player.id, title, due);

  await signIn(player);
  await page.goto("/almanac");
  await expect(heading(page)).toBeVisible(FIRST_LOAD);
  await show(page, "Calendar");
  await showMonthOf(page, due);

  const slips = calendar(page).getByRole("list", { name: `Quests due ${await dayName(page, due)}` });
  const done = page.waitForResponse((r) => r.url().includes(`/api/quests/${questId}/done`) && r.request().method() === "POST");
  await slips.getByRole("checkbox", { name: `${title}: mark done` }).click();
  expect((await done).ok()).toBe(true);
  await expect(slips.getByRole("checkbox", { name: `${title}: done` })).toBeChecked();
  // Your Quests in the rail follows.
  await expect(page.getByRole("region", { name: "Your Quests" }).getByRole("checkbox", { name: `${title}: done` })).toBeChecked();

  await page.reload();
  await expect(heading(page)).toBeVisible(FIRST_LOAD);
  await show(page, "Calendar");
  await showMonthOf(page, due);
  await expect(calendar(page).getByRole("checkbox", { name: `${title}: done` })).toBeChecked();
});

test("filtering by campaign and by online or in person narrows both views, and Clear filters resets them", async ({ page, signIn, apiAs, newPerson }) => {
  const { player, gmApi, campaigns: [crown, starfall] } = await partyOf({ newPerson, apiAs }, "t228 Ashen Crown", "t228 Starfall");
  const atGull = "t228 Supper at the Gull";
  const onAir = "t228 The Calling";
  // The same day, so one month of the calendar shows both.
  const inPerson = await dayAt(page, 2, 17);
  await sessionOf(gmApi, crown, atGull, inPerson, { location: "The Gull" });
  await sessionOf(gmApi, starfall, onAir, await dayAt(page, 2, 21), { isOnline: true, location: "" });

  await signIn(player);
  await page.goto("/almanac");
  await expect(heading(page)).toBeVisible(FIRST_LOAD);
  const list = comingUp(page);
  const filters = page.getByRole("group", { name: "Filter sessions" });
  await expect(sheet(list, atGull)).toBeVisible();
  await expect(sheet(list, onAir)).toBeVisible();
  await expect(filters.getByRole("button", { name: "Anywhere 2" })).toHaveAttribute("aria-pressed", "true");
  await expect(filters.getByRole("button", { name: "In person 1" })).toBeVisible();
  await expect(filters.getByRole("button", { name: "Clear filters" })).toHaveCount(0);

  // One campaign, from the dropdown of banners.
  await filters.getByRole("button", { name: "All campaigns" }).click();
  const options = filters.getByRole("listbox", { name: "Campaigns" });
  await options.getByRole("option", { name: /^t228 Starfall/ }).click();
  await expect(options.getByRole("option", { name: /^t228 Starfall/ })).toHaveAttribute("aria-selected", "true");
  await filters.getByRole("button", { name: "Done" }).click();
  await expect(options).toHaveCount(0);
  await expect(filters.getByRole("button", { name: "Stop filtering to t228 Starfall" })).toBeVisible();
  await expect(filters.getByRole("button", { name: "1 campaign" })).toBeVisible();
  await expect(filters.getByRole("button", { name: "In person 0" })).toBeVisible();
  await expect(sheet(list, onAir)).toBeVisible();
  await expect(sheet(list, atGull)).toHaveCount(0);

  await show(page, "Calendar");
  await showMonthOf(page, inPerson);
  const cal = calendar(page);
  await expect(cal.getByText(onAir)).toBeVisible();
  await expect(cal.getByText(atGull)).toHaveCount(0);

  await filters.getByRole("button", { name: "Clear filters" }).click();
  await expect(cal.getByText(atGull)).toBeVisible();
  await expect(cal.getByText(onAir)).toBeVisible();
  await expect(filters.getByRole("button", { name: "All campaigns" })).toBeVisible();

  // Where it's played.
  await filters.getByRole("button", { name: "In person 1" }).click();
  await expect(cal.getByText(atGull)).toBeVisible();
  await expect(cal.getByText(onAir)).toHaveCount(0);
  await show(page, "List");
  await expect(sheet(list, atGull)).toBeVisible();
  await expect(sheet(list, onAir)).toHaveCount(0);
  await filters.getByRole("button", { name: "Online 1" }).click();
  await expect(sheet(list, onAir)).toBeVisible();
  await expect(sheet(list, atGull)).toHaveCount(0);

  await filters.getByRole("button", { name: "Clear filters" }).click();
  await expect(sheet(list, atGull)).toBeVisible();
  await expect(sheet(list, onAir)).toBeVisible();
  await expect(filters.getByRole("button", { name: "Anywhere 2" })).toHaveAttribute("aria-pressed", "true");
  await expect(filters.getByRole("button", { name: "Clear filters" })).toHaveCount(0);
});

test.describe("at 375px", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("nothing scrolls sideways, and Week is a list of days", async ({ page, signIn, apiAs, newPerson }) => {
    const { player, gmApi, campaigns: [campaignId] } = await partyOf({ newPerson, apiAs },
      "t228 The Extraordinarily Long-Winded Chronicle of the Unpronounceable Archipelagos");
    const start = await dayAt(page, 2, 18);
    const id = await sessionOf(gmApi, campaignId, "t228 A Weekend in the Glass Wastes, Where Nobody Brought Enough Water", start,
      { location: "Marco's cabin up past the old quarry road" });
    await questFor(gmApi, id, player.id, "t228 Book the cabin for both nights", await dayAt(page, 1, 17));

    await signIn(player);
    await page.goto("/almanac");
    await expect(heading(page)).toBeVisible(FIRST_LOAD);
    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await expect(sheet(comingUp(page), "t228 A Weekend in the Glass Wastes, Where Nobody Brought Enough Water")).toBeVisible();
    expect(await sideways()).toBeLessThanOrEqual(0);

    // The campaign dropdown spans the filter panel.
    const filters = page.getByRole("group", { name: "Filter sessions" });
    await filters.getByRole("button", { name: "All campaigns" }).click();
    await expect(filters.getByRole("listbox", { name: "Campaigns" })).toBeVisible();
    expect(await sideways()).toBeLessThanOrEqual(0);
    await page.keyboard.press("Escape");
    await expect(filters.getByRole("listbox", { name: "Campaigns" })).toHaveCount(0);

    await show(page, "Calendar");
    await expect(calendar(page)).toBeVisible();
    expect(await sideways()).toBeLessThanOrEqual(0);

    await calendar(page).getByRole("tab", { name: "Week" }).click();
    // The days themselves, not the quest slips listed inside them.
    const days = calendar(page).getByRole("list", { name: "Days of the week" }).locator(":scope > li");
    await expect(days).toHaveCount(7);
    expect(await sideways()).toBeLessThanOrEqual(0);
    // A list: the days stacked one under the other, each the list's full width.
    const boxes = await days.evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
    for (let i = 1; i < boxes.length; i++) {
      expect(Math.abs(boxes[i].x - boxes[0].x)).toBeLessThan(1);
      expect(Math.abs(boxes[i].w - boxes[0].w)).toBeLessThan(1);
      expect(boxes[i].y).toBeGreaterThanOrEqual(boxes[i - 1].y + boxes[i - 1].h - 1);
    }
    expect(boxes[0].x + boxes[0].w).toBeLessThanOrEqual(375);
  });
});
