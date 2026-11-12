/**
 * Your Quests in the Hearthside rail (#221): your quests, ticked off in
 * place through the existing quests API. Each test makes its own people,
 * campaign, session and quest, so the seeded party is left alone.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "../../fixtures";

const DAY = 24 * 60 * 60 * 1000;

/** A campaign `gm` runs, `player` has joined, with a session in three days and a quest on it for `player`. */
async function questFor(gm: APIRequestContext, player: APIRequestContext, playerId: string, title: string) {
  const made = await gm.post("/api/campaigns", {
    data: { title: "t221 The Quest Board", description: "For Your Quests (#221).", status: "In Progress", startDate: new Date().toISOString() },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const campaignId = String((await made.json()).campaign.id);
  expect((await player.post(`/api/campaigns/${campaignId}/join`)).ok()).toBe(true);

  const start = Date.now() + 3 * DAY;
  const night = await gm.post("/api/tabletop/sessions", {
    data: {
      title: "t221 Night at the Lantern", campaign: campaignId,
      date: new Date(start).toISOString(), endDate: new Date(start + 3 * 60 * 60 * 1000).toISOString(),
    },
  });
  expect(night.ok(), await night.text()).toBe(true);
  const session = await night.json();
  const sessionId = String(session._id ?? session.id);

  const quest = await gm.post(`/api/quests/sessions/${sessionId}`, {
    data: { title, assigneeId: playerId, notes: "Two flasks, from the chandler on Pier Street." },
  });
  expect(quest.ok(), await quest.text()).toBe(true);
  return { questId: String((await quest.json()).id), sessionId };
}

const yourQuests = (page: Page) => page.getByRole("region", { name: "Your Quests" });

test("a quest ticked in the rail stays done after a reload", async ({ page, signIn, apiAs, newPerson }) => {
  const [gm, player] = await Promise.all([newPerson("Odile Marsh"), newPerson("Piet Lark")]);
  const title = "Bring the lamp oil";
  const { questId, sessionId } = await questFor(await apiAs(gm), await apiAs(player), player.id, title);

  await signIn(player);
  await page.goto("/");
  const rail = yourQuests(page);
  await expect(rail.getByText("1 open", { exact: true })).toBeVisible();
  await expect(rail.getByRole("link", { name: /t221 Night at the Lantern/ })).toHaveAttribute("href", `/sessions/${sessionId}#quests`);

  const done = page.waitForResponse((r) => r.url().includes(`/api/quests/${questId}/done`) && r.request().method() === "POST");
  await rail.getByRole("checkbox", { name: `${title}: mark done` }).click();
  expect((await done).ok()).toBe(true);
  await expect(rail.getByRole("checkbox", { name: `${title}: done` })).toBeChecked();
  await expect(rail.getByText("0 open", { exact: true })).toBeVisible();

  await page.reload();
  await expect(rail.getByRole("checkbox", { name: `${title}: done` })).toBeChecked();
  await expect(rail.getByRole("checkbox", { name: `${title}: done` })).toBeDisabled();
  await expect(rail.getByText("0 open", { exact: true })).toBeVisible();
});

test.describe("at 375px", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("Your Quests sits under the bar and nothing scrolls sideways", async ({ page, signIn, apiAs, newPerson }) => {
    const [gm, player] = await Promise.all([newPerson("Odile Marsh"), newPerson("Piet Lark")]);
    const title = `Fetch the ${"Extraordinarily".repeat(6)} lantern`;
    await questFor(await apiAs(gm), await apiAs(player), player.id, title);

    await signIn(player);
    await page.goto("/");
    await expect(yourQuests(page).getByRole("checkbox", { name: `${title}: mark done` })).toBeVisible();
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(sideways).toBeLessThanOrEqual(0);
  });
});
