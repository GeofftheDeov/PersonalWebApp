/**
 * Another player's page, `/players/:id` (#231, spec #69): Your Room's head
 * and record, drawn from what `GET /api/users/players/:id` shares, with no
 * campaigns (the API still sends `sharedCampaigns`; the page never shows
 * them). A friend gets "Write a letter", which opens your DM in Letters, and
 * the Friends pill; a campaign-mate who isn't a friend gets neither. At 375px
 * nothing scrolls sideways. Each test makes its own people, so the seeded
 * party is left alone.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "../../fixtures";

/** A first visit compiles the route in dev mode, which can take most of the 15s assertion budget. */
const FIRST_LOAD = { timeout: 45_000 };

/** A campaign `gm` runs and `players` have joined. */
async function campaignOf(gm: APIRequestContext, players: APIRequestContext[], title: string) {
  const made = await gm.post("/api/campaigns", {
    data: { title, description: "For another player's page (#231).", status: "In Progress", startDate: new Date().toISOString() },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const id = String((await made.json()).campaign.id);
  for (const p of players) expect((await p.post(`/api/campaigns/${id}/join`)).ok()).toBe(true);
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

const main = (page: Page) => page.getByRole("main");
const letters = (page: Page) => page.getByRole("complementary", { name: "Letters" });

/** A line of the record, by its label: what it says. */
const field = (page: Page, label: string) =>
  main(page).locator("dl > div").filter({ has: page.getByRole("term").getByText(label, { exact: true }) }).getByRole("definition");

test("a campaign-mate's page shows their public fields and no campaigns", async ({ page, signIn, apiAs, newPerson }) => {
  const [hal, me] = await Promise.all([newPerson("Hal Brask"), newPerson("Wren Tallow")]);
  const [halApi, myApi] = await Promise.all([apiAs(hal), apiAs(me)]);
  const handle = `hal${hal.id.slice(0, 6)}`;
  const fields = await halApi.put("/api/users/profile", {
    data: { handle, phone: "555-0199", discordHandle: "hal_brask", discordId: "998877665544332211", favoriteGames: ["Root", "Gloomhaven"] },
  });
  expect(fields.ok(), await fields.text()).toBe(true);
  const title = "t231 The Drowned Stair";
  await campaignOf(halApi, [myApi], title);
  // The API shares the campaign with a campaign-mate; the page must not.
  const shared = await (await myApi.get(`/api/users/players/${hal.id}`)).json();
  expect(shared.sharedCampaigns.map((c: { title: string }) => c.title)).toContain(title);

  await signIn(me);
  await page.goto(`/players/${hal.id}`);
  // The public view names someone by their handle once they have one (personDisplayName).
  await expect(main(page).getByRole("heading", { level: 1 })).toHaveText(handle, FIRST_LOAD);
  await expect(field(page, "Handle")).toHaveText(`@${handle}`);
  await expect(main(page).getByText(/^Since /)).toBeVisible();

  // The record: what the public view sends, and nothing only Hal sees.
  await expect(main(page).getByRole("region", { name: "Their record" })).toBeVisible();
  await expect(field(page, "Discord")).toHaveText("hal_brask");
  await expect(field(page, "Discord user ID")).toHaveText("998877665544332211");
  await expect(main(page).getByRole("list", { name: "Favourite games" }).getByRole("listitem")).toHaveText(["Root", "Gloomhaven"]);
  for (const label of ["Email", "Phone", "Record type", "Internal ID"]) {
    await expect(main(page).getByRole("term").getByText(label, { exact: true })).toHaveCount(0);
  }
  await expect(main(page).getByText(hal.email)).toHaveCount(0);
  await expect(main(page).getByText("555-0199")).toHaveCount(0);

  // No campaigns: no list, no count, no tab strip, and no Edit.
  await expect(main(page).getByText(title)).toHaveCount(0);
  await expect(main(page).getByText(/campaign/i)).toHaveCount(0);
  await expect(main(page).getByRole("tablist")).toHaveCount(0);
  await expect(main(page).getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);

  // Not friends: no pill and no letter, and the page says why.
  await expect(main(page).getByText("Friends", { exact: true })).toHaveCount(0);
  await expect(main(page).getByRole("button", { name: "Write a letter" })).toHaveCount(0);
  await expect(main(page).getByText("Letters go between friends.")).toBeVisible();
});

test("a friend's page has the Friends pill, and Write a letter opens your DM in Letters", async ({ page, signIn, apiAs, newPerson }) => {
  const [isolde, me] = await Promise.all([newPerson("Isolde Marrow"), newPerson("Pell Ashgrove")]);
  const [isoldeApi, myApi] = await Promise.all([apiAs(isolde), apiAs(me)]);
  await befriend(myApi, isoldeApi, isolde.id);

  await signIn(me);
  await page.goto(`/players/${isolde.id}`);
  await expect(main(page).getByRole("heading", { level: 1 })).toHaveText("Isolde Marrow", FIRST_LOAD);
  await expect(main(page).getByText("Friends", { exact: true })).toBeVisible();
  await expect(main(page).getByText("Letters go between friends.")).toHaveCount(0);

  await main(page).getByRole("button", { name: "Write a letter" }).click();
  await expect(letters(page).getByRole("log", { name: "Letters with Isolde Marrow" })).toBeVisible();
  const compose = letters(page).getByRole("textbox", { name: "Write a letter" });
  await expect(compose).toBeFocused();

  // It's your DM with them: a letter sent there reaches Isolde's side of it.
  await compose.fill("The lamp is lit on the drowned stair.");
  await letters(page).getByRole("button", { name: "Send" }).click();
  await expect(letters(page).getByRole("log").getByText("The lamp is lit on the drowned stair.")).toBeVisible();
  await expect(letters(page).getByRole("log").getByText("sending…")).toHaveCount(0);
  await expect.poll(async () => {
    const { threads } = await (await isoldeApi.get("/api/threads?filter=friends")).json();
    return threads.map((t: { title: string }) => t.title);
  }).toContain("Pell Ashgrove");
});

test.describe("at 375px", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("another player's page never scrolls sideways", async ({ page, signIn, apiAs, newPerson }) => {
    const [them, me] = await Promise.all([newPerson("Bartholomew Featherstonehaugh-Wainwright"), newPerson("Ada Quill")]);
    const [themApi, myApi] = await Promise.all([apiAs(them), apiAs(me)]);
    const handle = `featherstonehaugh_wainwright_${them.id.slice(0, 6)}`;
    const fields = await themApi.put("/api/users/profile", {
      data: {
        handle,
        discordHandle: "bartholomew_featherstonehaugh_wainwright",
        favoriteGames: ["Twilight Imperium: Fourth Edition, with the Prophecy of Kings"],
      },
    });
    expect(fields.ok(), await fields.text()).toBe(true);
    await befriend(myApi, themApi, them.id);

    await signIn(me);
    await page.goto(`/players/${them.id}`);
    await expect(main(page).getByRole("heading", { level: 1 })).toHaveText(handle, FIRST_LOAD);
    await expect(main(page).getByRole("button", { name: "Write a letter" })).toBeVisible();
    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await sideways()).toBeLessThanOrEqual(0);

    await main(page).getByRole("button", { name: "Write a letter" }).click();
    await expect(letters(page).getByRole("log", { name: `Letters with ${handle}` })).toBeVisible();
    expect(await sideways()).toBeLessThanOrEqual(0);
  });
});
