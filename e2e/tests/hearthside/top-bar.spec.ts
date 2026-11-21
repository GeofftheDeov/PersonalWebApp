/**
 * The top bar on Hearthside (#220, spec #69, "The top bar on Hearthside").
 *
 * - Its bell shows only Hearthside's notifications (campaign invites, friend
 *   requests and their answers (#251), Game Night links), while the
 *   portfolio's still shows everything.
 * - An old `/game-night/...` link opens its Hearthside page, and accepting a
 *   campaign invite lands on the campaign's Hearthside page.
 * - The social menu has a Campaigns tab in place of Chats, each campaign
 *   opening its Hearthside page; the portfolio's menu keeps Chats.
 * - The bar's portfolio items land on the portfolio's host.
 *
 * Each test makes its own people, campaigns and bell rows, so the seeded party is left alone.
 */
import crypto from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, seedNotification } from "../../fixtures";

/** A first visit compiles the route in dev mode, which can take most of the 15s assertion budget. */
const FIRST_LOAD = { timeout: 45_000 };

async function campaignOf(owner: APIRequestContext, title: string, status = "In Progress"): Promise<string> {
  const made = await owner.post("/api/campaigns", {
    data: { title, description: "Lanterns on the water.", status, startDate: "2026-03-14" },
  });
  expect(made.ok(), await made.text()).toBe(true);
  return String((await made.json()).campaign.id);
}

/** Opens the bell's panel from the bar. Its rows' titles are unique to each test, so they're found on the page. */
async function openBell(page: Page) {
  await page.getByRole("button", { name: "Notifications" }).click();
  await expect(page.getByRole("heading", { name: "NOTIFICATIONS" })).toBeVisible();
  return page;
}

/** The social menu's tabs, by name: on Hearthside Campaigns takes Chats' place. */
async function expectDockTabs(page: Page, shown: string[], hidden: string[]) {
  for (const name of shown) await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  for (const name of hidden) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
}

test("Hearthside's bell shows a campaign invite, a quest reminder and a friend's answer but not a portfolio notice; the portfolio's shows all four", async ({ page, newPerson, apiAs, signIn, stack, hearthside, portfolio }) => {
  // Three pages on two sites, each compiled on its first visit in dev mode.
  test.setTimeout(120_000);
  const [owner, player] = await Promise.all([newPerson("Mira Holt"), newPerson("Bram Tull")]);
  const [ownerApi, playerApi] = await Promise.all([apiAs(owner), apiAs(player)]);
  const title = "t220 The Drowned Bell";
  const id = await campaignOf(ownerApi, title);

  // The player asks the owner to be friends and the owner accepts: the player's bell gets
  // "accepted your friend request", which Hearthside's bell shows too since #251.
  expect((await playerApi.post("/api/friends/request", { data: { toUserId: owner.id } })).ok()).toBe(true);
  const [request] = (await (await ownerApi.get("/api/friends/requests")).json()).incoming;
  expect((await ownerApi.put(`/api/friends/request/${request._id}`, { data: { action: "accept" } })).ok()).toBe(true);
  // Then the owner calls the player to the table: a campaign invite.
  expect((await ownerApi.post("/api/campaign-invites", { data: { campaignId: id, toUserId: player.id } })).status()).toBe(201);
  // And a quest reminder, which only the reminder sweep makes, as it makes them (#214).
  const reminder = "Reminder: t220 Bring the lantern oil";
  await seedNotification(stack, player.id, {
    type: "system", title: reminder, body: "Due in 2 hours.", link: hearthside.url(`/sessions/${crypto.randomUUID()}#quests`),
  });
  // A notice about a portfolio page, which only the portfolio's bell shows.
  const notice = "t220 Your profile is half filled in";
  await seedNotification(stack, player.id, { type: "system", title: notice, link: "/profile" });
  const invite = `invited you to "${title}"`;
  const answer = "accepted your friend request";

  await signIn(player);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "LOGOUT" })).toBeVisible(FIRST_LOAD);
  let bell = await openBell(page);
  await expect(bell.getByText(invite)).toBeVisible();
  await expect(bell.getByText(reminder)).toBeVisible();
  await expect(bell.getByText(answer)).toBeVisible();
  await expect(bell.getByText(notice)).toHaveCount(0);

  await page.goto(portfolio.url("/"));
  await expect(page.getByRole("button", { name: "LOGOUT" })).toBeVisible(FIRST_LOAD);
  bell = await openBell(page);
  await expect(bell.getByText(invite)).toBeVisible();
  await expect(bell.getByText(reminder)).toBeVisible();
  await expect(bell.getByText(answer)).toBeVisible();
  await expect(bell.getByText(notice)).toBeVisible();

  // Joining from Hearthside's bell lands on the campaign's Hearthside page.
  await page.goto(hearthside.url("/"));
  bell = await openBell(page);
  await bell.getByRole("button", { name: "JOIN" }).click();
  await expect(page).toHaveURL(hearthside.url(`/campaigns/${id}`), FIRST_LOAD);
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible(FIRST_LOAD);
});

test("an old /game-night/... notification opened on Hearthside lands on the right Hearthside page", async ({ page, newPerson, apiAs, signIn, stack, hearthside }) => {
  const gm = await newPerson("Oona Fisk");
  const title = "t220 Saltmarsh Wardens";
  const id = await campaignOf(await apiAs(gm), title);
  // A row from before HEARTHSIDE_URL (#214): the portfolio's relative path.
  const old = "t220 Planning started for the next session";
  await seedNotification(stack, gm.id, { type: "system", title: old, link: `/game-night/campaigns/${id}#notice-board` });

  await signIn(gm);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "LOGOUT" })).toBeVisible(FIRST_LOAD);
  const bell = await openBell(page);
  await bell.getByText(old).click();
  await expect(page).toHaveURL(hearthside.url(`/campaigns/${id}#notice-board`), FIRST_LOAD);
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible(FIRST_LOAD);
});

test("the social menu's Campaigns tab lists the player's campaigns, and one opens its Hearthside page", async ({ page, newPerson, apiAs, signIn, hearthside, portfolio }) => {
  test.setTimeout(90_000);
  const player = await newPerson("Petra Lune");
  const api = await apiAs(player);
  const done = "t220 The Long Winter";
  const live = "t220 Ember Road";
  const doneId = await campaignOf(api, done, "Completed");
  const liveId = await campaignOf(api, live, "In Progress");

  await signIn(player);
  await page.goto("/");
  await page.getByRole("button", { name: "SOCIAL" }).click(FIRST_LOAD);
  await expect(page.getByRole("heading", { name: "SOCIAL HUB" })).toBeVisible();
  // Campaigns in place of Chats; Friends, Requests and Add as before.
  await expectDockTabs(page, ["campaigns", "friends", "requests", "add"], ["chats"]);
  const list = page.getByRole("list", { name: "Your campaigns" });
  // In progress first, each with its status.
  await expect(list.getByRole("listitem")).toHaveText([`${live}In Progress`, `${done}Completed`]);
  await expect(list.getByRole("link", { name: done })).toHaveAttribute("href", `/campaigns/${doneId}`);

  await list.getByRole("link", { name: live }).click();
  await expect(page).toHaveURL(hearthside.url(`/campaigns/${liveId}`), FIRST_LOAD);
  await expect(page.getByRole("heading", { name: live, level: 1 })).toBeVisible(FIRST_LOAD);
  await expect(page.getByRole("heading", { name: "SOCIAL HUB" })).toBeHidden();

  // The portfolio's menu is unchanged: it opens on Chats (whose own filters are All, Campaigns and
  // Friends), with no campaigns list.
  await page.goto(portfolio.url("/"));
  await page.getByRole("button", { name: "SOCIAL" }).click(FIRST_LOAD);
  await expectDockTabs(page, ["chats", "all"], []);
  await expect(page.getByRole("list", { name: "Your campaigns" })).toHaveCount(0);
});

test("the bar's portfolio links land on the portfolio host", async ({ page, party, signIn, portfolio }) => {
  await signIn(party.players[0]);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "LOGOUT" })).toBeVisible(FIRST_LOAD);

  await expect(page.getByRole("link", { name: "GEOFFTHEDEV" })).toHaveAttribute("href", portfolio.url("/"));
  await expect(page.getByRole("link", { name: "DASHBOARD" })).toHaveAttribute("href", portfolio.url("/dashboard"));
  await page.getByRole("button", { name: "MORE" }).click();
  await expect(page.getByRole("link", { name: "PROFILE" })).toHaveAttribute("href", portfolio.url("/profile"));
  // Game Night is Hearthside's own home.
  await expect(page.getByRole("link", { name: "GAME NIGHT" })).toHaveAttribute("href", "/");

  await page.getByRole("link", { name: "ABOUT" }).click();
  await expect(page).toHaveURL(portfolio.url("/about"), FIRST_LOAD);
  await expect(page.getByRole("button", { name: "LOGOUT" })).toBeVisible(FIRST_LOAD);
});
