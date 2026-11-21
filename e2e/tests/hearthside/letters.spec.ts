/**
 * Letters in the Hearthside shell (#221): the thread list and the open
 * thread, live between two people in two browsers. Each test makes its own
 * people and campaign, so the seeded party's Table Talk is left alone.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "../../fixtures";

/** A campaign `gm` runs and `player` has joined: its Table Talk is a thread for both. */
async function campaignFor(gm: APIRequestContext, player: APIRequestContext, title: string): Promise<string> {
  const made = await gm.post("/api/campaigns", {
    data: { title, description: "For Letters (#221).", status: "In Progress", startDate: new Date().toISOString() },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const id = String((await made.json()).campaign.id);
  const joined = await player.post(`/api/campaigns/${id}/join`);
  expect(joined.ok(), await joined.text()).toBe(true);
  return id;
}

const letters = (page: Page) => page.getByRole("complementary", { name: "Letters" });

test("a letter sent in Letters reaches another player live, and marks the thread unread", async ({
  page, browser, baseURL, signIn, apiAs, newPerson,
}) => {
  const [wren, hal] = await Promise.all([newPerson("Wren Tallow"), newPerson("Hal Brask")]);
  const title = "t221 The Lantern Letters";
  await campaignFor(await apiAs(wren), await apiAs(hal), title);

  await signIn(wren);
  const other = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
  await signIn(hal, other);
  const halPage = await other.newPage();
  await Promise.all([page.goto("/"), halPage.goto("/")]);

  // Hal opens the party's thread, and waits until it's live.
  await letters(halPage).getByRole("button", { name: new RegExp(title) }).click();
  await expect(letters(halPage).getByRole("log", { name: `Letters with ${title}` })).toBeVisible();
  await expect(letters(halPage).getByText("Live", { exact: true })).toBeVisible();

  // Wren writes: Hal sees her writing, then her letter, without reloading.
  await letters(page).getByRole("button", { name: new RegExp(title) }).click();
  await expect(letters(page).getByText("Live", { exact: true })).toBeVisible();
  const compose = letters(page).getByRole("textbox", { name: "Write a letter" });
  await compose.fill("The lamp is lit on the drowned stair.");
  await expect(letters(halPage).getByText(/Wren Tallow is writing/)).toBeVisible();
  await letters(page).getByRole("button", { name: "Send" }).click();
  await expect(compose).toHaveValue("");

  const halLog = letters(halPage).getByRole("log");
  await expect(halLog.getByText("The lamp is lit on the drowned stair.")).toBeVisible();
  await expect(halLog.getByText(/Wren Tallow is writing/)).toHaveCount(0);
  await expect(letters(page).getByRole("log").getByText("sending…")).toHaveCount(0);

  // Back on his list, Hal's thread goes unread when another letter comes.
  await letters(halPage).getByRole("button", { name: "Back to your letters" }).click();
  const row = letters(halPage).getByRole("button", { name: new RegExp(title) });
  await expect(row).toBeVisible();
  await expect(row).not.toContainText("unread");
  await compose.fill("Bring rope.");
  await letters(page).getByRole("button", { name: "Send" }).click();
  await expect(row).toContainText("1 unread");
  await expect(letters(halPage).getByRole("heading", { name: /^Letters/ })).toContainText("1 unread");

  // Opening it reads it.
  await row.click();
  await expect(letters(halPage).getByRole("log").getByText("Bring rope.")).toBeVisible();
  await expect(letters(halPage).getByRole("heading", { name: /^Letters/ })).not.toContainText("unread");

  await other.close();
});

test.describe("at 375px", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("Letters and its open thread never scroll sideways", async ({ page, signIn, apiAs, newPerson }) => {
    const [ada, bo] = await Promise.all([newPerson("Ada Quillfeather-Underhollow"), newPerson("Bo Fenn")]);
    const title = "t221 A Campaign Whose Name Runs On Well Past The Width Of Any Phone";
    const adaApi = await apiAs(ada);
    const id = await campaignFor(adaApi, await apiAs(bo), title);
    const sent = await adaApi.post(`/api/threads/${encodeURIComponent(`campaign:${id}`)}/messages`, {
      data: { body: `An unbroken word: ${"Lanternlight".repeat(12)}`, clientId: `t221-${Date.now()}` },
    });
    expect(sent.ok(), await sent.text()).toBe(true);

    await signIn(ada);
    await page.goto("/");
    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    const row = letters(page).getByRole("button", { name: /t221 A Campaign Whose Name/ });
    await expect(row).toBeVisible();
    expect(await sideways()).toBeLessThanOrEqual(0);

    await row.click();
    await expect(letters(page).getByRole("log").getByText(/An unbroken word/)).toBeVisible();
    await expect(letters(page).getByRole("textbox", { name: "Write a letter" })).toBeVisible();
    expect(await sideways()).toBeLessThanOrEqual(0);
  });
});
