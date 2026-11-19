/**
 * Your Room (#230, spec #69): layout A, "The ledger". Every Record field
 * edits and saves (the photo too); the campaign filter narrows Coming up and
 * Played together; the Google Calendar card reads `?gcal=` on the way back
 * to /room and Connect leaves for the URL the backend gives; `/players/<own
 * id>` is Your Room; at 375px nothing scrolls sideways. Each test makes its
 * own people, so the seeded party is left alone, and signs in one viewer.
 *
 * Google isn't reachable here: the callback's redirect to /room on Hearthside
 * is the backend's (#215, backend/scripts/test-return-links.ts), so these
 * tests stand in for Google's page and land on `/room?gcal=…` directly.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "../../fixtures";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** A first visit compiles the route in dev mode, which can take most of the 15s assertion budget. */
const FIRST_LOAD = { timeout: 45_000 };

/** A 1 x 1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function campaignOf(gm: APIRequestContext, players: APIRequestContext[], title: string) {
  const made = await gm.post("/api/campaigns", {
    data: { title, description: "For Your Room (#230).", status: "In Progress", startDate: new Date().toISOString() },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const id = String((await made.json()).campaign.id);
  for (const p of players) expect((await p.post(`/api/campaigns/${id}/join`)).ok()).toBe(true);
  return id;
}

/** A three-hour session `startsIn` from now (negative: already played). */
async function sessionOf(gm: APIRequestContext, campaignId: string, title: string, startsIn: number) {
  const start = new Date(Date.now() + startsIn);
  const made = await gm.post("/api/tabletop/sessions", {
    data: { title, campaign: campaignId, date: start.toISOString(), endDate: new Date(start.getTime() + 3 * HOUR).toISOString() },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const s = await made.json();
  return String(s._id ?? s.id);
}

/** One of Your Room's tabs (Letters has tabs of its own). */
const roomTab = (page: Page, name: string | RegExp) => page.getByRole("tablist", { name: "Your Room" }).getByRole("tab", { name });

/** A line of the record, by its label: what it says. */
const field = (page: Page, label: string) =>
  page.getByRole("tabpanel").locator("dl > div").filter({ has: page.getByRole("term").getByText(label, { exact: true }) }).getByRole("definition");

test("every Record field edits and saves, including the photo", async ({ page, signIn, apiAs, newPerson }) => {
  const me = await newPerson("Wren Talbot");
  const api = await apiAs(me);
  const { userNumber } = await (await api.get("/api/users/profile")).json();
  await signIn(me);
  await page.goto("/room");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Wren Talbot", FIRST_LOAD);
  await expect(page.getByRole("tab", { name: "Record" })).toHaveAttribute("aria-selected", "true");
  await expect(field(page, "Email")).toContainText(me.email);
  await expect(field(page, "Handle")).toHaveText("Not set");

  // The record, in its gilded dialog.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Your record" });
  await expect(dialog.getByLabel("Email", { exact: true })).toBeDisabled();
  await dialog.getByLabel("Name", { exact: true }).fill("Wren Ashby");
  await dialog.getByLabel("Handle", { exact: true }).fill("@wrenna");
  await dialog.getByLabel("Phone", { exact: true }).fill("555-0142");
  await dialog.getByLabel("Discord name").fill("wren_a");
  await dialog.getByLabel("Discord user ID").fill("123456789012345678");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Wren Ashby");
  await expect(field(page, "Name")).toHaveText("Wren Ashby");
  await expect(field(page, "Handle")).toHaveText("@wrenna");
  await expect(field(page, "Unique ID")).toHaveText(`@wrenna#${userNumber}`);
  await expect(field(page, "Phone")).toContainText("555-0142");
  await expect(field(page, "Discord")).toHaveText("wren_a");
  await expect(field(page, "Discord user ID")).toHaveText("123456789012345678");

  // Favourite games, in place.
  const games = page.getByRole("list", { name: "Favourite games" });
  const add = page.getByLabel("Add a favourite game");
  await add.fill("Root");
  await add.press("Enter");
  await expect(games.getByRole("listitem")).toHaveText(["Root×"]);
  await add.fill("Gloomhaven");
  await add.press("Enter");
  await expect(games.getByRole("listitem")).toHaveCount(2);
  await games.getByRole("button", { name: "Remove Root" }).click();
  await expect(games.getByRole("listitem")).toHaveCount(1);
  await expect(games).toContainText("Gloomhaven");

  // The photo: a file that isn't a picture is refused here; a PNG uploads and shows.
  await page.getByLabel(/^Add your photo/).setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a picture") });
  await expect(page.getByText("A photo must be a JPG, PNG, GIF or WEBP, up to 5 MB.")).toBeVisible();
  await page.getByLabel(/^Add your photo/).setInputFiles({ name: "wren.png", mimeType: "image/png", buffer: PNG });
  const photo = page.getByRole("img", { name: "Your photo" });
  await expect(photo).toHaveAttribute("src", /^\/uploads\/profile-pictures\//);
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1);
  await expect(page.getByLabel(/^Change your photo/)).toBeAttached();

  // All of it saved.
  const saved = await (await api.get("/api/users/profile")).json();
  expect(saved).toMatchObject({
    name: "Wren Ashby", handle: "wrenna", phone: "555-0142", discordHandle: "wren_a", discordId: "123456789012345678",
    favoriteGames: ["Gloomhaven"], profilePicture: expect.stringMatching(/^\/uploads\/profile-pictures\//),
  });
  await page.reload();
  await expect(field(page, "Handle")).toHaveText("@wrenna", FIRST_LOAD);
});

test("the Sessions filter narrows both lists", async ({ page, signIn, apiAs, newPerson }) => {
  const [gm, me] = await Promise.all([newPerson("Odile Marsh"), newPerson("Piet Lark")]);
  const [gmApi, myApi] = await Promise.all([apiAs(gm), apiAs(me)]);
  const crown = await campaignOf(gmApi, [myApi], "t230 The Ashen Crown");
  const lantern = await campaignOf(gmApi, [myApi], "t230 The Lantern Road");
  await sessionOf(gmApi, crown, "t230 Crown, next", 3 * DAY);
  await sessionOf(gmApi, lantern, "t230 Lantern, next", 5 * DAY);
  for (const [c, title, ago] of [[crown, "t230 Crown, played", 10], [lantern, "t230 Lantern, played", 20]] as const) {
    const id = await sessionOf(gmApi, c, title, -ago * DAY);
    const took = await gmApi.put(`/api/tabletop/sessions/${id}/attendance`, { data: { playerIds: [me.id] } });
    expect(took.ok(), await took.text()).toBe(true);
  }

  await signIn(me);
  await page.goto("/room?tab=sessions");
  const up = page.getByRole("list", { name: "Coming up" });
  const played = page.getByRole("list", { name: "Played" });
  await expect(up.getByRole("link")).toHaveCount(2, FIRST_LOAD);
  await expect(page.getByRole("tab", { name: "Sessions 2" })).toHaveAttribute("aria-selected", "true");
  await expect(up.getByRole("link").first()).toContainText("t230 Crown, next");
  await expect(played.getByRole("link")).toHaveCount(2);
  await expect(played.getByRole("link").first()).toContainText("t230 Crown, played");
  await expect(page).toHaveURL(/\/room$/);

  const filter = page.getByRole("group", { name: "Show sessions from" });
  await filter.getByRole("button", { name: "t230 The Lantern Road 2" }).click();
  await expect(filter.getByRole("button", { name: "t230 The Lantern Road 2" })).toHaveAttribute("aria-pressed", "true");
  await expect(up.getByRole("link")).toHaveCount(1);
  await expect(up).toContainText("t230 Lantern, next");
  await expect(played.getByRole("link")).toHaveCount(1);
  await expect(played).toContainText("t230 Lantern, played");
  await expect(played.getByRole("link")).toHaveAttribute("href", /^\/sessions\//);

  await filter.getByRole("button", { name: "All 4" }).click();
  await expect(up.getByRole("link")).toHaveCount(2);
  await expect(played.getByRole("link")).toHaveCount(2);

  // The Campaigns tab lists both.
  await page.getByRole("tab", { name: "Campaigns 2" }).click();
  const campaigns = page.getByRole("list", { name: "Your campaigns" });
  await expect(campaigns.getByRole("heading")).toHaveCount(2);
  await expect(campaigns.getByRole("link", { name: "t230 The Ashen Crown" })).toHaveAttribute("href", `/campaigns/${crown}`);
  await expect(campaigns.getByRole("link", { name: "t230 The Lantern Road" })).toHaveAttribute("href", `/campaigns/${lantern}`);
});

test("Google Calendar: the way back lands on Your Room, and Connect leaves for Google", async ({ page, signIn, newPerson, hearthside }) => {
  const me = await newPerson("Hollis Brand");
  await signIn(me);
  // Back from Google: the result shows on the card, on Integrations, and the address drops it.
  await page.goto("/room?gcal=connected");
  const card = page.getByRole("region", { name: "Google Calendar" });
  await expect(card.getByRole("status")).toHaveText("Google Calendar connected!", FIRST_LOAD);
  await expect(page.getByRole("tab", { name: "Integrations" })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(hearthside.url("/room"));
  await expect(card).toContainText("Not connected");

  // Connect asks the backend for Google's page and goes there; Google's page stands in here, sending them
  // back as the callback would.
  let asked = 0;
  await page.route("**/api/google-calendar/auth-url", (route) => {
    asked++;
    return route.fulfill({ json: { url: hearthside.url("/room?gcal=denied") } });
  });
  await card.getByRole("button", { name: "Connect" }).click();
  await expect(card.getByRole("status")).toHaveText("Connecting Google Calendar was cancelled.");
  await expect(page).toHaveURL(hearthside.url("/room"));
  expect(asked).toBe(1);

  // A connection that predates free/busy: the reconnect line, and Disconnect.
  await page.route("**/api/google-calendar/status", (route) =>
    route.fulfill({ json: { connected: true, configured: true, freeBusy: false, needsReconsent: true } }));
  await page.goto("/room?tab=integrations");
  await expect(card).toContainText("Reconnect needed");
  await expect(card).toContainText("To let your busy time count when your party plans a night, reconnect once.");
  await expect(card.getByRole("button", { name: "Reconnect" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Disconnect" })).toBeVisible();

  // API keys stay on the portfolio.
  await page.getByRole("tab", { name: "Record" }).click();
  await expect(page.getByRole("link", { name: "Open your profile there" })).toHaveAttribute("href", /\/profile$/);
});

test.describe("at 375px", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("/players/<own id> is Your Room, and nothing scrolls sideways", async ({ page, signIn, apiAs, newPerson }) => {
    const [gm, me] = await Promise.all([newPerson("Corin Vale"), newPerson("Bartholomew Featherstonehaugh-Wainwright")]);
    const [gmApi, myApi] = await Promise.all([apiAs(gm), apiAs(me)]);
    await myApi.put("/api/users/profile", { data: { handle: "bartholomew_featherstonehaugh", favoriteGames: ["Twilight Imperium: Fourth Edition, with the Prophecy of Kings"] } });
    const long = "t230 The Extraordinarily Long-Winded Chronicle of the Unpronounceable Archipelagos";
    const other = "t230 Bones of the Brinewood";
    const a = await campaignOf(gmApi, [myApi], long);
    await campaignOf(gmApi, [myApi], other);
    await sessionOf(gmApi, a, "t230 A session whose name goes on and on past the edge of a phone", 2 * DAY);

    await signIn(me);
    await page.goto(`/players/${me.id}`);
    await expect(page).toHaveURL(/\/room$/, FIRST_LOAD);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bartholomew Featherstonehaugh-Wainwright", FIRST_LOAD);
    // Your Room is the place marked in the nav, behind the menu button on a phone.
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Your Room" })).toHaveAttribute("aria-current", "page");
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await sideways()).toBeLessThanOrEqual(0);

    await roomTab(page, /^Sessions/).click();
    await expect(page.getByRole("list", { name: "Coming up" })).toBeVisible();
    expect(await sideways()).toBeLessThanOrEqual(0);
    await roomTab(page, /^Campaigns/).click();
    await expect(page.getByRole("list", { name: "Your campaigns" }).getByRole("listitem")).toHaveCount(2);
    expect(await sideways()).toBeLessThanOrEqual(0);
    await page.getByRole("tab", { name: "Integrations" }).click();
    await expect(page.getByRole("region", { name: "Google Calendar" })).toBeVisible();
    expect(await sideways()).toBeLessThanOrEqual(0);

    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Your record" })).toBeVisible();
    expect(await sideways()).toBeLessThanOrEqual(0);
  });
});
