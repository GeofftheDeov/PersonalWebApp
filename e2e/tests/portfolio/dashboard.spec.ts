/**
 * The portfolio's dashboard (#233): chats under the Profile card and the open
 * chat's log where the task list was, live between two people in two
 * browsers, and taking turns at phone width. Each test makes its own people
 * and campaigns, so the seeded party is left alone.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "../../fixtures";

/** The dashboard's first visit compiles it (dev mode): give it the navigation budget. */
const FIRST_LOAD = { timeout: 45_000 };

/** A campaign `gm` runs and `player` has joined: its chat is a thread for both. */
async function campaignFor(gm: APIRequestContext, player: APIRequestContext, title: string): Promise<string> {
  const made = await gm.post("/api/campaigns", {
    data: { title, description: "For the dashboard (#233).", status: "In Progress", startDate: new Date().toISOString() },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const id = String((await made.json()).campaign.id);
  const joined = await player.post(`/api/campaigns/${id}/join`);
  expect(joined.ok(), await joined.text()).toBe(true);
  return id;
}

/** `a` asks `b` to be friends, and `b` accepts. */
async function befriend(a: APIRequestContext, b: APIRequestContext, bId: string) {
  const asked = await a.post("/api/friends/request", { data: { toUserId: bId } });
  expect(asked.ok(), await asked.text()).toBe(true);
  const request = (await (await b.get("/api/friends/requests")).json()).incoming[0];
  const accepted = await b.put(`/api/friends/request/${request._id}`, { data: { action: "accept" } });
  expect(accepted.ok(), await accepted.text()).toBe(true);
}

let sends = 0;
async function post(as: APIRequestContext, threadKey: string, body: string) {
  const sent = await as.post(`/api/threads/${encodeURIComponent(threadKey)}/messages`, {
    data: { body, clientId: `t233-${Date.now()}-${++sends}` },
  });
  expect(sent.ok(), await sent.text()).toBe(true);
}

const chats = (page: Page) => page.getByRole("region", { name: /^Chats/ });
const messages = (page: Page) => page.getByRole("region", { name: "Messages" });
const row = (page: Page, title: string) => chats(page).getByRole("button", { name: new RegExp(title) });

test("the dashboard has chats and messages, and no task list", async ({ page, signIn, apiAs, newPerson }) => {
  const ivo = await newPerson("Ivo Penrose");
  const made = await (await apiAs(ivo)).post("/api/tasks", {
    data: { title: "t233 File the quarterly report", description: "Not on the dashboard.", status: "Not Started", dueDate: new Date().toISOString() },
  });
  expect(made.ok(), await made.text()).toBe(true);

  await signIn(ivo);
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Profile", level: 2 })).toBeVisible(FIRST_LOAD);
  await expect(messages(page).getByText("Pick a chat")).toBeVisible();
  await expect(chats(page).getByText(/No chats yet/)).toBeVisible();

  await expect(page.getByRole("heading", { name: "Your Tasks" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "ADD TASK" })).toHaveCount(0);
  await expect(page.getByPlaceholder("NEW TASK TITLE")).toHaveCount(0);
  await expect(page.getByText("t233 File the quarterly report")).toHaveCount(0);
});

test("personal tasks are still on the profile's Almanac and their own page", async ({ page, signIn, apiAs, newPerson }) => {
  const una = await newPerson("Una Fairweather");
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const made = await (await apiAs(una)).post("/api/tasks", {
    data: { title: "t233 Renew the passport", description: "Still reachable.", status: "Not Started", dueDate: yesterday },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const taskId = String((await made.json()).task._id);

  await signIn(una);
  await page.goto("/profile");
  await page.getByRole("button", { name: "ALMANAC" }).click(FIRST_LOAD);
  // Overdue, so the Almanac links it at the top.
  const link = page.getByRole("link", { name: "t233 Renew the passport" }).first();
  await expect(link).toBeVisible(FIRST_LOAD);
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/calendar/tasks/${taskId}$`), FIRST_LOAD);
  await expect(page.getByRole("heading", { name: "t233 Renew the passport", level: 1 })).toBeVisible(FIRST_LOAD);
});

test("a chat picked under Profile opens on the right, live for another player in another browser", async ({
  page, browser, baseURL, signIn, apiAs, newPerson, hearthside,
}) => {
  const [wren, hal] = await Promise.all([newPerson("Wren Tallow"), newPerson("Hal Brask")]);
  const [wrenApi, halApi] = await Promise.all([apiAs(wren), apiAs(hal)]);
  const title = "t233 The Lantern Road";
  const id = await campaignFor(wrenApi, halApi, title);
  await post(wrenApi, `campaign:${id}`, "Meet at the crossroads.");

  await signIn(wren);
  const other = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
  await signIn(hal, other);
  const halPage = await other.newPage();
  await Promise.all([page.goto("/dashboard"), halPage.goto("/dashboard")]);

  // Hal's row: name, subtitle, unread, and never the message itself.
  const halRow = row(halPage, title);
  await expect(halRow).toBeVisible(FIRST_LOAD);
  await expect(halRow).toContainText("Campaign · 2 in the party");
  await expect(halRow).toContainText("1 unread");
  await expect(halRow).not.toContainText("Meet at the crossroads");

  // Wren picks it: the log fills the right-hand column, the row is highlighted.
  const wrenRow = row(page, title);
  await expect(wrenRow).toBeVisible(FIRST_LOAD);
  await wrenRow.click();
  await expect(wrenRow).toHaveAttribute("aria-current", "true");
  const wrenLog = messages(page).getByRole("log", { name: `Messages with ${title}` });
  await expect(wrenLog.getByText("Meet at the crossroads.")).toBeVisible();
  const [listBox, logBox] = await Promise.all([wrenRow.boundingBox(), wrenLog.boundingBox()]);
  expect(logBox!.x).toBeGreaterThan(listBox!.x + listBox!.width - 1);
  await expect(messages(page).getByRole("link", { name: "Open in Hearthside" })).toHaveAttribute("href", hearthside.url(`/campaigns/${id}`));
  // Side by side, there's nothing to go back to.
  await expect(messages(page).getByRole("button", { name: "Back to chats" })).toBeHidden();

  // A message from Wren raises Hal's unread count live.
  await expect(messages(page).getByText("Live", { exact: true })).toBeVisible();
  const compose = messages(page).getByRole("textbox", { name: "Write a message" });
  await compose.fill("Bring the lantern oil.");
  await messages(page).getByRole("button", { name: "Send" }).click();
  await expect(compose).toHaveValue("");
  await expect(halRow).toContainText("2 unread");
  await expect(chats(halPage).getByRole("heading")).toContainText("2 unread");

  // Hal opens it: both messages, and it's read.
  await halRow.click();
  const halLog = messages(halPage).getByRole("log", { name: `Messages with ${title}` });
  await expect(halLog.getByText("Bring the lantern oil.")).toBeVisible();
  await expect(halRow).not.toContainText("unread");
  await expect(chats(halPage).getByRole("heading")).not.toContainText("unread");
  await expect(messages(halPage).getByText("Live", { exact: true })).toBeVisible();

  // Wren writes again: Hal sees her writing, then the message, without reloading.
  await compose.fill("And a spare wick.");
  await expect(messages(halPage).getByText(/Wren Tallow is writing/)).toBeVisible();
  await messages(page).getByRole("button", { name: "Send" }).click();
  await expect(halLog.getByText("And a spare wick.")).toBeVisible();
  await expect(messages(halPage).getByText(/Wren Tallow is writing/)).toHaveCount(0);
  await expect(wrenLog.getByText("Sending…")).toHaveCount(0);

  // And Hal's reply reaches Wren.
  await messages(halPage).getByRole("textbox", { name: "Write a message" }).fill("Packed.");
  await messages(halPage).getByRole("button", { name: "Send" }).click();
  await expect(wrenLog.getByText("Packed.")).toBeVisible();

  await other.close();
});

test("a message's Markdown shows as rich text in the log (#265)", async ({ page, signIn, apiAs, newPerson }) => {
  const [ida, rook] = await Promise.all([newPerson("Ida Marrow"), newPerson("Rook Vane")]);
  const title = "t265 The Inked Chat";
  await campaignFor(await apiAs(ida), await apiAs(rook), title);

  await signIn(ida);
  await page.goto("/dashboard");
  await row(page, title).click(FIRST_LOAD);
  const log = messages(page).getByRole("log", { name: `Messages with ${title}` });
  await expect(messages(page).getByText("Live", { exact: true })).toBeVisible();
  await messages(page).getByRole("textbox", { name: "Write a message" }).fill("**hello** _there_ `code`");
  await messages(page).getByRole("button", { name: "Send" }).click();
  await expect(log.locator("strong", { hasText: "hello" })).toBeVisible();
  await expect(log.locator("em", { hasText: "there" })).toBeVisible();
  await expect(log.locator("code", { hasText: "code" })).toBeVisible();
  await expect(log.getByText(/\*\*hello/)).toHaveCount(0);
});

test("the filters split campaigns from friends", async ({ page, signIn, apiAs, newPerson }) => {
  const [mira, oswin] = await Promise.all([newPerson("Mira Hollow"), newPerson("Oswin Reed")]);
  const [miraApi, oswinApi] = await Promise.all([apiAs(mira), apiAs(oswin)]);
  const title = "t233 The Salt Marsh";
  await campaignFor(miraApi, oswinApi, title);
  await befriend(miraApi, oswinApi, oswin.id);
  // A DM is listed once someone has written in it.
  await post(oswinApi, `dm:${[mira.id, oswin.id].sort().join(":")}`, "Fancy a walk?");

  await signIn(mira);
  await page.goto("/dashboard");
  const campaign = row(page, title);
  const friend = row(page, "Oswin Reed");
  await expect(campaign).toBeVisible(FIRST_LOAD);
  await expect(friend).toBeVisible();
  await expect(friend).toContainText("Friend");
  await expect(friend).not.toContainText("Fancy a walk");

  const filters = chats(page).getByRole("tablist", { name: "Show chats from" });
  await filters.getByRole("tab", { name: "Friends" }).click();
  await expect(friend).toBeVisible();
  await expect(campaign).toHaveCount(0);
  await filters.getByRole("tab", { name: "Campaigns" }).click();
  await expect(campaign).toBeVisible();
  await expect(friend).toHaveCount(0);
  await filters.getByRole("tab", { name: "All" }).click();
  await expect(friend).toBeVisible();

  await friend.click();
  await expect(messages(page).getByRole("log", { name: "Messages with Oswin Reed" }).getByText("Fancy a walk?")).toBeVisible();
  // Only campaigns have a Hearthside page.
  await expect(messages(page).getByRole("link", { name: "Open in Hearthside" })).toHaveCount(0);
});

test("scrolling up the log loads older messages", async ({ page, signIn, apiAs, newPerson }) => {
  const [tamsin, bram] = await Promise.all([newPerson("Tamsin Vey"), newPerson("Bram Holt")]);
  const [tamsinApi, bramApi] = await Promise.all([apiAs(tamsin), apiAs(bram)]);
  const title = "t233 The Long Ledger";
  const id = await campaignFor(tamsinApi, bramApi, title);
  // More than a page (50): one after another, so they keep their order.
  for (let n = 1; n <= 60; n++) await post(n % 2 ? tamsinApi : bramApi, `campaign:${id}`, `Entry ${String(n).padStart(2, "0")}`);

  await signIn(tamsin);
  await page.goto("/dashboard");
  await row(page, title).click(FIRST_LOAD);
  const log = messages(page).getByRole("log", { name: `Messages with ${title}` });
  await expect(log.getByText("Entry 60", { exact: true })).toBeVisible();
  await expect(log.getByText("Entry 01", { exact: true })).toHaveCount(0);

  await log.evaluate((el) => { el.scrollTop = 0; });
  await expect(log.getByText("Entry 01", { exact: true })).toHaveCount(1);
  await expect(log.getByText("Entry 60", { exact: true })).toHaveCount(1);
});

test.describe("at phone width", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("the list and the log stack, and the back control returns to the list", async ({ page, signIn, apiAs, newPerson }) => {
    const [cass, dov] = await Promise.all([newPerson("Cass Underhill"), newPerson("Dov Marsh")]);
    const [cassApi, dovApi] = await Promise.all([apiAs(cass), apiAs(dov)]);
    const title = "t233 A Campaign Whose Name Runs On Well Past The Width Of Any Phone";
    const id = await campaignFor(cassApi, dovApi, title);
    await post(dovApi, `campaign:${id}`, `An unbroken word: ${"Lanternlight".repeat(12)}`);

    await signIn(cass);
    await page.goto("/dashboard");
    // The portfolio slides each page in from the side (app/template.tsx), so
    // positions and widths are only meaningful once that spring settles.
    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const settled = () => page.evaluate(() => Array.from(document.body.children).every((el) => {
      const t = getComputedStyle(el).transform;
      return t === "none" || t === "matrix(1, 0, 0, 1, 0, 0)";
    }));

    // One column: the Profile card above the chats, and no log until one is picked.
    const profile = page.getByRole("link", { name: /VIEW & EDIT PROFILE/ });
    const theRow = row(page, "t233 A Campaign Whose Name");
    await expect(theRow).toBeVisible(FIRST_LOAD);
    await expect.poll(settled).toBe(true); // the slide-in has finished
    expect(await sideways()).toBeLessThanOrEqual(0);
    const [profileBox, rowBox] = await Promise.all([profile.boundingBox(), theRow.boundingBox()]);
    expect(rowBox!.y).toBeGreaterThan(profileBox!.y + profileBox!.height);
    expect(Math.abs(rowBox!.x - profileBox!.x)).toBeLessThan(12);
    await expect(messages(page)).toBeHidden();

    // Picking it shows the log in the list's place.
    await theRow.click();
    const log = messages(page).getByRole("log", { name: `Messages with ${title}` });
    await expect(log.getByText(/An unbroken word/)).toBeVisible();
    await expect(messages(page).getByRole("textbox", { name: "Write a message" })).toBeVisible();
    await expect(chats(page)).toBeHidden();
    const logBox = await log.boundingBox();
    expect(Math.abs(logBox!.x - profileBox!.x)).toBeLessThan(12);
    await expect.poll(sideways).toBeLessThanOrEqual(0);

    // Back returns to the list, on the chat it came from.
    await messages(page).getByRole("button", { name: "Back to chats" }).click();
    await expect(theRow).toBeVisible();
    await expect(theRow).toBeFocused();
    await expect(messages(page)).toBeHidden();
  });
});
