/**
 * A campaign's page, part 1 (#224, spec #69): the head (back link, banner,
 * title and status), the details and their edit form, the party with its
 * icon-only buttons, the torch, and gilded dialogs for every confirmation and
 * invite: no browser pop-ups. Each test makes its own people and campaign, so
 * the seeded party is left alone, and signs in one viewer.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "../../fixtures";

/** A first visit compiles the route in dev mode, which can take most of the 15s assertion budget. */
const FIRST_LOAD = { timeout: 45_000 };

/** A campaign `owner` runs (and owns), with `players` joined. */
async function campaignOf(owner: APIRequestContext, players: APIRequestContext[], title = "t224 The Ashen Crown") {
  const made = await owner.post("/api/campaigns", {
    data: { title, description: "The old king's crown woke the dead.", status: "In Progress", startDate: "2026-03-14" },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const id = String((await made.json()).campaign.id);
  for (const p of players) {
    const joined = await p.post(`/api/campaigns/${id}/join`);
    expect(joined.ok(), await joined.text()).toBe(true);
  }
  return id;
}

/** What the page calls someone: their handle, else their name (as the members and friends lists send them). */
async function nameOf(api: APIRequestContext, campaignId: string, personId: string): Promise<string> {
  const members = await (await api.get(`/api/campaigns/${campaignId}/members`)).json();
  const m = members.find((x: any) => x.playerId === personId);
  return m.person?.handle || m.person?.name;
}

/** Every browser pop-up (`window.confirm`, `alert`, `prompt`) the page opens, dismissed: there should be none. */
function popUps(page: Page): string[] {
  const seen: string[] = [];
  page.on("dialog", (d) => { seen.push(`${d.type()}: ${d.message()}`); void d.dismiss(); });
  return seen;
}

const party = (page: Page) => page.getByRole("list", { name: "The party" });

test("the owner edits the campaign's details and its planning settings", async ({ page, signIn, apiAs, newPerson }) => {
  const popped = popUps(page);
  const owner = await newPerson("Wren Talbot");
  const api = await apiAs(owner);
  const id = await campaignOf(api, []);

  await signIn(owner);
  await page.goto(`/campaigns/${id}`);
  await expect(page.getByRole("heading", { level: 1, name: "t224 The Ashen Crown" })).toBeVisible(FIRST_LOAD);
  await expect(page.getByRole("main").getByRole("link", { name: "← Back to Campaigns" })).toHaveAttribute("href", "/campaigns");
  await expect(page.getByRole("main").getByText("In progress", { exact: true })).toBeVisible();
  const about = page.getByRole("region", { name: "About the campaign" });
  await expect(about).toContainText("March 14, 2026");
  await expect(about).toContainText("Whole party");

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const form = page.getByRole("region", { name: "Edit the campaign" });
  await form.getByLabel("Title").fill("t224 The Ashen Crown Rekindled");
  await form.getByLabel("Description").fill("The crown sleeps; the ash does not.");
  await form.getByLabel("Status").selectOption("Completed");
  await form.getByLabel("End date").fill("2026-10-31");
  await form.getByLabel("What this campaign calls its Game Master").fill("Keeper");
  await form.getByLabel("Quorum (players a night needs)").fill("1");
  await form.getByLabel("Table link (online sessions)").fill("https://foundry.example/ashen");
  await form.getByRole("button", { name: "Save changes" }).click();

  await expect(form).toBeHidden();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("t224 The Ashen Crown Rekindled");
  await expect(page.getByRole("main").getByText("Completed", { exact: true })).toBeVisible();
  await expect(about).toContainText("The crown sleeps; the ash does not.");
  await expect(about).toContainText("October 31, 2026");
  await expect(about.getByText("Keeper", { exact: true })).toBeVisible();
  await expect(about).toContainText("1 of the party");
  await expect(about.getByRole("link", { name: "foundry.example/ashen" })).toHaveAttribute("href", "https://foundry.example/ashen");

  // Saved, not just shown.
  const saved = await (await api.get(`/api/campaigns/${id}`)).json();
  expect(saved).toMatchObject({ title: "t224 The Ashen Crown Rekindled", status: "Completed", gmTitle: "Keeper", quorum: 1, tableLink: "https://foundry.example/ashen" });
  expect(popped).toEqual([]);
});

test("the owner invites a friend through the dialog", async ({ page, signIn, apiAs, newPerson }) => {
  const popped = popUps(page);
  const [owner, friend] = await Promise.all([newPerson("Ada Quill"), newPerson("Fenn Arrow")]);
  const [ownerApi, friendApi] = await Promise.all([apiAs(owner), apiAs(friend)]);
  const id = await campaignOf(ownerApi, []);
  // Friends first: invites go friend to friend.
  expect((await ownerApi.post("/api/friends/request", { data: { toUserId: friend.id } })).ok()).toBe(true);
  const request = (await (await friendApi.get("/api/friends/requests")).json()).incoming[0];
  expect((await friendApi.put(`/api/friends/request/${request._id}`, { data: { action: "accept" } })).ok()).toBe(true);
  const listed = (await (await ownerApi.get("/api/friends/list")).json())[0];
  const who = listed.handle ? `@${listed.handle}` : listed.name;

  await signIn(owner);
  await page.goto(`/campaigns/${id}`);
  await page.getByRole("button", { name: "Invite", exact: true }).click(FIRST_LOAD);
  const dialog = page.getByRole("dialog", { name: "Invite players" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Invite link")).toHaveValue(new RegExp(`/join/${id}$`));

  await dialog.getByRole("button", { name: `Invite ${who}` }).click();
  await expect(dialog.getByRole("button", { name: `${who} invited` })).toBeDisabled();
  const invites = await (await friendApi.get("/api/campaign-invites/mine")).json();
  expect(invites.map((i: any) => String(i.campaign?._id ?? i.campaign?.id ?? i.campaign))).toContain(id);

  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  expect(popped).toEqual([]);
});

test("the owner passes the torch, confirmed in a gilded dialog", async ({ page, signIn, apiAs, newPerson }) => {
  const popped = popUps(page);
  const [owner, player] = await Promise.all([newPerson("Mara Quill"), newPerson("Tobin Reed")]);
  const [ownerApi, playerApi] = await Promise.all([apiAs(owner), apiAs(player)]);
  const id = await campaignOf(ownerApi, [playerApi]);
  const [ownerName, playerName] = await Promise.all([nameOf(ownerApi, id, owner.id), nameOf(ownerApi, id, player.id)]);

  await signIn(owner);
  await page.goto(`/campaigns/${id}`);
  const about = page.getByRole("region", { name: "About the campaign" });
  await about.getByRole("button", { name: "Pass the torch" }).click(FIRST_LOAD);
  await about.getByLabel("New Dungeon Master").selectOption({ label: playerName });
  await about.getByRole("button", { name: "Pass it" }).click();

  const dialog = page.getByRole("dialog", { name: "Pass the torch?" });
  await expect(dialog).toContainText(`Pass the torch to ${playerName}? They become the Dungeon Master and you become a player. Ownership doesn’t change.`);
  await dialog.getByRole("button", { name: "Pass the torch" }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByRole("main").getByText(`2 in the party · ${playerName} is Dungeon Master`)).toBeVisible();
  // No longer the GM: no torch to pass, and nobody to remove.
  await expect(about.getByRole("button", { name: "Pass the torch" })).toHaveCount(0);
  await expect(party(page).getByRole("button", { name: `Remove ${playerName}` })).toHaveCount(0);
  await expect(about).toContainText(`Owner${ownerName}`);
  const members = await (await ownerApi.get(`/api/campaigns/${id}/members`)).json();
  expect(members.find((m: any) => m.playerId === player.id).status).toBe("Game Master");
  expect(members.find((m: any) => m.playerId === owner.id).status).toBe("Player");
  expect(popped).toEqual([]);
});

test("the GM makes a player inactive, brings them back and removes another, each in a dialog", async ({ page, signIn, apiAs, newPerson }) => {
  const popped = popUps(page);
  const [gm, p1, p2] = await Promise.all([newPerson("Odile Marsh"), newPerson("Pip Hollow"), newPerson("Sorrel Vane")]);
  const [gmApi, p1Api, p2Api] = await Promise.all([apiAs(gm), apiAs(p1), apiAs(p2)]);
  const id = await campaignOf(gmApi, [p1Api, p2Api]);
  const [n1, n2] = await Promise.all([nameOf(gmApi, id, p1.id), nameOf(gmApi, id, p2.id)]);

  await signIn(gm);
  await page.goto(`/campaigns/${id}`);
  // The only GM, with a party: no leaving until the torch has passed.
  await expect(party(page)).toContainText("You’re the only Dungeon Master: pass the torch before you leave.", FIRST_LOAD);

  await party(page).getByRole("button", { name: `Make ${n1} inactive` }).click();
  const inactive = page.getByRole("dialog", { name: `Make ${n1} inactive?` });
  await expect(inactive).toContainText("they can’t read or post in Table Talk");
  // Never mind leaves them be.
  await inactive.getByRole("button", { name: "Never mind" }).click();
  await expect(inactive).toBeHidden();
  await party(page).getByRole("button", { name: `Make ${n1} inactive` }).click();
  await inactive.getByRole("button", { name: "Make inactive" }).click();
  await expect(inactive).toBeHidden();

  // The note about inactive players is a tooltip on the list's header.
  await expect(party(page)).toContainText("Inactive (1)");
  const tip = party(page).getByRole("button", { name: "About inactive players" });
  await expect(page.getByRole("tooltip")).toBeHidden();
  await tip.hover();
  await expect(page.getByRole("tooltip")).toHaveText(/Inactive players can’t read or post in Table Talk\. .* Only the Dungeon Master sees this list\./);
  await expect(tip).toHaveAccessibleDescription(/can’t read or post in Table Talk/);
  expect((await (await gmApi.get(`/api/campaigns/${id}/members`)).json()).find((m: any) => m.playerId === p1.id).isActive).toBe(false);

  await party(page).getByRole("button", { name: `Reactivate ${n1}` }).click();
  await expect(party(page)).not.toContainText("Inactive (");
  await expect(party(page).getByRole("button", { name: `Make ${n1} inactive` })).toBeVisible();

  await party(page).getByRole("button", { name: `Remove ${n2}` }).click();
  const remove = page.getByRole("dialog", { name: `Remove ${n2}?` });
  await expect(remove).toContainText(`${n2} leaves t224 The Ashen Crown.`);
  await remove.getByRole("button", { name: "Remove them" }).click();
  await expect(remove).toBeHidden();
  await expect(party(page).getByRole("link", { name: n2 })).toHaveCount(0);
  const left = await (await gmApi.get(`/api/campaigns/${id}/members`)).json();
  expect(left.map((m: any) => m.playerId)).not.toContain(p2.id);
  expect(popped).toEqual([]);
});

test("a player sees no party controls, and leaves through a dialog", async ({ page, signIn, apiAs, newPerson }) => {
  const popped = popUps(page);
  const [gm, player] = await Promise.all([newPerson("Hollis Brand"), newPerson("Tamsin Oak")]);
  const [gmApi, playerApi] = await Promise.all([apiAs(gm), apiAs(player)]);
  const id = await campaignOf(gmApi, [playerApi]);

  await signIn(player);
  await page.goto(`/campaigns/${id}`);
  await expect(party(page).getByRole("button", { name: /Leave the campaign/ })).toBeVisible(FIRST_LOAD);
  await expect(party(page).getByRole("button", { name: /^(Remove|Make|Reactivate) / })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "About the campaign" }).getByRole("button")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add banner" })).toHaveCount(0);

  await party(page).getByRole("button", { name: /Leave the campaign/ }).click();
  const dialog = page.getByRole("dialog", { name: "Leave the campaign?" });
  await expect(dialog).toContainText("You’ll need the invite link to rejoin t224 The Ashen Crown.");
  await dialog.getByRole("button", { name: "Leave", exact: true }).click();
  await expect(page).toHaveURL(/\/campaigns$/, FIRST_LOAD);
  const members = await (await gmApi.get(`/api/campaigns/${id}/members`)).json();
  expect(members.map((m: any) => m.playerId)).not.toContain(player.id);
  expect(popped).toEqual([]);
});

test.describe("at 375px", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("nothing scrolls sideways, and the way back sits opposite the menu", async ({ page, signIn, apiAs, newPerson }) => {
    const popped = popUps(page);
    const [gm, player] = await Promise.all([newPerson("Corin Vale"), newPerson("Bartholomew Featherstonehaugh-Wainwright")]);
    const [gmApi, playerApi] = await Promise.all([apiAs(gm), apiAs(player)]);
    const id = await campaignOf(gmApi, [playerApi], "t224 The Extraordinarily Long-Winded Chronicle of the Unpronounceable Archipelagos");

    await signIn(gm);
    await page.goto(`/campaigns/${id}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible(FIRST_LOAD);
    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    // The menu button on the left, "← Campaigns" on the right of the same row; the page's own button is hidden.
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    const back = page.getByRole("link", { name: "← Campaigns" });
    await expect(menu).toBeVisible();
    await expect(back).toBeVisible();
    expect((await menu.boundingBox())!.x).toBeLessThan((await back.boundingBox())!.x);
    await expect(page.getByRole("main").getByRole("link", { name: "← Back to Campaigns" })).toBeHidden();

    // The banner keeps 4:1 inside its frame.
    const cloth = (await page.getByRole("img", { name: /no banner yet$/ }).boundingBox())!;
    expect(Math.abs(cloth.width / cloth.height - 4)).toBeLessThan(0.1);
    expect(await sideways()).toBeLessThanOrEqual(0);

    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.getByRole("region", { name: "Edit the campaign" })).toBeVisible();
    expect(await sideways()).toBeLessThanOrEqual(0);
    await page.getByRole("region", { name: "Edit the campaign" }).getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Invite", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Invite players" })).toBeVisible();
    expect(await sideways()).toBeLessThanOrEqual(0);
    expect(popped).toEqual([]);
  });
});
