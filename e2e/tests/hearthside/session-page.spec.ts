/**
 * A session's page on Hearthside (#226): the parchment card, previous and
 * next, and the tabs (The tale, Details, Prep notes) with the tab each viewer
 * opens on. Prep notes are the GM's (#213): a player has no tab for them and
 * the session they're sent has no `agenda`. Each test makes its own GM,
 * player, campaign and sessions, so the seeded party is left alone.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "../../fixtures";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** A first visit compiles the route in dev mode, which can take most of the 15s assertion budget. */
const FIRST_LOAD = { timeout: 45_000 };

/** A campaign `gm` runs and `player` has joined. */
async function campaignOf(gm: APIRequestContext, player: APIRequestContext, title = "t226 The Drowned Bell") {
  const made = await gm.post("/api/campaigns", {
    data: { title, description: "For a session's page (#226).", status: "In Progress", startDate: new Date().toISOString() },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const campaignId = String((await made.json()).campaign.id);
  expect((await player.post(`/api/campaigns/${campaignId}/join`)).ok()).toBe(true);
  return campaignId;
}

/** A session `startsIn` from now (negative: already played), three hours long. */
async function sessionOf(gm: APIRequestContext, campaignId: string, title: string, startsIn: number, extra: Record<string, unknown> = {}) {
  const start = Date.now() + startsIn;
  const made = await gm.post("/api/tabletop/sessions", {
    data: {
      title, campaign: campaignId,
      date: new Date(start).toISOString(), endDate: new Date(start + 3 * HOUR).toISOString(),
      ...extra,
    },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const s = await made.json();
  return String(s._id ?? s.id);
}

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const heading = (page: Page) => page.getByRole("heading", { level: 1 });

test("the GM sees and edits Prep notes; a player has no tab for them, and isn't sent them", async ({ page, browser, signIn, apiAs, newPerson }) => {
  const [gm, player] = await Promise.all([newPerson("Mara Quill"), newPerson("Tobin Reed")]);
  const gmApi = await apiAs(gm);
  const campaignId = await campaignOf(gmApi, await apiAs(player));
  const id = await sessionOf(gmApi, campaignId, "t226 Under the Bell", 3 * DAY, { agenda: "The bell rings thrice. Handout 2." });

  // The GM, before the session, opens on Prep notes.
  await signIn(gm);
  await page.goto(`/sessions/${id}`);
  await expect(heading(page)).toHaveText("t226 Under the Bell", FIRST_LOAD);
  await expect(tab(page, "Prep notes")).toHaveAttribute("aria-selected", "true");
  const panel = page.getByRole("tabpanel");
  await expect(panel.getByText("The bell rings thrice. Handout 2.")).toBeVisible();

  await panel.getByRole("button", { name: "Edit the prep notes" }).click();
  await panel.getByRole("textbox", { name: "Prep notes" }).fill("The bell rings four times now.\nBring the sea chart.");
  const saved = page.waitForResponse((r) => r.url().endsWith(`/api/tabletop/sessions/${id}`) && r.request().method() === "PUT");
  await panel.getByRole("button", { name: "Save" }).click();
  expect((await saved).ok()).toBe(true);
  await expect(panel.getByText(/The bell rings four times now\.\s+Bring the sea chart\./)).toBeVisible();

  await page.reload();
  await expect(tab(page, "Prep notes")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel").getByText(/Bring the sea chart\./)).toBeVisible();

  // The player, in their own browser, opens on Details with no Prep notes tab, and the session has no agenda.
  const theirs = await browser.newContext();
  try {
    await signIn(player, theirs);
    const them = await theirs.newPage();
    const read = them.waitForResponse((r) => r.url().endsWith(`/api/tabletop/sessions/${id}`) && r.request().method() === "GET");
    await them.goto(`/sessions/${id}`);
    const body = await (await read).json();
    expect(body).not.toHaveProperty("agenda");
    await expect(heading(them)).toHaveText("t226 Under the Bell", FIRST_LOAD);
    await expect(tab(them, "Details")).toHaveAttribute("aria-selected", "true");
    await expect(tab(them, "The tale")).toBeVisible();
    await expect(tab(them, "Prep notes")).toHaveCount(0);
    await expect(them.getByText(/Bring the sea chart/)).toHaveCount(0);
    await expect(them.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  } finally {
    await theirs.close();
  }
});

test("after the session the GM opens on Details and a player on the tale", async ({ page, browser, signIn, apiAs, newPerson }) => {
  const [gm, player] = await Promise.all([newPerson("Mara Quill"), newPerson("Tobin Reed")]);
  const gmApi = await apiAs(gm);
  const campaignId = await campaignOf(gmApi, await apiAs(player));
  const id = await sessionOf(gmApi, campaignId, "t226 The Bell Falls", -2 * DAY);

  await signIn(gm);
  await page.goto(`/sessions/${id}`);
  await expect(heading(page)).toHaveText("t226 The Bell Falls", FIRST_LOAD);
  await expect(tab(page, "Details")).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, "Prep notes")).toBeVisible();
  await expect(page.getByText("Played", { exact: true })).toBeVisible();

  const theirs = await browser.newContext();
  try {
    await signIn(player, theirs);
    const them = await theirs.newPage();
    await them.goto(`/sessions/${id}`);
    await expect(heading(them)).toHaveText("t226 The Bell Falls", FIRST_LOAD);
    await expect(tab(them, "The tale")).toHaveAttribute("aria-selected", "true");
    await expect(tab(them, "Prep notes")).toHaveCount(0);
  } finally {
    await theirs.close();
  }
});

test("the GM writes the tale in place, and a player reads it", async ({ page, browser, signIn, apiAs, newPerson }) => {
  const [gm, player] = await Promise.all([newPerson("Mara Quill"), newPerson("Tobin Reed")]);
  const gmApi = await apiAs(gm);
  const campaignId = await campaignOf(gmApi, await apiAs(player));
  const id = await sessionOf(gmApi, campaignId, "t226 What the Bell Said", -DAY);

  await signIn(gm);
  await page.goto(`/sessions/${id}`);
  await expect(heading(page)).toHaveText("t226 What the Bell Said", FIRST_LOAD);
  await tab(page, "The tale").click();
  const panel = page.getByRole("tabpanel");
  await panel.getByRole("button", { name: "Write the tale" }).click();
  await panel.getByRole("textbox", { name: "The tale" }).fill("The bell fell silent at midnight.\n\nTobin swore he heard it again on the stair.");
  await panel.getByRole("button", { name: "Save the tale" }).click();
  await expect(panel.getByText("The bell fell silent at midnight.")).toBeVisible();

  // And edits it again, in place.
  await panel.getByRole("button", { name: "Edit the tale" }).click();
  await panel.getByRole("textbox", { name: "The tale" }).fill("The bell fell silent at midnight, and stayed so.\n\nTobin swore he heard it again on the stair.");
  await panel.getByRole("button", { name: "Save the tale" }).click();
  await expect(panel.getByText("The bell fell silent at midnight, and stayed so.")).toBeVisible();

  const theirs = await browser.newContext();
  try {
    await signIn(player, theirs);
    const them = await theirs.newPage();
    await them.goto(`/sessions/${id}`);
    const theirPanel = them.getByRole("tabpanel");
    await expect(theirPanel.getByText("The bell fell silent at midnight, and stayed so.")).toBeVisible(FIRST_LOAD);
    await expect(theirPanel.getByText("Tobin swore he heard it again on the stair.")).toBeVisible();
    await expect(theirPanel.getByRole("button", { name: /tale/ })).toHaveCount(0);
  } finally {
    await theirs.close();
  }
});

test("previous and next walk through the campaign's sessions", async ({ page, signIn, apiAs, newPerson }) => {
  const [gm, player] = await Promise.all([newPerson("Mara Quill"), newPerson("Tobin Reed")]);
  const gmApi = await apiAs(gm);
  const campaignId = await campaignOf(gmApi, await apiAs(player));
  // Made out of order: the page orders them by night.
  const second = await sessionOf(gmApi, campaignId, "t226 Second Bell", -2 * DAY);
  const third = await sessionOf(gmApi, campaignId, "t226 Third Bell", 5 * DAY);
  const first = await sessionOf(gmApi, campaignId, "t226 First Bell", -9 * DAY);

  await signIn(player);
  await page.goto(`/sessions/${first}`);
  await expect(heading(page)).toHaveText("t226 First Bell", FIRST_LOAD);
  await expect(page.getByText("t226 The Drowned Bell · Session 1")).toBeVisible();
  await expect(page.getByRole("link", { name: /^Previous session/ })).toHaveCount(0);

  await page.getByRole("link", { name: "Next session: t226 Second Bell" }).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${second}$`));
  await expect(heading(page)).toHaveText("t226 Second Bell", FIRST_LOAD);
  await expect(page.getByText("t226 The Drowned Bell · Session 2")).toBeVisible();

  await page.getByRole("link", { name: "Next session: t226 Third Bell" }).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${third}$`));
  await expect(heading(page)).toHaveText("t226 Third Bell", FIRST_LOAD);
  await expect(page.getByRole("link", { name: /^Next session/ })).toHaveCount(0);
  // A new session opens on its own default tab: before it, a player's is Details.
  await expect(tab(page, "Details")).toHaveAttribute("aria-selected", "true");

  await page.getByRole("link", { name: "Previous session: t226 Second Bell" }).click();
  await expect(heading(page)).toHaveText("t226 Second Bell", FIRST_LOAD);
});

test.describe("at 375px", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("nothing on a session's page scrolls sideways", async ({ page, signIn, apiAs, newPerson }) => {
    const [gm, player] = await Promise.all([newPerson("Mara Quill"), newPerson("Tobin Reed")]);
    const gmApi = await apiAs(gm);
    const long = "Extraordinarily".repeat(4);
    const campaignId = await campaignOf(gmApi, await apiAs(player), `t226 The ${long} Bell`);
    await sessionOf(gmApi, campaignId, `t226 Before the ${long} Bell`, -3 * DAY);
    const id = await sessionOf(gmApi, campaignId, `t226 The ${long} Bell Tolls`, 2 * DAY, {
      isOnline: true, location: "", agenda: `Prep: ${long} ${long}`,
    });
    await sessionOf(gmApi, campaignId, `t226 After the ${long} Bell`, 9 * DAY);

    await signIn(gm);
    await page.goto(`/sessions/${id}`);
    await expect(heading(page)).toHaveText(`t226 The ${long} Bell Tolls`, FIRST_LOAD);
    await expect(page.getByRole("link", { name: /^Previous session/ })).toBeVisible();
    await expect(tab(page, "Prep notes")).toHaveAttribute("aria-selected", "true");
    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await sideways()).toBeLessThanOrEqual(0);

    await tab(page, "Details").click();
    await expect(page.getByRole("tabpanel").getByText("Online", { exact: true })).toBeVisible();
    expect(await sideways()).toBeLessThanOrEqual(0);

    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.getByRole("dialog", { name: /^Edit / })).toBeVisible();
    expect(await sideways()).toBeLessThanOrEqual(0);
  });
});
