/**
 * A session's page on Hearthside (#226): the parchment card, previous and
 * next, and the tabs (The tale, Details, Prep notes) with the tab each viewer
 * opens on. Prep notes are the GM's (#213): a player has no tab for them and
 * the session they're sent has no `agenda`. Each test makes its own GM,
 * player, campaign and sessions, so the seeded party is left alone, and
 * signs in one viewer, so its page loads fit the budget on a busy run.
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

test.describe("Prep notes", () => {
  test("the GM opens on them before the session and edits them in place", async ({ page, signIn, apiAs, newPerson }) => {
    const [gm, player] = await Promise.all([newPerson("Mara Quill"), newPerson("Tobin Reed")]);
    const gmApi = await apiAs(gm);
    const campaignId = await campaignOf(gmApi, await apiAs(player));
    const id = await sessionOf(gmApi, campaignId, "t226 Under the Bell", 3 * DAY, { agenda: "The bell rings thrice. Handout 2." });

    await signIn(gm);
    await page.goto(`/sessions/${id}`);
    await expect(heading(page)).toHaveText("t226 Under the Bell", FIRST_LOAD);
    await expect(tab(page, "Prep notes")).toHaveAttribute("aria-selected", "true");
    const panel = page.getByRole("tabpanel");
    await expect(panel.getByText("The bell rings thrice. Handout 2.")).toBeVisible();

    await panel.getByRole("button", { name: "Edit the prep notes" }).click();
    await panel.getByRole("textbox", { name: "Prep notes" }).fill("The bell rings four times now.\nBring the sea chart.");
    const saved = page.waitForResponse((r) => r.url().endsWith(`/api/tabletop/sessions/${id}`) && r.request().method() === "PUT");
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await expect(panel.getByText(/The bell rings four times now\.\s+Bring the sea chart\./)).toBeVisible();

    // Saved, not just shown: the server sends them back to the GM.
    const read = await gmApi.get(`/api/tabletop/sessions/${id}`);
    expect((await read.json()).agenda).toBe("The bell rings four times now.\nBring the sea chart.");
  });

  test("a player has no tab for them, opens on Details before the session, and isn't sent them", async ({ page, signIn, apiAs, newPerson }) => {
    const [gm, player] = await Promise.all([newPerson("Mara Quill"), newPerson("Tobin Reed")]);
    const gmApi = await apiAs(gm);
    const campaignId = await campaignOf(gmApi, await apiAs(player));
    const id = await sessionOf(gmApi, campaignId, "t226 Under the Bell", 3 * DAY, { agenda: "Bring the sea chart." });

    await signIn(player);
    const read = page.waitForResponse((r) => r.url().endsWith(`/api/tabletop/sessions/${id}`) && r.request().method() === "GET");
    await page.goto(`/sessions/${id}`);
    const body = await (await read).json();
    expect(body.title).toBe("t226 Under the Bell");
    expect(body).not.toHaveProperty("agenda");

    await expect(heading(page)).toHaveText("t226 Under the Bell", FIRST_LOAD);
    await expect(tab(page, "Details")).toHaveAttribute("aria-selected", "true");
    await expect(tab(page, "The tale")).toBeVisible();
    await expect(tab(page, "Prep notes")).toHaveCount(0);
    await expect(page.getByText(/Bring the sea chart/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  });
});

test.describe("after the session", () => {
  test("the GM opens on Details", async ({ page, signIn, apiAs, newPerson }) => {
    const [gm, player] = await Promise.all([newPerson("Mara Quill"), newPerson("Tobin Reed")]);
    const gmApi = await apiAs(gm);
    const id = await sessionOf(gmApi, await campaignOf(gmApi, await apiAs(player)), "t226 The Bell Falls", -2 * DAY);

    await signIn(gm);
    await page.goto(`/sessions/${id}`);
    await expect(heading(page)).toHaveText("t226 The Bell Falls", FIRST_LOAD);
    await expect(tab(page, "Details")).toHaveAttribute("aria-selected", "true");
    await expect(tab(page, "Prep notes")).toBeVisible();
    await expect(page.getByText("Played", { exact: true })).toBeVisible();
  });

  test("a player opens on the tale and reads it", async ({ page, signIn, apiAs, newPerson }) => {
    const [gm, player] = await Promise.all([newPerson("Mara Quill"), newPerson("Tobin Reed")]);
    const gmApi = await apiAs(gm);
    const id = await sessionOf(gmApi, await campaignOf(gmApi, await apiAs(player)), "t226 The Bell Falls", -2 * DAY);
    // The tale as the GM's page saves it (PUT {summary} alone).
    const told = await gmApi.put(`/api/tabletop/sessions/${id}`, {
      data: { summary: "The bell fell silent at midnight.\n\nTobin swore he heard it again on the stair." },
    });
    expect(told.ok(), await told.text()).toBe(true);

    await signIn(player);
    await page.goto(`/sessions/${id}`);
    await expect(heading(page)).toHaveText("t226 The Bell Falls", FIRST_LOAD);
    await expect(tab(page, "The tale")).toHaveAttribute("aria-selected", "true");
    await expect(tab(page, "Prep notes")).toHaveCount(0);
    const panel = page.getByRole("tabpanel");
    await expect(panel.getByText("The bell fell silent at midnight.")).toBeVisible();
    await expect(panel.getByText("Tobin swore he heard it again on the stair.")).toBeVisible();
    await expect(panel.getByRole("button", { name: /tale/ })).toHaveCount(0);
  });
});

test("the GM writes the tale in place and edits it, and the party is sent it", async ({ page, signIn, apiAs, newPerson }) => {
  const [gm, player] = await Promise.all([newPerson("Mara Quill"), newPerson("Tobin Reed")]);
  const gmApi = await apiAs(gm);
  const playerApi = await apiAs(player);
  const id = await sessionOf(gmApi, await campaignOf(gmApi, playerApi), "t226 What the Bell Said", -DAY);

  await signIn(gm);
  await page.goto(`/sessions/${id}`);
  await expect(heading(page)).toHaveText("t226 What the Bell Said", FIRST_LOAD);
  await tab(page, "The tale").click();
  const panel = page.getByRole("tabpanel");
  await panel.getByRole("button", { name: "Write the tale" }).click();
  await panel.getByRole("textbox", { name: "The tale" }).fill("The bell fell silent at midnight.\n\nTobin swore he heard it again on the stair.");
  await panel.getByRole("button", { name: "Save the tale" }).click();
  await expect(panel.getByText("The bell fell silent at midnight.")).toBeVisible();

  await panel.getByRole("button", { name: "Edit the tale" }).click();
  await panel.getByRole("textbox", { name: "The tale" }).fill("The bell fell silent at midnight, and stayed so.\n\nTobin swore he heard it again on the stair.");
  await panel.getByRole("button", { name: "Save the tale" }).click();
  await expect(panel.getByText("The bell fell silent at midnight, and stayed so.")).toBeVisible();
  await expect(panel.getByRole("textbox", { name: "The tale" })).toHaveCount(0);

  // The player is sent the tale as written (their page draws it: "a player opens on the tale and reads it").
  const theirs = await (await playerApi.get(`/api/tabletop/sessions/${id}`)).json();
  expect(theirs.summary).toBe("The bell fell silent at midnight, and stayed so.\n\nTobin swore he heard it again on the stair.");
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
  await expect(page.getByRole("link", { name: "Previous session: t226 First Bell" })).toHaveAttribute("href", `/sessions/${first}`);

  await page.getByRole("link", { name: "Next session: t226 Third Bell" }).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${third}$`));
  await expect(heading(page)).toHaveText("t226 Third Bell", FIRST_LOAD);
  await expect(page.getByRole("link", { name: /^Next session/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Previous session: t226 Second Bell" })).toHaveAttribute("href", `/sessions/${second}`);
  // A new session opens on its own default tab: before it, a player's is Details.
  await expect(tab(page, "Details")).toHaveAttribute("aria-selected", "true");
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
    // The shell clips what overflows, so also check the back link to the campaign ends on screen.
    const back = await page.getByRole("link", { name: /^← t226 The Extra/ }).boundingBox();
    expect(back).not.toBeNull();
    expect(back!.x + back!.width).toBeLessThanOrEqual(375);

    await tab(page, "Details").click();
    await expect(page.getByRole("tabpanel").getByText("Online", { exact: true })).toBeVisible();
    expect(await sideways()).toBeLessThanOrEqual(0);

    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.getByRole("dialog", { name: /^Edit / })).toBeVisible();
    expect(await sideways()).toBeLessThanOrEqual(0);
  });
});
