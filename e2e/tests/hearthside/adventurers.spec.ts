/**
 * Adventurers (#229, spec #69): layout D, "Gallery + road", with today's
 * data. `/characters` hangs the player's own adventurers as framed portraits
 * with a brass name plate and the next session in their campaign, and the
 * fallen in the Hall of Heroes below; `/characters/:id` is the hero and their
 * sheet, with Travels with and Edit. New adventurer and Edit share one gilded
 * dialog. Someone else's adventurer opens read-only, and access follows the
 * server's character checks (#202, #235). At 375px nothing scrolls sideways.
 * Each test makes its own people, campaigns and adventurers, so the seeded
 * party is left alone.
 */
import type { APIRequestContext, APIResponse, Page } from "@playwright/test";
import { test, expect } from "../../fixtures";

/** A first visit compiles the route in dev mode, which can take most of the 15s assertion budget. */
const FIRST_LOAD = { timeout: 45_000 };
const DAY = 24 * 60 * 60 * 1000;

async function ok<T = any>(call: Promise<APIResponse>): Promise<T> {
  const res = await call;
  expect(res.ok(), `${res.url()}: ${res.status()} ${await res.text()}`).toBe(true);
  return res.json();
}

/** A campaign `gm` runs, with `players` joined. */
async function campaignOf(gm: APIRequestContext, players: APIRequestContext[], title: string) {
  const made = await ok(gm.post("/api/campaigns", {
    data: { title, description: "For the Adventurers pages (#229).", status: "In Progress", startDate: "2026-03-14" },
  }));
  const id = String(made.campaign.id);
  for (const p of players) await ok(p.post(`/api/campaigns/${id}/join`));
  return id;
}

/** An adventurer, made through the API as `as`. */
async function adventurer(as: APIRequestContext, data: Record<string, unknown>): Promise<string> {
  return String((await ok(as.post("/api/tabletop/characters", { data })))._id);
}

/** `a` asks `b` to be friends, and `b` accepts. */
async function befriend(a: APIRequestContext, b: APIRequestContext, bId: string) {
  await ok(a.post("/api/friends/request", { data: { toUserId: bId } }));
  const request = (await ok(b.get("/api/friends/requests"))).incoming[0];
  await ok(b.put(`/api/friends/request/${request._id}`, { data: { action: "accept" } }));
}

const main = (page: Page) => page.getByRole("main");
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
/** A line of the sheet, by its label: what it says. */
const sheetRow = (page: Page, label: string) =>
  page.getByRole("region", { name: "Their sheet" }).locator("dl > div")
    .filter({ has: page.getByRole("term").getByText(label, { exact: true }) }).getByRole("definition");

test("the roster hangs the player's own adventurers, with the fallen in the Hall of Heroes", async ({ page, signIn, apiAs, newPerson }) => {
  const [me, mate] = await Promise.all([newPerson("Rowan Ashdown"), newPerson("Tamsin Vey")]);
  const [myApi, mateApi] = await Promise.all([apiAs(me), apiAs(mate)]);
  const title = "t229 Starfall Salvage";
  const campaign = await campaignOf(myApi, [mateApi], title);
  // The campaign's next session, a week out (and one further off, which isn't the next).
  const night = new Date(Date.now() + 7 * DAY);
  night.setHours(19, 0, 0, 0);
  for (const [t, at] of [["t229 The Derelict", night], ["t229 The Salvage Rights", new Date(night.getTime() + 14 * DAY)]] as const) {
    await ok(myApi.post("/api/tabletop/sessions", {
      data: { title: t, campaign, date: at.toISOString(), endDate: new Date(at.getTime() + 3 * 3600_000).toISOString(), isOnline: true },
    }));
  }
  await adventurer(myApi, { name: "Kestrel Vane", class: "Envoy", level: 3, gameType: "Starfinder", campaign });
  // In no campaign: still the player's own (#235).
  await adventurer(myApi, { name: "Dr. Ada Marsh", class: "Investigator", level: 1, gameType: "Call of Cthulhu" });
  await adventurer(myApi, { name: "Pip Thistlewick", class: "Rogue", level: 5, campaign, isDead: true });
  // A campaign-mate's adventurer is theirs, not on my roster.
  await adventurer(mateApi, { name: "Brother Odran", class: "Cleric", level: 4, campaign });

  await signIn(me);
  await page.goto("/characters");
  await expect(main(page).getByRole("heading", { level: 1, name: "Adventurers" })).toBeVisible(FIRST_LOAD);
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Adventurers" })).toHaveAttribute("aria-current", "page");
  await expect(main(page).getByText("2 adventuring · 1 fallen")).toBeVisible();

  const wall = main(page).getByRole("list", { name: "Adventuring" });
  await expect(wall.getByRole("listitem")).toHaveCount(2);
  const kestrel = wall.getByRole("listitem").filter({ hasText: "Kestrel Vane" });
  await expect(kestrel).toContainText("Envoy · Level 3");
  const day = night.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).replace(",", "");
  await expect(kestrel).toContainText(`Next: ${day}`);
  await expect(kestrel).toContainText(title);
  await expect(wall.getByRole("listitem").filter({ hasText: "Dr. Ada Marsh" })).toContainText("Not in a campaign yet");
  // Every portrait is the fallback: the initials stitched on the cloth.
  await expect(kestrel.locator(".hs-adv-pt-none")).toHaveText("KV");

  const hall = main(page).getByRole("region", { name: "The Hall of Heroes" });
  await expect(hall.getByRole("heading", { level: 2 })).toContainText("1 fallen");
  await expect(hall.getByRole("listitem")).toHaveCount(1);
  await expect(hall.getByRole("listitem")).toContainText("Pip Thistlewick");
  await expect(hall.getByRole("listitem")).toContainText("Fallen");
  await expect(hall.getByRole("listitem")).not.toContainText("Next:");
  await expect(main(page).getByText("Brother Odran")).toHaveCount(0);

  // A portrait opens its adventurer's page.
  await kestrel.getByRole("link").click();
  await expect(page).toHaveURL(/\/characters\/[0-9a-f-]{36}$/, FIRST_LOAD);
  await expect(main(page).getByRole("heading", { level: 1, name: "Kestrel Vane" })).toBeVisible(FIRST_LOAD);
});

test("an adventurer is made and edited through the gilded dialog", async ({ page, signIn, apiAs, newPerson }) => {
  const [me, mate] = await Promise.all([newPerson("Wren Ashby"), newPerson("Corin Hale")]);
  const [myApi, mateApi] = await Promise.all([apiAs(me), apiAs(mate)]);
  const title = "t229 The Lantern Road";
  const campaign = await campaignOf(myApi, [mateApi], title);
  await adventurer(mateApi, { name: "Mags Ironwood", class: "Fighter", level: 6, campaign });

  await signIn(me);
  await page.goto("/characters");
  await expect(main(page).getByRole("heading", { level: 2, name: "Your first adventurer" })).toBeVisible(FIRST_LOAD);
  await main(page).getByRole("button", { name: "New adventurer" }).click();

  const dialog = page.getByRole("dialog", { name: "New adventurer" });
  await expect(dialog).toBeVisible();
  // Every adventurer needs a name.
  await dialog.getByRole("button", { name: "Add to the roster" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Every adventurer needs a name.");
  await dialog.getByRole("textbox", { name: "Name" }).fill("Lark Fenwick");
  await dialog.getByRole("textbox", { name: "Class" }).fill("Bard");
  await dialog.getByRole("spinbutton", { name: "Level" }).fill("2");
  await dialog.getByRole("textbox", { name: "Game" }).fill("D&D 5e");
  await dialog.getByRole("combobox", { name: "Campaign" }).selectOption({ label: title });
  await expect(dialog.getByRole("group", { name: "Status" }).getByRole("button", { name: "Adventuring" })).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "Add to the roster" }).click();

  // The new adventurer's page.
  await expect(page).toHaveURL(/\/characters\/[0-9a-f-]{36}$/, FIRST_LOAD);
  const id = page.url().split("/").pop()!;
  await expect(main(page).getByRole("heading", { level: 1, name: "Lark Fenwick" })).toBeVisible(FIRST_LOAD);
  await expect(main(page).getByRole("img", { name: "Level 2" })).toBeVisible();
  await expect(sheetRow(page, "Played by")).toHaveText("You");
  await expect(sheetRow(page, "Class")).toHaveText("Bard");
  await expect(sheetRow(page, "Level")).toHaveText("2");
  await expect(sheetRow(page, "Game")).toHaveText("D&D 5e");
  await expect(sheetRow(page, "Campaign").getByRole("link", { name: title })).toHaveAttribute("href", `/campaigns/${campaign}`);
  await expect(sheetRow(page, "Status")).toHaveText("Adventuring");
  // Travels with: the party's other adventurers.
  const mates = main(page).getByRole("list", { name: "Travels with" });
  await expect(mates.getByRole("link")).toHaveCount(1);
  await expect(mates.getByRole("link")).toContainText("Mags Ironwood");

  // A save the server refuses says why, and the dialog stays open (#235).
  await main(page).getByRole("button", { name: "Edit", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Edit Lark Fenwick" });
  await expect(edit.getByRole("textbox", { name: "Name" })).toHaveValue("Lark Fenwick");
  await expect(edit.getByRole("spinbutton", { name: "Level" })).toHaveValue("2");
  await expect(edit.getByRole("combobox", { name: "Campaign" })).toHaveValue(campaign);
  await page.route(`**/api/tabletop/characters/${id}`, (route) => route.request().method() === "PUT"
    ? route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "Only the character's player can change it" }) })
    : route.fallback());
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit.getByRole("alert")).toHaveText("Only the character's player can change it");
  await expect(edit.getByRole("button", { name: "Save" })).toBeEnabled();
  await page.unroute(`**/api/tabletop/characters/${id}`);

  await edit.getByRole("textbox", { name: "Class" }).fill("College of Lore Bard");
  await edit.getByRole("spinbutton", { name: "Level" }).fill("3");
  await edit.getByRole("group", { name: "Status" }).getByRole("button", { name: "Fallen" }).click();
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toHaveCount(0);
  await expect(main(page).getByRole("img", { name: "Level 3" })).toBeVisible();
  await expect(sheetRow(page, "Class")).toHaveText("College of Lore Bard");
  await expect(sheetRow(page, "Status")).toHaveText("Fallen");
  const saved = await ok(myApi.get(`/api/tabletop/characters/${id}`));
  expect([saved.class, saved.level, saved.isDead]).toEqual(["College of Lore Bard", 3, true]);

  // Back on the roster, they hang in the Hall of Heroes.
  await main(page).getByRole("link", { name: /All adventurers/ }).click();
  await expect(main(page).getByRole("region", { name: "The Hall of Heroes" }).getByRole("listitem")).toContainText("Lark Fenwick", FIRST_LOAD);
  await expect(main(page).getByRole("list", { name: "Adventuring" })).toHaveCount(0);
});

test("someone else's adventurer opens read-only, to those the server lets see it", async ({ page, context, signIn, apiAs, newPerson }) => {
  const [owner, mate, friend, stranger] = await Promise.all([
    newPerson("Isolde Marrow"), newPerson("Hal Brask"), newPerson("Pell Ashgrove"), newPerson("Nan Oddway"),
  ]);
  const [ownerApi, mateApi, friendApi] = await Promise.all([apiAs(owner), apiAs(mate), apiAs(friend)]);
  const title = "t229 Bones of the Brinewood";
  const campaign = await campaignOf(ownerApi, [mateApi], title);
  await ok(ownerApi.patch(`/api/campaigns/${campaign}/settings`, { data: { tableLink: "https://table.example/brinewood" } }));
  await befriend(ownerApi, friendApi, friend.id);
  const kestrel = await adventurer(ownerApi, { name: "Kestrel Vane", class: "Envoy", level: 3, gameType: "Starfinder", campaign });
  await adventurer(mateApi, { name: "Brother Odran", class: "Cleric", level: 4, campaign });

  // A campaign-mate: the sheet, Travels with, and no Edit.
  await signIn(mate);
  await page.goto(`/characters/${kestrel}`);
  await expect(main(page).getByRole("heading", { level: 1, name: "Kestrel Vane" })).toBeVisible(FIRST_LOAD);
  await expect(sheetRow(page, "Played by").getByRole("link", { name: "Isolde Marrow" })).toHaveAttribute("href", `/players/${owner.id}`);
  await expect(sheetRow(page, "Campaign").getByRole("link", { name: title })).toBeVisible();
  await expect(main(page).getByRole("list", { name: "Travels with" })).toContainText("Brother Odran");
  await expect(main(page).getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);

  // A friend outside the campaign: the sheet with the campaign's name only, no Travels with, no Edit.
  await context.clearCookies();
  await signIn(friend);
  await page.goto(`/characters/${kestrel}`);
  await expect(main(page).getByRole("heading", { level: 1, name: "Kestrel Vane" })).toBeVisible(FIRST_LOAD);
  await expect(sheetRow(page, "Class")).toHaveText("Envoy");
  await expect(sheetRow(page, "Campaign")).toHaveText(title);
  await expect(sheetRow(page, "Campaign").getByRole("link")).toHaveCount(0);
  await expect(main(page).getByRole("list", { name: "Travels with" })).toHaveCount(0);
  await expect(main(page).getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  // The server doesn't send them the campaign's table link either (#235).
  const asFriend = await ok(friendApi.get(`/api/tabletop/characters/${kestrel}`));
  expect(Object.keys(asFriend.campaign).sort()).toEqual(["_id", "status", "title"]);

  // A stranger is turned away.
  await context.clearCookies();
  await signIn(stranger);
  await page.goto(`/characters/${kestrel}`);
  await expect(main(page).getByRole("heading", { level: 1, name: "A closed door" })).toBeVisible(FIRST_LOAD);
  await expect(main(page).getByText("This adventurer isn’t yours to see.", { exact: false })).toBeVisible();
  await expect(main(page).getByText("Kestrel Vane")).toHaveCount(0);
});

test.describe("at 375px", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("the roster, an adventurer's page and the dialog never scroll sideways", async ({ page, signIn, apiAs, newPerson }) => {
    const [me, mate] = await Promise.all([newPerson("Bartholomew Featherstonehaugh-Wainwright"), newPerson("Ada Quill")]);
    const [myApi, mateApi] = await Promise.all([apiAs(me), apiAs(mate)]);
    const campaign = await campaignOf(myApi, [mateApi], "t229 The Interminable Chronicles of the Sunken Archipelago of Ys");
    const long = await adventurer(myApi, {
      name: "Sir Aldous Montgomery-Fitzwilliam the Unconquerable", class: "Oath of the Ancients Paladin and Occasional Bard",
      level: 20, gameType: "Dungeons & Dragons Fifth Edition (2024 revision)", campaign,
    });
    await adventurer(myApi, { name: "Featherstonehaugh", class: "Wizard", level: 1, isDead: true });
    await adventurer(mateApi, { name: "Theodora Wilhelmina Pemberton-Ashcroft", class: "Artificer", level: 7, campaign });

    await signIn(me);
    await page.goto("/characters");
    await expect(main(page).getByRole("list", { name: "Adventuring" }).getByRole("listitem")).toHaveCount(1, FIRST_LOAD);
    await expect(main(page).getByRole("region", { name: "The Hall of Heroes" })).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);

    await page.goto(`/characters/${long}`);
    await expect(main(page).getByRole("heading", { level: 1 })).toHaveText("Sir Aldous Montgomery-Fitzwilliam the Unconquerable", FIRST_LOAD);
    await expect(main(page).getByRole("list", { name: "Travels with" })).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);

    await main(page).getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.getByRole("dialog", { name: /^Edit Sir Aldous/ })).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });
});
