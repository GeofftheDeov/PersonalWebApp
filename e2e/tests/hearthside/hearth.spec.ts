/**
 * The Hearth, Hearthside's home (#222): the greeting, and the Notice Board,
 * one parchment sheet for each session being planned in the player's
 * campaigns, with its numbered steps and its vote. A vote cast there
 * registers on the server. With nothing being planned, a note on the floor
 * says so. Each test makes its own people, campaign and session, so the
 * seeded party is left alone, and signs in one viewer.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "../../fixtures";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** A first visit compiles the route in dev mode, which can take most of the 15s assertion budget. */
const FIRST_LOAD = { timeout: 45_000 };

async function ok<T = any>(call: Promise<import("@playwright/test").APIResponse>): Promise<T> {
  const res = await call;
  expect(res.ok(), `${res.url()}: ${res.status()} ${await res.text()}`).toBe(true);
  return res.json();
}

/** A campaign `gm` runs; `player`, if any, has joined it. */
async function campaignOf(gm: APIRequestContext, title: string, player?: APIRequestContext) {
  const made = await ok(gm.post("/api/campaigns", {
    data: { title, description: "For the Hearth (#222).", status: "In Progress", startDate: new Date().toISOString() },
  }));
  const campaignId = String(made.campaign.id);
  if (player) await ok(player.post(`/api/campaigns/${campaignId}/join`));
  return campaignId;
}

/** Two nights next week, three hours each, as the GM shortlists them. */
const nights = () => [7, 8].map((d) => {
  const start = Math.floor((Date.now() + d * DAY) / HOUR) * HOUR;
  return { start: new Date(start).toISOString(), end: new Date(start + 3 * HOUR).toISOString() };
});

/** The GM starts planning a session and puts two nights to the party. Returns its planning state. */
async function planned(gm: APIRequestContext, campaignId: string, kickoff: Record<string, unknown>) {
  const started = await ok(gm.post(`/api/planning/campaigns/${campaignId}/kickoff`, { data: kickoff }));
  return ok(gm.post(`/api/planning/sessions/${started.session.id}/shortlist`, { data: { options: nights() } }));
}

const sheet = (page: Page, title: string) => page.getByRole("article", { name: title });

test("a session being planned shows on parchment, and a vote cast there registers", async ({ page, signIn, apiAs, newPerson }) => {
  const [gm, player] = await Promise.all([newPerson("Mara Quill"), newPerson("Tobin Reed")]);
  const gmApi = await apiAs(gm);
  const campaignId = await campaignOf(gmApi, "t222 The Drowned Bell", await apiAs(player));
  const state = await planned(gmApi, campaignId, { title: "t222 Under the Bell", isOnline: true });
  const sessionId = String(state.session.id);

  await signIn(player);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Good (morning|afternoon|evening), Tobin$/, FIRST_LOAD);
  await expect(page.getByRole("main").getByText("One session needs your vote.")).toBeVisible();

  // The notice: parchment (the design system's NoticeSheet), named for the session, under its campaign.
  const notice = sheet(page, "t222 Under the Bell");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveClass(/\bhs-sheet\b/);
  await expect(notice.getByText("t222 The Drowned Bell", { exact: true })).toBeVisible();
  await expect(notice.getByText("Awaiting votes · 0 of 2")).toBeVisible();
  const steps = notice.getByRole("list", { name: "Planning t222 Under the Bell" });
  await expect(steps.getByRole("heading", { level: 4 })).toHaveText([/Pick the night\s*round 1/]);

  // Vote for the first night.
  const boxes = notice.getByRole("checkbox", { name: /^I can make / });
  await expect(boxes).toHaveCount(2);
  await boxes.first().check();
  const cast = page.waitForResponse((r) => r.url().endsWith(`/api/planning/sessions/${sessionId}/vote`) && r.request().method() === "POST");
  await notice.getByRole("button", { name: "Vote: I can make 1" }).click();
  expect((await cast).ok()).toBe(true);

  await expect(notice.getByRole("status")).toHaveText("You’ve voted. You can change it until the vote closes.");
  await expect(notice.getByText("Awaiting votes · 1 of 2")).toBeVisible();
  await expect(notice.getByRole("button", { name: "Update my vote: I can make 1" })).toBeVisible();
  await expect(notice.getByRole("list", { name: "The nights" }).getByRole("listitem").first()).toContainText("1 of 2");
  await expect(page.getByRole("main").getByText("One session is being planned.")).toBeVisible();

  // Registered, not just shown: the server has the ballot, on the night that was ticked.
  const after = await ok(gmApi.get(`/api/planning/sessions/${sessionId}`));
  expect(after.night.voted).toEqual([player.id]);
  expect(after.night.options.map((o: { approvals: string[] }) => o.approvals)).toEqual([[player.id], []]);
});

test("with nothing being planned, a note on the floor says so", async ({ page, signIn, apiAs, newPerson }) => {
  const gm = await newPerson("Mara Quill");
  await campaignOf(await apiAs(gm), "t222 The Quiet Season");

  await signIn(gm);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Good (morning|afternoon|evening), Mara$/, FIRST_LOAD);
  const board = page.getByRole("region", { name: "The Notice Board" });
  await expect(board.getByText("Nothing’s being planned in your campaigns.", { exact: false })).toBeVisible();
  await expect(board.getByRole("article")).toHaveCount(0);
  await expect(page.getByRole("main").getByText("Nothing’s pinned to the Notice Board.")).toBeVisible();
});

test.describe("at 375px", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("a notice on its venue step fits: nothing scrolls sideways", async ({ page, signIn, apiAs, newPerson }) => {
    const [gm, player] = await Promise.all([newPerson("Mara Quill"), newPerson("Tobin Reed")]);
    const [gmApi, playerApi] = [await apiAs(gm), await apiAs(player)];
    const campaignId = await campaignOf(gmApi, "t222 The Long Road to Saltmarsh Abbey", playerApi);
    // In person, with a potluck: both vote for the first night, which sets it and opens the venue vote.
    const state = await planned(gmApi, campaignId, { title: "t222 A Supper at the Crossroads Inn", isOnline: false, foodMode: "potluck" });
    const sessionId = String(state.session.id);
    const vote = { data: { optionIds: [state.night.options[0].id] } };
    await ok(gmApi.post(`/api/planning/sessions/${sessionId}/vote`, vote));
    await ok(playerApi.post(`/api/planning/sessions/${sessionId}/vote`, vote));
    await ok(gmApi.post(`/api/planning/sessions/${sessionId}/suggest-venue`, {
      data: { name: "The Crossroads Inn and Coaching House", address: "14 Old Saltmarsh Turnpike, Lower Wickham-on-the-Water", kind: "store" },
    }));

    await signIn(player);
    await page.goto("/");
    const notice = sheet(page, "t222 A Supper at the Crossroads Inn");
    await expect(notice).toBeVisible(FIRST_LOAD);
    await expect(notice.getByRole("list", { name: /^Planning / }).getByRole("heading", { level: 4 }))
      .toHaveText([/The night/, /Pick the venue\s*round 1/, /Food/]);
    await expect(notice.getByRole("radio", { name: "Pick The Crossroads Inn and Coaching House" })).toBeVisible();
    await expect(notice.getByText("14 Old Saltmarsh Turnpike, Lower Wickham-on-the-Water")).toBeVisible();

    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await sideways()).toBeLessThanOrEqual(0);
    // The sheet itself stays inside the 16px gutters.
    const box = (await notice.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);

    // Opening the suggestion form doesn't push it wider either.
    await notice.getByRole("button", { name: "Suggest a venue" }).click();
    await expect(notice.getByRole("form", { name: "Suggest a venue" })).toBeVisible();
    expect(await sideways()).toBeLessThanOrEqual(0);
  });
});
