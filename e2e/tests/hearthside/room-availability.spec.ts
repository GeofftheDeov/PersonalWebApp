/**
 * Your Room's Availability tab (#275): the portfolio profile's availability
 * editor on Hearthside. A window saved (overnight, so it says when it ends)
 * stays after a reload and shows in What your party sees; an exception adds
 * and removes; Connect Google from the tab asks to come back to it, and the
 * way back opens it with the result. Each test makes its own person.
 *
 * Google isn't reachable here, so the busy sources and Google's page are
 * stood in for (the callback's `&tab=availability` is the backend's,
 * backend/scripts/test-return-links.ts).
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../../fixtures";

/** A first visit compiles the route in dev mode, which can take most of the 15s assertion budget. */
const FIRST_LOAD = { timeout: 45_000 };

const section = (page: Page, name: string) => page.getByRole("tabpanel").getByRole("region", { name });

/** "YYYY-MM-DD", `days` from today, local (the browser shares this machine's zone). */
function dateIn(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test("a week saved stays saved and shows as the party sees it; exceptions add and remove", async ({ page, signIn, newPerson }) => {
  const me = await newPerson("Ysolde Marrow");
  await signIn(me);
  await page.goto("/room?tab=availability");
  await expect(page.getByRole("tab", { name: "Availability" })).toHaveAttribute("aria-selected", "true", FIRST_LOAD);

  const week = section(page, "When you can play");
  await expect(week).toContainText("No weekly windows yet", FIRST_LOAD);
  const save = week.getByRole("button", { name: "Save my week" });
  await expect(save).toBeDisabled();

  // The first window is Saturday evening; run it past midnight.
  await week.getByRole("button", { name: "Add a window" }).click();
  const row = week.getByRole("list", { name: "Your week" }).getByRole("listitem");
  await expect(row).toHaveCount(1);
  await expect(row.getByLabel("Day", { exact: true })).toHaveValue("6");
  await row.getByLabel("From").fill("19:00");
  await row.getByLabel("Until").fill("01:00");
  await expect(row).toContainText("Ends Sun 1 AM");
  await expect(week).toContainText("Unsaved changes");
  await save.click();
  await expect(week.getByRole("status")).toHaveText("Saved.");
  await expect(save).toBeDisabled();

  // The party sees Saturdays free from 7 PM to midnight.
  const seen = section(page, "What your party sees");
  await expect(seen.getByRole("img", { name: /^Sat, .*: 5 hours free$/ }).first()).toBeVisible();

  // It's on the server: a fresh load brings it back.
  await page.reload();
  await page.getByRole("tab", { name: "Availability" }).click({ timeout: FIRST_LOAD.timeout });
  await expect(row).toHaveCount(1, FIRST_LOAD);
  await expect(row.getByLabel("From")).toHaveValue("19:00");
  await expect(row.getByLabel("Until")).toHaveValue("01:00");

  // An exception: out all day, with a note, then removed.
  const ex = section(page, "Exceptions");
  await ex.getByRole("button", { name: "Out", exact: true }).click();
  await ex.getByLabel("Date").fill(dateIn(9));
  await ex.getByLabel("Note (optional)").fill("t275 Cousin's wedding");
  await ex.getByRole("button", { name: "Add", exact: true }).click();
  const listed = ex.getByRole("list", { name: "Your exceptions" }).getByRole("listitem");
  await expect(listed).toHaveCount(1);
  await expect(listed).toContainText("All day");
  await expect(listed).toContainText("t275 Cousin's wedding");
  await listed.getByRole("button", { name: /^Remove / }).click();
  await expect(listed).toHaveCount(0);

  // A blank date says so.
  await ex.getByRole("button", { name: "Add", exact: true }).click();
  await expect(ex.getByRole("alert")).toHaveText("Pick a date.");
});

test("Connect Google from Availability asks to come back to it, and the way back opens it", async ({ page, signIn, newPerson, hearthside }) => {
  const me = await newPerson("Tamsin Okafor");
  await signIn(me);
  await page.route("**/api/availability/me/busy-sources", (route) => route.fulfill({
    json: {
      sources: [
        { source: "google", enabled: false, connected: false, ready: false, needsReconsent: false, problem: null, syncedAt: null, lastError: null, freshMinutes: 15 },
        { source: "discord", enabled: false, connected: true, ready: true, needsReconsent: false, problem: null, syncedAt: null, lastError: null, freshMinutes: 15 },
      ],
    },
  }));
  let asked = "";
  await page.route("**/api/google-calendar/auth-url*", (route) => {
    asked = new URL(route.request().url()).search;
    // Google's page stands in, sending them back as the callback would.
    return route.fulfill({ json: { url: hearthside.url("/room?gcal=connected&tab=availability") } });
  });

  await page.goto("/room?tab=availability");
  const busy = section(page, "Busy from your calendars");
  await expect(busy).toContainText("Google Calendar", FIRST_LOAD);
  await expect(busy.getByRole("button", { name: "Turn on Discord events" })).toBeVisible();
  await busy.getByRole("button", { name: "Connect Google" }).click();

  await expect(busy.getByRole("status")).toHaveText("Google Calendar connected!");
  expect(asked).toBe("?return=availability");
  await expect(page.getByRole("tab", { name: "Availability" })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(hearthside.url("/room"));
});

test.describe("at 375px", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("the Availability tab doesn't scroll sideways", async ({ page, signIn, newPerson }) => {
    const me = await newPerson("Peregrine Ashcombe-Lightfoot");
    await signIn(me);
    await page.goto("/room?tab=availability");
    const week = section(page, "When you can play");
    await week.getByRole("button", { name: "Add a window" }).click({ timeout: FIRST_LOAD.timeout });
    await week.getByRole("button", { name: "Add a window" }).click();
    await expect(week.getByRole("list", { name: "Your week" }).getByRole("listitem")).toHaveCount(2);
    await section(page, "Exceptions").getByLabel("All day").uncheck();
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(wide).toBeLessThanOrEqual(0);
  });
});
