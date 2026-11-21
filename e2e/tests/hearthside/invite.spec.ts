/**
 * The campaign invite page (#232, spec #69): `/join/:id`, the campaign's id.
 * The banner (or its dyed cloth) and name above Accept and Decline; accepting
 * answers a pending invite (the bell's) or joins by the link, then lands on the
 * campaign's page; a signed-out visitor signs in or up first and comes back.
 *
 * Each test makes its own people and campaign, so the seeded party is left alone.
 */
import crypto from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, verifyLinkToken } from "../../fixtures";

/** A first visit compiles the route in dev mode, which can take most of the 15s assertion budget. */
const FIRST_LOAD = { timeout: 45_000 };

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function campaignOf(owner: APIRequestContext, title: string): Promise<string> {
  const made = await owner.post("/api/campaigns", {
    data: { title, description: "The old king's crown woke the dead.", status: "In Progress", startDate: "2026-03-14" },
  });
  expect(made.ok(), await made.text()).toBe(true);
  return String((await made.json()).campaign.id);
}

/** `a` and `b` become friends (invites go friend to friend), then `a` invites `b` to the campaign. */
async function inviteFriend(a: APIRequestContext, b: APIRequestContext, bId: string, campaignId: string) {
  expect((await a.post("/api/friends/request", { data: { toUserId: bId } })).ok()).toBe(true);
  const request = (await (await b.get("/api/friends/requests")).json()).incoming[0];
  expect((await b.put(`/api/friends/request/${request._id}`, { data: { action: "accept" } })).ok()).toBe(true);
  const sent = await a.post("/api/campaign-invites", { data: { campaignId, toUserId: bId } });
  expect(sent.status(), await sent.text()).toBe(201);
  const [pending] = await (await b.get("/api/campaign-invites/mine")).json();
  return { inviter: pending.from.handle ? `@${pending.from.handle}` : pending.from.name };
}

const pendingFor = async (api: APIRequestContext) => (await (await api.get("/api/campaign-invites/mine")).json()).length;
const titlesFor = async (api: APIRequestContext) =>
  ((await (await api.get("/api/notifications")).json()).notifications as { title: string }[]).map((n) => n.title);
const isMember = async (api: APIRequestContext, campaignId: string, personId: string) => {
  const res = await api.get(`/api/campaigns/${campaignId}/members`);
  return res.ok() && (await res.json()).some((m: { playerId?: string }) => m.playerId === personId);
};

const panel = (page: Page) => page.getByRole("main");

/** On the campaign's page, the party member it was meant to make. */
async function landedOn(page: Page, id: string, title: string) {
  await expect(page).toHaveURL(new RegExp(`/campaigns/${id}$`), FIRST_LOAD);
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible(FIRST_LOAD);
}

test("a signed-in invitee sees the banner and who called them, accepts, and lands on the campaign's page", async ({ page, newPerson, apiAs, signIn, hearthside }) => {
  const [owner, invitee] = await Promise.all([newPerson("Morwen Ashby"), newPerson("Tobin Reed")]);
  const [ownerApi, inviteeApi] = await Promise.all([apiAs(owner), apiAs(invitee)]);
  const title = "t232 The Ashen Crown";
  const id = await campaignOf(ownerApi, title);
  const { inviter } = await inviteFriend(ownerApi, inviteeApi, invitee.id, id);

  // The stack has no uploads: stand in for the banner's presigned read URL (on the backend's own
  // reply to the invitee) and the picture behind it.
  const picture = hearthside.url("/fake-storage/banner.png");
  await page.route(`**/api/campaigns/${id}`, async (route) => {
    const res = await inviteeApi.get(`/api/campaigns/${id}`);
    expect(res.ok(), await res.text()).toBe(true);
    return route.fulfill({ json: { ...(await res.json()), bannerUrl: picture } });
  });
  await page.route("**/fake-storage/banner.png", (route) => route.fulfill({ contentType: "image/png", body: PNG }));

  await signIn(invitee);
  await page.goto(`/join/${id}`);
  await expect(panel(page).getByRole("heading", { name: title, level: 1 })).toBeVisible(FIRST_LOAD);
  await expect(panel(page).getByText("A summons for the party")).toBeVisible();
  await expect(panel(page).getByRole("img", { name: `${title} banner` })).toBeVisible();
  await expect(panel(page)).toContainText(`Sent by ${inviter}`);
  await expect(panel(page)).toContainText("The old king's crown woke the dead.");

  await panel(page).getByRole("button", { name: "Accept" }).click();
  await landedOn(page, id, title);
  // The invite was answered, not left pending beside a join: the bell's entry is gone and the inviter heard.
  expect(await pendingFor(inviteeApi)).toBe(0);
  expect(await isMember(inviteeApi, id, invitee.id)).toBe(true);
  expect((await titlesFor(ownerApi)).some((t) => t.includes(`accepted your invite to "${title}"`))).toBe(true);
});

test("declining turns the invite down: no seat, and the inviter hears", async ({ page, newPerson, apiAs, signIn }) => {
  const [owner, invitee] = await Promise.all([newPerson("Isolde Varga"), newPerson("Pell Outrider")]);
  const [ownerApi, inviteeApi] = await Promise.all([apiAs(owner), apiAs(invitee)]);
  const title = "t232 Starfall Salvage";
  const id = await campaignOf(ownerApi, title);
  await inviteFriend(ownerApi, inviteeApi, invitee.id, id);

  await signIn(invitee);
  await page.goto(`/join/${id}`);
  await panel(page).getByRole("button", { name: "Decline" }).click();
  await expect(panel(page).getByRole("status")).toHaveText("You’ve declined the summons.");
  await expect(panel(page).getByRole("button", { name: "Accept" })).toHaveCount(0);
  await expect(panel(page).getByRole("link", { name: "Back to the Hearth" })).toBeVisible();

  expect(await pendingFor(inviteeApi)).toBe(0);
  expect(await isMember(inviteeApi, id, invitee.id)).toBe(false);
  expect((await titlesFor(ownerApi)).some((t) => t.includes(`declined your invite to "${title}"`))).toBe(true);
});

test("a campaign with no banner shows its dyed cloth, and someone already at the table is pointed to it", async ({ page, newPerson, apiAs, signIn }) => {
  const owner = await newPerson("Wren Talbot");
  const title = "Curse of the Ashen Crown";
  const id = await campaignOf(await apiAs(owner), title);

  await signIn(owner);
  await page.goto(`/join/${id}`);
  await expect(panel(page).getByRole("img", { name: `${title}: no banner yet` })).toBeVisible(FIRST_LOAD);
  await expect(panel(page).getByRole("img", { name: `${title}: no banner yet` })).toHaveText("CA");
  await expect(panel(page).getByRole("status")).toHaveText("You already have a seat at this table.");
  await expect(panel(page).getByRole("button", { name: "Accept" })).toHaveCount(0);
  await expect(panel(page).getByRole("link", { name: "Go to the campaign" })).toHaveAttribute("href", `/campaigns/${id}`);
});

test("a link to no campaign says the summons has faded", async ({ page, party, signIn }) => {
  await signIn(party.outsider);
  await page.goto(`/join/${crypto.randomUUID()}`);
  await expect(panel(page).getByRole("heading", { name: "This summons has faded", level: 1 })).toBeVisible(FIRST_LOAD);
  await expect(panel(page).getByRole("link", { name: "Back to the Hearth" })).toHaveAttribute("href", "/");
});

test("signed out, the invitee signs in, comes back to the invite and accepts", async ({ page, newPerson, apiAs }) => {
  // Four pages, each compiled on its first visit in dev mode: more than one page's budget.
  test.setTimeout(120_000);
  const [owner, invitee] = await Promise.all([newPerson("Corin Vale"), newPerson("Ada Wren")]);
  const [ownerApi, inviteeApi] = await Promise.all([apiAs(owner), apiAs(invitee)]);
  const title = "t232 Bones of the Brinewood";
  const id = await campaignOf(ownerApi, title);
  await inviteFriend(ownerApi, inviteeApi, invitee.id, id);

  await page.goto(`/join/${id}`);
  await expect(panel(page).getByRole("heading", { name: "You’re called to the table", level: 1 })).toBeVisible(FIRST_LOAD);
  await panel(page).getByRole("link", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/login\\?redirect=%2Fjoin%2F${id}$`), FIRST_LOAD);
  await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible(FIRST_LOAD);
  await page.getByLabel("Email").fill(invitee.email);
  await page.getByLabel("Password").fill(invitee.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`/join/${id}$`), FIRST_LOAD);
  await panel(page).getByRole("button", { name: "Accept" }).click();
  await landedOn(page, id, title);
  expect(await pendingFor(inviteeApi)).toBe(0);
});

test("signed out, a new player signs up, follows the email's link back to the invite and accepts", async ({ page, newPerson, apiAs, stack }) => {
  // Six pages, each compiled on its first visit in dev mode, and the verify page's pause before moving on.
  test.setTimeout(120_000);
  const owner = await newPerson("Tamsin Oakhart");
  const ownerApi = await apiAs(owner);
  const title = "t232 The Lantern Road";
  const id = await campaignOf(ownerApi, title);
  const email = `t232-${crypto.randomUUID()}@people.test`;

  await page.goto(`/join/${id}`);
  await panel(page).getByRole("link", { name: "New here? Create an account" }).click();
  await expect(page).toHaveURL(new RegExp(`/signup\\?redirect=%2Fjoin%2F${id}$`), FIRST_LOAD);
  await expect(page.getByRole("heading", { name: "Join the party", level: 1 })).toBeVisible(FIRST_LOAD);
  await page.getByLabel("Your name").fill("Fenn Arrow");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("a-long-enough-password");
  await page.getByRole("button", { name: "Create my account" }).click();
  await expect(page.getByRole("heading", { name: "Check your email", level: 1 })).toBeVisible(FIRST_LOAD);
  // Signing in from here instead (another browser opened the link) would come back too.
  await expect(page.getByRole("link", { name: "Go to sign in" })).toHaveAttribute("href", `/login?redirect=%2Fjoin%2F${id}`);

  await page.goto(`/verify-email?token=${await verifyLinkToken(stack, email)}`);
  await expect(page.getByRole("heading", { name: "Welcome to the table", level: 1 })).toBeVisible(FIRST_LOAD);
  await expect(page).toHaveURL(new RegExp(`/join/${id}$`), FIRST_LOAD);
  await panel(page).getByRole("button", { name: "Accept" }).click();
  await landedOn(page, id, title);
  const members = await (await ownerApi.get(`/api/campaigns/${id}/members`)).json();
  expect(members.some((m: { email?: string }) => m.email === email)).toBe(true);
});

test.describe("at 375px", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("nothing scrolls sideways, and the link alone is enough to join", async ({ page, newPerson, apiAs, signIn }) => {
    const [owner, stranger] = await Promise.all([newPerson("Odile Marsh"), newPerson("Bartholomew Underhill-Featherstonehaugh")]);
    const title = "The Extraordinarily Long-Winded Chronicle of the Unpronounceable Archipelagos";
    const id = await campaignOf(await apiAs(owner), title);

    await signIn(stranger);
    await page.goto(`/join/${id}`);
    await expect(panel(page).getByRole("img", { name: `${title}: no banner yet` })).toBeVisible(FIRST_LOAD);
    await expect(panel(page).getByRole("button", { name: "Accept" })).toBeVisible();
    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await sideways()).toBeLessThanOrEqual(0);
    const accept = await panel(page).getByRole("button", { name: "Accept" }).boundingBox();
    expect(accept && accept.x + accept.width).toBeLessThanOrEqual(375);

    await panel(page).getByRole("button", { name: "Accept" }).click();
    await expect(page).toHaveURL(new RegExp(`/campaigns/${id}$`), FIRST_LOAD);
    expect(await isMember(await apiAs(stranger), id, stranger.id)).toBe(true);
  });
});
