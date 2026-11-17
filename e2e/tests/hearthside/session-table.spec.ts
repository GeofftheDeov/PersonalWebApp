/**
 * A session's round table (#227): quest slips by each seat (ticked there,
 * and shown done in Your Quests), the GM's "+ quest" before the session,
 * attendance taken by tapping seats, the ready check colouring the seats,
 * the card in the middle, and `#quests` links landing at the table. Each
 * test makes its own GM, players, campaign and session, so the seeded party
 * is left alone, and signs in one viewer.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "../../fixtures";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** A first visit compiles the route in dev mode, which can take most of the 15s assertion budget. */
const FIRST_LOAD = { timeout: 45_000 };

/** A campaign `gm` runs that each of `players` has joined. */
async function campaignOf(gm: APIRequestContext, players: APIRequestContext[], title = "t227 The Round Table") {
  const made = await gm.post("/api/campaigns", {
    data: { title, description: "For a session's table (#227).", status: "In Progress", startDate: new Date().toISOString() },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const campaignId = String((await made.json()).campaign.id);
  for (const p of players) expect((await p.post(`/api/campaigns/${campaignId}/join`)).ok()).toBe(true);
  return campaignId;
}

/** A session `startsIn` from now (negative: already played), three hours long. Returns its id and start. */
async function sessionOf(gm: APIRequestContext, campaignId: string, title: string, startsIn: number, extra: Record<string, unknown> = {}) {
  const start = new Date(Date.now() + startsIn);
  const made = await gm.post("/api/tabletop/sessions", {
    data: { title, campaign: campaignId, date: start.toISOString(), endDate: new Date(start.getTime() + 3 * HOUR).toISOString(), ...extra },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const s = await made.json();
  return { id: String(s._id ?? s.id), start };
}

async function questFor(gm: APIRequestContext, sessionId: string, assigneeId: string, title: string) {
  const made = await gm.post(`/api/quests/sessions/${sessionId}`, { data: { title, assigneeId } });
  expect(made.ok(), await made.text()).toBe(true);
  return String((await made.json()).id);
}

const theTable = (page: Page) => page.getByRole("region", { name: "Around the table" });
const seatOf = (page: Page, name: string) => theTable(page).getByRole("group", { name: `${name}’s seat` });
const heading = (page: Page) => page.getByRole("heading", { level: 1 });

test("a #quests link lands at the table, and a quest ticked there shows done in Your Quests", async ({ page, signIn, apiAs, newPerson }) => {
  const [gm, player] = await Promise.all([newPerson("Odile Marsh"), newPerson("Piet Lark")]);
  const gmApi = await apiAs(gm);
  const campaignId = await campaignOf(gmApi, [await apiAs(player)]);
  const { id } = await sessionOf(gmApi, campaignId, "t227 Supper at the Gull", 3 * DAY);
  const title = "Bring the lamp oil";
  const questId = await questFor(gmApi, id, player.id, title);

  await signIn(player);
  await page.goto(`/sessions/${id}#quests`);
  await expect(heading(page)).toHaveText("t227 Supper at the Gull", FIRST_LOAD);
  const table = theTable(page);
  // Landed at the table: its top is at the top of the window, under the bar.
  await expect.poll(async () => (await table.boundingBox())?.y ?? Infinity).toBeLessThan(200);
  // The middle of the table counts down to the session.
  await expect(table.getByText(/^Starts in 2 days, 23 hours$|^Starts in 3 days$/)).toBeVisible();

  const slips = seatOf(page, "Piet Lark").getByRole("list", { name: "Your quests" });
  const done = page.waitForResponse((r) => r.url().includes(`/api/quests/${questId}/done`) && r.request().method() === "POST");
  await slips.getByRole("checkbox", { name: `${title}: mark done` }).click();
  expect((await done).ok()).toBe(true);
  await expect(slips.getByRole("checkbox", { name: `${title}: done` })).toBeChecked();

  const rail = page.getByRole("region", { name: "Your Quests" });
  await expect(rail.getByRole("checkbox", { name: `${title}: done` })).toBeChecked();
  await expect(rail.getByText("0 open", { exact: true })).toBeVisible();
});

test("the GM confirms attendance, and the absent player's seat goes grey", async ({ page, signIn, apiAs, newPerson }) => {
  const [gm, came, away] = await Promise.all([newPerson("Odile Marsh"), newPerson("Piet Lark"), newPerson("Wren Hollis")]);
  const gmApi = await apiAs(gm);
  const campaignId = await campaignOf(gmApi, [await apiAs(came), await apiAs(away)]);
  const { id } = await sessionOf(gmApi, campaignId, "t227 The Night Before", -2 * DAY);

  await signIn(gm);
  await page.goto(`/sessions/${id}`);
  await expect(heading(page)).toHaveText("t227 The Night Before", FIRST_LOAD);
  const table = theTable(page);
  await expect(table.getByText("No recording yet")).toBeVisible();

  await table.getByRole("button", { name: "Take attendance" }).click();
  await seatOf(page, "Odile Marsh").getByRole("button", { name: "Odile Marsh: away" }).click();
  await seatOf(page, "Piet Lark").getByRole("button", { name: "Piet Lark: away" }).click();
  await expect(seatOf(page, "Piet Lark").getByRole("button", { name: "Piet Lark: came" })).toHaveAttribute("aria-pressed", "true");
  const saved = page.waitForResponse((r) => r.url().endsWith(`/api/tabletop/sessions/${id}/attendance`) && r.request().method() === "PUT");
  await table.getByRole("button", { name: "Confirm: 2 of 3 came" }).click();
  expect((await saved).ok()).toBe(true);

  const absent = seatOf(page, "Wren Hollis");
  await expect(absent).toHaveClass(/\bis-away\b/);
  await expect(absent.getByText("Away", { exact: true })).toBeVisible();
  await expect(seatOf(page, "Piet Lark")).not.toHaveClass(/\bis-away\b/);
  await expect(table.getByText("2 of 3 came.")).toBeVisible();

  // Saved: the record names exactly who came.
  const record = await (await gmApi.get(`/api/tabletop/sessions/${id}/attendance`)).json();
  expect(record.confirmedAt).toBeTruthy();
  expect(record.people.filter((p: any) => p.attended).map((p: any) => p.playerId).sort()).toEqual([came.id, gm.id].sort());
});

test("before the session the GM adds a quest at a seat, and the ready check colours the seats", async ({ page, signIn, apiAs, newPerson }) => {
  const [gm, ready, notReady] = await Promise.all([newPerson("Odile Marsh"), newPerson("Piet Lark"), newPerson("Wren Hollis")]);
  const gmApi = await apiAs(gm);
  const [readyApi, notReadyApi] = [await apiAs(ready), await apiAs(notReady)];
  const campaignId = await campaignOf(gmApi, [readyApi, notReadyApi]);
  const { id, start } = await sessionOf(gmApi, campaignId, "t227 Before the Storm", 2 * HOUR);
  // The answers, through the existing endpoint (the second player changes their mind).
  const answer = async (api: APIRequestContext, ready: boolean) => {
    const res = await api.post(`/api/tabletop/sessions/${id}/ready`, { data: { ready } });
    expect(res.ok(), await res.text()).toBe(true);
  };
  await answer(readyApi, true);
  await answer(notReadyApi, true);
  await answer(notReadyApi, false);

  await signIn(gm);
  await page.goto(`/sessions/${id}`);
  await expect(heading(page)).toHaveText("t227 Before the Storm", FIRST_LOAD);
  await expect(seatOf(page, "Piet Lark")).toHaveClass(/\bis-ready\b/);
  await expect(seatOf(page, "Piet Lark").getByText("Ready", { exact: true })).toBeVisible();
  await expect(seatOf(page, "Wren Hollis")).toHaveClass(/\bis-not-ready\b/);
  await expect(seatOf(page, "Wren Hollis").getByText("Can’t make it", { exact: true })).toBeVisible();

  const seat = seatOf(page, "Piet Lark");
  await seat.getByRole("button", { name: "Add a quest for Piet Lark" }).click();
  const made = page.waitForResponse((r) => r.url().endsWith(`/api/quests/sessions/${id}`) && r.request().method() === "POST");
  await seat.getByRole("textbox", { name: /^New quest for Piet Lark/ }).fill("Bring the storm lantern");
  await seat.getByRole("textbox", { name: /^New quest for Piet Lark/ }).press("Enter");
  expect((await made).ok()).toBe(true);
  await expect(seat.getByRole("list", { name: "Piet Lark’s quests" }).getByText("Bring the storm lantern")).toBeVisible();
  await expect(seat.getByRole("textbox")).toHaveCount(0);

  // It's that player's, due when the session starts.
  const theirs = await (await readyApi.get("/api/quests/mine?scope=all")).json();
  const quest = theirs.quests.find((q: any) => q.title === "Bring the storm lantern");
  expect(quest?.sessionId).toBe(id);
  expect(Date.parse(quest.dueAt)).toBe(start.getTime());
});

test.describe("at 375px", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("nothing at the table scrolls sideways", async ({ page, signIn, apiAs, newPerson }) => {
    const long = "Extraordinarily".repeat(3);
    const [gm, a, b, c] = await Promise.all([
      newPerson("Odile Marsh"), newPerson(`Piet ${long}`), newPerson("Wren Hollis"), newPerson("Ana Brightwater-Sollens"),
    ]);
    const gmApi = await apiAs(gm);
    const aApi = await apiAs(a);
    const campaignId = await campaignOf(gmApi, [aApi, await apiAs(b), await apiAs(c)], `t227 The ${long} Table`);
    // Piet plays one adventurer here, so his seat shows it.
    expect((await aApi.post("/api/tabletop/characters", { data: { name: `Kestrel ${long}`, campaign: campaignId } })).ok()).toBe(true);
    const { id } = await sessionOf(gmApi, campaignId, "t227 The Long Night", -DAY, { vodUrl: "https://example.com/recording/t227" });
    await questFor(gmApi, id, a.id, `Fetch the ${long} lantern from the cellar`);
    await questFor(gmApi, id, gm.id, `Paint the ${long} map`);
    await questFor(gmApi, id, c.id, "Bring dice");

    await signIn(gm);
    await page.goto(`/sessions/${id}`);
    await expect(heading(page)).toHaveText("t227 The Long Night", FIRST_LOAD);
    const table = theTable(page);
    await expect(table.getByRole("link", { name: /Watch the recording/ })).toHaveAttribute("href", "https://example.com/recording/t227");
    await expect(seatOf(page, `Piet ${long}`).getByText(`Kestrel ${long}`)).toBeVisible();
    await expect(table.getByText(`Paint the ${long} map`)).toBeVisible();
    await expect(table.getByText("Bring dice")).toBeVisible();
    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await sideways()).toBeLessThanOrEqual(0);
    // The shell clips what overflows, so also check the table and its slips end on screen.
    for (const box of [await table.boundingBox(), await table.getByText(`Paint the ${long} map`).boundingBox()]) {
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    }

    await table.getByRole("button", { name: "Take attendance" }).click();
    await expect(table.getByRole("button", { name: /^Confirm: 0 of 4 came$/ })).toBeVisible();
    expect(await sideways()).toBeLessThanOrEqual(0);
  });
});
