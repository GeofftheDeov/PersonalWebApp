/**
 * A campaign's page, part 2 (#225, spec #69): the Notice Board at
 * `#notice-board` (each notice on parchment, with the GM's Plan a session and
 * the overlap picker), Table Talk beside the party (the same thread Letters
 * lists), and Sessions | Characters (Coming up, Previous sessions, Add a
 * session in a gilded dialog). Each test makes its own people and campaign,
 * so the seeded party is left alone.
 */
import type { APIRequestContext, APIResponse, Page } from "@playwright/test";
import { test, expect } from "../../fixtures";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** A first visit compiles the route in dev mode, which can take most of the 15s assertion budget. */
const FIRST_LOAD = { timeout: 45_000 };

async function ok<T = any>(call: Promise<APIResponse>): Promise<T> {
  const res = await call;
  expect(res.ok(), `${res.url()}: ${res.status()} ${await res.text()}`).toBe(true);
  return res.json();
}

/** A campaign `gm` runs, with `players` joined. */
async function campaignOf(gm: APIRequestContext, players: APIRequestContext[], title: string) {
  const made = await ok(gm.post("/api/campaigns", {
    data: { title, description: "For a campaign's page, part 2 (#225).", status: "In Progress", startDate: "2026-03-14" },
  }));
  const id = String(made.campaign.id);
  for (const p of players) await ok(p.post(`/api/campaigns/${id}/join`));
  return id;
}

/** Two nights next week, three hours each. */
const nights = () => [7, 8].map((d) => {
  const start = Math.floor((Date.now() + d * DAY) / HOUR) * HOUR;
  return { start: new Date(start).toISOString(), end: new Date(start + 3 * HOUR).toISOString() };
});

/** A datetime-local value `days` from now at `hour`, in the browser's (and this process's) time zone. */
function localInput(days: number, hour: number): string {
  const d = new Date(Date.now() + days * DAY);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(hour)}:00`;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const letters = (page: Page) => page.getByRole("complementary", { name: "Letters" });
const noticeBoard = (page: Page) => page.getByRole("region", { name: /^The Notice Board/ });

test("a #notice-board link lands on the campaign's Notice Board", async ({ page, signIn, apiAs, newPerson }) => {
  const [gm, player] = await Promise.all([newPerson("Mara Quill"), newPerson("Tobin Reed")]);
  const [gmApi, playerApi] = await Promise.all([apiAs(gm), apiAs(player)]);
  const title = "t225 The Drowned Bell";
  const id = await campaignOf(gmApi, [playerApi], title);
  const started = await ok(gmApi.post(`/api/planning/campaigns/${id}/kickoff`, { data: { title: "t225 Under the Bell", isOnline: true } }));
  await ok(gmApi.post(`/api/planning/sessions/${started.session.id}/shortlist`, { data: { options: nights() } }));

  // From the Hearth, the notice's link to its campaign's board.
  await signIn(player);
  await page.goto("/");
  const onHearth = page.getByRole("article", { name: "t225 Under the Bell" });
  await expect(onHearth).toBeVisible(FIRST_LOAD);
  await onHearth.getByRole("link", { name: `${title}’s Notice Board →` }).click();

  await expect(page).toHaveURL(new RegExp(`/campaigns/${id}#notice-board$`), FIRST_LOAD);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible(FIRST_LOAD);
  const board = noticeBoard(page);
  const notice = board.getByRole("article", { name: "t225 Under the Bell" });
  await expect(notice).toBeVisible();
  // Scrolled to: the board's heading sits just under the top bar, with the notice in view.
  await expect.poll(async () => (await board.boundingBox())!.y).toBeLessThan(160);
  await expect(board.getByRole("heading", { level: 2, name: /^The Notice Board/ })).toBeInViewport();
  await expect(notice).toBeInViewport();
  await expect(notice).toHaveClass(/\bhs-sheet\b/);
  await expect(notice.getByRole("checkbox", { name: /^I can make / })).toHaveCount(2);
});

test("the GM plans a session on the board, shortlisting nights from the availability grid", async ({ page, signIn, apiAs, newPerson }) => {
  const [gm, player] = await Promise.all([newPerson("Odile Marsh"), newPerson("Pip Hollow")]);
  const [gmApi, playerApi] = await Promise.all([apiAs(gm), apiAs(player)]);
  const id = await campaignOf(gmApi, [playerApi], "t225 The Salt Road");
  // Both free every evening from 5 to 11, in this machine's (and so the browser's) time zone.
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const week = Array.from({ length: 7 }, (_, weekday) => ({ weekday, start: "17:00", end: "23:00", timeZone }));
  await Promise.all([gmApi, playerApi].map((api) => ok(api.put("/api/availability/me/windows", { data: { windows: week } }))));

  await signIn(gm);
  await page.goto(`/campaigns/${id}`);
  const board = noticeBoard(page);
  await expect(board.getByText("Nothing pinned up.", { exact: false })).toBeVisible(FIRST_LOAD);
  await board.getByRole("button", { name: "Plan a session" }).click();
  const fresh = board.getByRole("article", { name: "A new notice" });
  await fresh.getByLabel("Session title").fill("t225 The Toll House");
  await fresh.getByRole("button", { name: "Start planning" }).click();

  const notice = board.getByRole("article", { name: "t225 The Toll House" });
  await expect(notice.getByText("Pick some nights")).toBeVisible();
  await expect(fresh).toHaveCount(0);
  // The grid: days across (14 of them), start times down, from 5 pm.
  const grid = notice.getByRole("table", { name: "Every start time · free count" });
  await expect(grid.getByRole("columnheader")).toHaveCount(14);
  await expect(grid.getByRole("rowheader").first()).toHaveText("5 pm");
  const free = grid.getByRole("button", { name: /: 2 of 2 free$/ });
  await free.nth(0).click();
  await free.nth(1).click();
  await expect(notice.getByRole("list", { name: "The shortlist" }).getByRole("listitem")).toHaveCount(2);
  await notice.getByRole("button", { name: "Send to the party" }).click();

  await expect(notice.getByText("Awaiting votes · 0 of 2")).toBeVisible();
  await expect(notice.getByRole("checkbox", { name: /^I can make / })).toHaveCount(2);
  const boardRead = await ok(gmApi.get(`/api/planning/campaigns/${id}`));
  expect(boardRead.planning).toHaveLength(1);
  expect(boardRead.planning[0].night.options).toHaveLength(2);
});

test("adding a session through the dialog shows it under Coming up", async ({ page, signIn, apiAs, newPerson }) => {
  const gm = await newPerson("Wren Talbot");
  const gmApi = await apiAs(gm);
  const id = await campaignOf(gmApi, [], "t225 The Glass Archive");

  await signIn(gm);
  await page.goto(`/campaigns/${id}`);
  const records = page.getByRole("region", { name: "Campaign records" });
  await expect(records.getByText("Nothing scheduled yet.")).toBeVisible(FIRST_LOAD);
  await records.getByRole("button", { name: "Add a session" }).click();

  const dialog = page.getByRole("dialog", { name: "Add a session" });
  await dialog.getByLabel("Title").fill("t225 The Reading Room");
  await dialog.getByLabel(/^Starts/).fill(localInput(10, 19));
  await dialog.getByLabel(/^Ends/).fill(localInput(10, 23));
  await dialog.getByRole("switch", { name: "Online session" }).click();
  await expect(dialog.getByRole("switch", { name: "Online session" })).toHaveAttribute("aria-checked", "true");
  await dialog.getByRole("button", { name: "Add the session" }).click();
  await expect(dialog).toBeHidden();

  const comingUp = records.getByRole("list", { name: "Coming up" });
  const row = comingUp.getByRole("link", { name: /t225 The Reading Room/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Online");
  const sessions = await ok(gmApi.get(`/api/campaigns/${id}/sessions`));
  const made = sessions.find((s: any) => s.title === "t225 The Reading Room");
  expect(made).toBeTruthy();
  await expect(row).toHaveAttribute("href", `/sessions/${made._id ?? made.id}`);
  // Still to come, so not among the previous ones.
  await expect(records.getByText("No sessions logged yet.")).toBeVisible();
});

test("a Table Talk message appears in Letters too", async ({ page, signIn, apiAs, newPerson }) => {
  const [gm, player] = await Promise.all([newPerson("Hollis Brand"), newPerson("Tamsin Oak")]);
  const [gmApi, playerApi] = await Promise.all([apiAs(gm), apiAs(player)]);
  const title = "t225 The Lantern Court";
  const id = await campaignOf(gmApi, [playerApi], title);

  await signIn(player);
  await page.goto(`/campaigns/${id}`);
  const talk = page.getByRole("region", { name: /^Table Talk/ });
  await expect(talk.getByText("Live", { exact: true })).toBeVisible(FIRST_LOAD);
  // Being on the page puts you among those here now.
  await expect(talk.getByRole("list", { name: "Here now" }).getByRole("listitem")).toHaveCount(1);
  await talk.getByRole("textbox", { name: "Write a letter" }).fill("The lanterns are lit in the court.");
  await talk.getByRole("button", { name: "Send" }).click();
  await expect(talk.getByRole("log").getByText("The lanterns are lit in the court.")).toBeVisible();
  await expect(talk.getByRole("log").getByText("sending…")).toHaveCount(0);

  // The same thread, in Letters.
  await letters(page).getByRole("button", { name: new RegExp(escape(title)) }).click();
  await expect(letters(page).getByRole("log", { name: `Letters with ${title}` }).getByText("The lanterns are lit in the court.")).toBeVisible();
  // And on the server, in the campaign's thread.
  const sent = await ok(gmApi.get(`/api/threads/${encodeURIComponent(`campaign:${id}`)}/messages`));
  const bodies = sent.messages.map((m: { body: string }) => m.body);
  expect(bodies).toContain("The lanterns are lit in the court.");
});

test.describe("at 375px", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("the board, its picker, Table Talk and the records never scroll sideways", async ({ page, signIn, apiAs, newPerson }) => {
    const [gm, player] = await Promise.all([newPerson("Corin Vale"), newPerson("Bartholomew Featherstonehaugh-Wainwright")]);
    const [gmApi, playerApi] = await Promise.all([apiAs(gm), apiAs(player)]);
    const id = await campaignOf(gmApi, [playerApi], "t225 The Extraordinarily Long-Winded Chronicle of the Unpronounceable Archipelagos");
    // A notice waiting on the GM's nights (so the picker shows), and a session still to come.
    await ok(gmApi.post(`/api/planning/campaigns/${id}/kickoff`, {
      data: { title: "t225 A Supper at the Crossroads Inn and Coaching House", isOnline: false, foodMode: "potluck" },
    }));
    const [n] = nights();
    await ok(gmApi.post("/api/tabletop/sessions", { data: { campaign: id, title: "t225 The Long Night Watch at Saltmarsh", date: n.start, endDate: n.end, isOnline: true } }));

    await signIn(gm);
    await page.goto(`/campaigns/${id}`);
    const notice = noticeBoard(page).getByRole("article", { name: /Crossroads Inn/ });
    await expect(notice.getByRole("table", { name: "Every start time · free count" })).toBeVisible(FIRST_LOAD);
    await expect(page.getByRole("region", { name: /^Table Talk/ }).getByRole("textbox", { name: "Write a letter" })).toBeVisible();
    const records = page.getByRole("region", { name: "Campaign records" });
    await expect(records.getByRole("list", { name: "Coming up" }).getByRole("link", { name: /Long Night Watch/ })).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    const box = (await notice.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(375);

    // Changing a night opens a picker under the row; the add-session dialog fits too.
    await records.getByRole("button", { name: /^Change the night of / }).click();
    await expect(records.getByRole("article", { name: /^Change the night of / }).getByRole("table")).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await records.getByRole("button", { name: "Add a session" }).click();
    await expect(page.getByRole("dialog", { name: "Add a session" })).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await page.getByRole("dialog", { name: "Add a session" }).getByRole("button", { name: "Cancel" }).click();

    await records.getByRole("tab", { name: /^Characters/ }).click();
    await expect(records.getByText("No characters in this party yet.")).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });
});
