/**
 * The top bar on Hearthside, follow-ups (#251, spec #69, from #220):
 *
 * - A friend's card in the social menu has MESSAGE again, opening your
 *   letter with them in Letters, on the pages that show Letters. On the
 *   invite page, `/join/:id`, there's neither Letters nor MESSAGE.
 * - Signed out, nothing of Letters loads: no thread reads, no live socket.
 * - The bell opens an invite's row on its invite page, and a friend's answer
 *   to your request on their `/players/:id`.
 * - An admin's Campaigns tab lists only the campaigns they were added to.
 * - At 375px, MESSAGE from the phone menu opens the letter and nothing
 *   scrolls sideways.
 *
 * Each test makes its own people, campaigns and friendships, so the seeded party is left alone.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, makeAdmin } from "../../fixtures";

/** A first visit compiles the route in dev mode, which can take most of the 15s assertion budget. */
const FIRST_LOAD = { timeout: 45_000 };

async function campaignOf(owner: APIRequestContext, title: string): Promise<string> {
  const made = await owner.post("/api/campaigns", {
    data: { title, description: "Lanterns on the water.", status: "In Progress", startDate: "2026-03-14" },
  });
  expect(made.ok(), await made.text()).toBe(true);
  return String((await made.json()).campaign.id);
}

/** `a` asks `b` to be friends, and `b` answers. */
async function askFriend(a: APIRequestContext, b: APIRequestContext, bId: string, action: "accept" | "reject" = "accept") {
  const asked = await a.post("/api/friends/request", { data: { toUserId: bId } });
  expect(asked.ok(), await asked.text()).toBe(true);
  const request = (await (await b.get("/api/friends/requests")).json()).incoming[0];
  const answered = await b.put(`/api/friends/request/${request._id}`, { data: { action } });
  expect(answered.ok(), await answered.text()).toBe(true);
}

const letters = (page: Page) => page.getByRole("complementary", { name: "Letters" });

/** Opens the social menu on its Friends tab. */
async function openFriends(page: Page) {
  await page.getByRole("button", { name: "Social" }).click(FIRST_LOAD);
  await expect(page.getByRole("heading", { name: "SOCIAL HUB" })).toBeVisible();
  await page.getByRole("button", { name: "friends", exact: true }).click();
}

/** A friend's card in the social menu, by the name it shows. */
const friendCard = (page: Page, name: string) =>
  page.locator("div.border-4").filter({ has: page.getByRole("heading", { name: `@${name.toUpperCase()}` }) });

async function openBell(page: Page) {
  await page.getByRole("button", { name: "Notifications" }).click();
  await expect(page.getByRole("heading", { name: "NOTIFICATIONS" })).toBeVisible();
}

test("a friend's MESSAGE opens their letter in Letters; on the invite page there's neither", async ({ page, newPerson, apiAs, signIn }) => {
  test.setTimeout(90_000);
  const [me, friend] = await Promise.all([newPerson("Wren Tallow"), newPerson("Hal Brask")]);
  const [myApi, friendApi] = await Promise.all([apiAs(me), apiAs(friend)]);
  await askFriend(myApi, friendApi, friend.id);
  const title = "t251 The Lamplighters";
  const id = await campaignOf(friendApi, title);

  await signIn(me);
  // The invite page: no Letters, and a friend's card has only PROFILE.
  await page.goto(`/join/${id}`);
  await expect(page.getByRole("main").getByRole("heading", { name: title, level: 1 })).toBeVisible(FIRST_LOAD);
  await openFriends(page);
  const onInvite = friendCard(page, friend.name);
  await expect(onInvite.getByRole("link", { name: "PROFILE" })).toBeVisible();
  await expect(onInvite.getByRole("button", { name: "MESSAGE" })).toHaveCount(0);
  await expect(letters(page)).toHaveCount(0);

  // A page in the shell: MESSAGE opens the letter in Letters, and the menu gets out of the way.
  await page.goto("/campaigns");
  await expect(page.getByRole("main").getByRole("heading", { name: "Campaigns", level: 1 })).toBeVisible(FIRST_LOAD);
  await expect(letters(page).getByRole("heading", { name: /^Letters/ })).toBeVisible();
  await openFriends(page);
  await friendCard(page, friend.name).getByRole("button", { name: "MESSAGE" }).click();
  await expect(page.getByRole("heading", { name: "SOCIAL HUB" })).toBeHidden();
  await expect(letters(page).getByRole("log", { name: `Letters with ${friend.name}` })).toBeVisible();
  const compose = letters(page).getByRole("textbox", { name: "Write a letter" });
  await expect(compose).toBeFocused();

  // It's the real thread: a letter sent there reaches the friend.
  await compose.fill("The lamps are lit; come by the stair.");
  await letters(page).getByRole("button", { name: "Send" }).click();
  await expect(compose).toHaveValue("");
  await expect.poll(async () => {
    const { threads } = (await (await friendApi.get("/api/threads")).json()) as { threads: { kind: string; targetId: string; unreadCount: number }[] };
    return threads.find((t) => t.kind === "dm" && t.targetId === me.id)?.unreadCount ?? 0;
  }).toBe(1);
});

test("signed out, a sign-in page asks nothing of Letters: no thread reads and no live socket", async ({ page }) => {
  const asked: string[] = [];
  const isLetters = (url: string) => /^\/api\/(threads|live)(\/|$|\?)/.test(new URL(url).pathname);
  page.on("request", (r) => { if (isLetters(r.url())) asked.push(r.url()); });
  page.on("websocket", (ws) => { if (isLetters(ws.url())) asked.push(ws.url()); });
  const whoAmI = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/users/profile");

  await page.goto("/login");
  await whoAmI;
  await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible(FIRST_LOAD);
  // Hydrated (its fields wait for that), and the bar has heard nobody is signed in.
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  await expect(page.getByRole("link", { name: "LOGIN" }).first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(asked).toEqual([]);
  await expect(letters(page)).toHaveCount(0);
});

test("an invite's row in the bell opens its invite page, where it can still be answered", async ({ page, newPerson, apiAs, signIn }) => {
  test.setTimeout(90_000);
  const [owner, player] = await Promise.all([newPerson("Mira Holt"), newPerson("Bram Tull")]);
  const [ownerApi, playerApi] = await Promise.all([apiAs(owner), apiAs(player)]);
  const title = "t251 The Drowned Bell";
  const id = await campaignOf(ownerApi, title);
  await askFriend(ownerApi, playerApi, player.id);
  expect((await ownerApi.post("/api/campaign-invites", { data: { campaignId: id, toUserId: player.id } })).status()).toBe(201);

  await signIn(player);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "LOGOUT" })).toBeVisible(FIRST_LOAD);
  await openBell(page);
  await page.getByText(`invited you to "${title}"`).click();
  await expect(page).toHaveURL(new RegExp(`/join/${id}$`), FIRST_LOAD);
  await expect(page.getByRole("main").getByRole("heading", { name: title, level: 1 })).toBeVisible(FIRST_LOAD);
  await expect(page.getByRole("main").getByRole("button", { name: "Accept" })).toBeVisible();

  // Opening it didn't answer it: still pending, and JOIN and DECLINE are still in the bell.
  expect(await (await playerApi.get("/api/campaign-invites/mine")).json()).toHaveLength(1);
  await openBell(page);
  await expect(page.getByRole("button", { name: "JOIN", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "DECLINE", exact: true })).toBeVisible();
});

test("a friend's answer to your request opens their page, accepted or declined", async ({ page, newPerson, apiAs, signIn }) => {
  test.setTimeout(90_000);
  const [asker, yes, no] = await Promise.all([newPerson("Oona Fisk"), newPerson("Tamsin Grey"), newPerson("Corin Vale")]);
  const [askerApi, yesApi, noApi] = await Promise.all([apiAs(asker), apiAs(yes), apiAs(no)]);
  await askFriend(askerApi, yesApi, yes.id, "accept");
  await askFriend(askerApi, noApi, no.id, "reject");

  await signIn(asker);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "LOGOUT" })).toBeVisible(FIRST_LOAD);
  await openBell(page);
  await page.getByText(`@${yes.name} accepted your friend request`).click();
  await expect(page).toHaveURL(new RegExp(`/players/${yes.id}$`), FIRST_LOAD);
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toHaveText(yes.name, FIRST_LOAD);

  // Someone who said no lands on their page too, which shows strangers a closed door (#231).
  await openBell(page);
  await page.getByText(`@${no.name} declined your friend request`).click();
  await expect(page).toHaveURL(new RegExp(`/players/${no.id}$`), FIRST_LOAD);
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toHaveText("A closed door", FIRST_LOAD);
});

test("an admin's Campaigns tab lists the campaign they were added to, not one they weren't", async ({ page, newPerson, apiAs, signIn, stack }) => {
  const [admin, gm] = await Promise.all([newPerson("Ysolde Crane"), newPerson("Garrick Vale")]);
  await makeAdmin(stack, admin.id);
  const [adminApi, gmApi] = await Promise.all([apiAs(admin), apiAs(gm)]);
  const joined = "t251 The Glass Orchard";
  const notIn = "t251 The Salt Kings";
  const joinedId = await campaignOf(gmApi, joined);
  await campaignOf(gmApi, notIn);
  expect((await adminApi.post(`/api/campaigns/${joinedId}/join`)).ok()).toBe(true);
  // Elsewhere an admin still gets every campaign.
  const every = (await (await adminApi.get("/api/campaigns")).json()) as { title: string }[];
  expect(every.map((c) => c.title)).toEqual(expect.arrayContaining([joined, notIn]));

  await signIn(admin);
  await page.goto("/");
  await page.getByRole("button", { name: "Social" }).click(FIRST_LOAD);
  const list = page.getByRole("list", { name: "Your campaigns" });
  await expect(list.getByRole("link", { name: joined })).toBeVisible();
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(page.getByText(notIn)).toHaveCount(0);
});

test.describe("at 375px", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("a friend's MESSAGE from the phone menu opens their letter, and nothing scrolls sideways", async ({ page, newPerson, apiAs, signIn }) => {
    const [me, friend] = await Promise.all([newPerson("Ada Quillfeather"), newPerson("Bartholomew Underhill-Featherstonehaugh")]);
    await askFriend(await apiAs(me), await apiAs(friend), friend.id);
    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    await signIn(me);
    await page.goto("/campaigns");
    await expect(page.getByRole("main").getByRole("heading", { name: "Campaigns", level: 1 })).toBeVisible(FIRST_LOAD);
    await page.getByRole("button", { name: "Toggle menu" }).click();
    await openFriends(page);
    const card = friendCard(page, friend.name);
    await expect(card.getByRole("button", { name: "MESSAGE" })).toBeVisible();
    expect(await sideways()).toBeLessThanOrEqual(0);
    const box = await card.getByRole("button", { name: "MESSAGE" }).boundingBox();
    expect(box && box.x + box.width).toBeLessThanOrEqual(375);

    await card.getByRole("button", { name: "MESSAGE" }).click();
    await expect(page.getByRole("heading", { name: "SOCIAL HUB" })).toBeHidden();
    // The phone menu closed with it, and Letters, at the foot of the page, came into view.
    await expect(page.getByRole("button", { name: "Social" })).toBeHidden();
    const log = letters(page).getByRole("log", { name: `Letters with ${friend.name}` });
    await expect(log).toBeInViewport();
    expect(await sideways()).toBeLessThanOrEqual(0);
  });
});
