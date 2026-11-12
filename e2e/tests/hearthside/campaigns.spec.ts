/**
 * The Campaigns page (#223, spec #69): layout B, "Roster". Status tabs with
 * counts over one card per campaign; the banner (or its dyed-cloth fallback)
 * behind a gilded panel; the owner's banner controls; New campaign.
 *
 * Each test makes its own people and campaigns, so the counts are exact and
 * the seeded party is left alone.
 */
import crypto from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "../../fixtures";

type Status = "Not Started" | "In Progress" | "Completed";

async function createCampaign(api: APIRequestContext, title: string, status: Status, extra: Record<string, string> = {}): Promise<string> {
  const res = await api.post("/api/campaigns", {
    data: { title, description: `${title}: a test campaign.`, status, startDate: "2026-03-14", ...extra },
  });
  expect(res.status(), await res.text()).toBe(201);
  return String((await res.json()).campaign.id);
}

const card = (page: Page, title: string) => page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: title }) });

test("the filters show the right counts and cards", async ({ page, newPerson, apiAs, signIn }) => {
  const owner = await newPerson("Wren Talbot");
  const api = await apiAs(owner);
  const ids = {
    crown: await createCampaign(api, "Curse of the Ashen Crown", "In Progress"),
    // The list is newest start first, so the two in progress start on different days.
    starfall: await createCampaign(api, "Starfall Salvage", "In Progress", { startDate: "2026-02-01" }),
    brinewood: await createCampaign(api, "Bones of the Brinewood", "Not Started"),
    lantern: await createCampaign(api, "The Lantern Road", "Completed", { endDate: "2026-09-01" }),
  };
  await signIn(owner);
  await page.goto("/campaigns");

  await expect(page.getByRole("main").getByRole("heading", { name: "Campaigns", level: 1 })).toBeVisible();
  const tabs = page.getByRole("tablist", { name: "Filter by status" }).getByRole("tab");
  await expect(tabs).toHaveText(["All 4", "In progress 2", "Not started 1", "Completed 1"]);
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");

  const shown = page.getByRole("tabpanel").getByRole("listitem");
  await expect(shown).toHaveCount(4);
  // Each card links to its campaign's page, and says its status and dates.
  await expect(card(page, "Curse of the Ashen Crown").getByRole("link", { name: "Curse of the Ashen Crown" }))
    .toHaveAttribute("href", `/campaigns/${ids.crown}`);
  await expect(card(page, "The Lantern Road")).toContainText("Completed");
  await expect(card(page, "The Lantern Road")).toContainText("Mar 14, 2026 – Sep 1, 2026");
  await expect(card(page, "Bones of the Brinewood")).toContainText("Starts Mar 14, 2026");

  await page.getByRole("tab", { name: "In progress 2" }).click();
  await expect(page.getByRole("tab", { name: "In progress 2" })).toHaveAttribute("aria-selected", "true");
  await expect(shown.getByRole("heading")).toHaveText(["Curse of the Ashen Crown", "Starfall Salvage"]);

  await page.getByRole("tab", { name: "Not started 1" }).click();
  await expect(shown.getByRole("heading")).toHaveText(["Bones of the Brinewood"]);

  await page.getByRole("tab", { name: "Completed 1" }).click();
  await expect(shown.getByRole("heading")).toHaveText(["The Lantern Road"]);

  await page.getByRole("tab", { name: "All 4" }).click();
  await expect(shown).toHaveCount(4);
});

test("creating a campaign from the dialog adds its card", async ({ page, newPerson, signIn }) => {
  const owner = await newPerson("Ada Quill");
  await signIn(owner);
  await page.goto("/campaigns");
  await expect(page.getByRole("tab", { name: "All 0" })).toBeVisible();

  await page.getByRole("button", { name: "New campaign" }).click();
  const dialog = page.getByRole("dialog", { name: "New campaign" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Title").fill("The Drowned Chapel");
  await dialog.getByLabel("Description").fill("Bells ring under the lake.");
  await dialog.getByLabel("Starts").fill("2026-12-05");
  await dialog.getByLabel("Status").selectOption("In Progress");
  await dialog.getByRole("button", { name: "Create the campaign" }).click();

  await expect(dialog).toBeHidden();
  await expect(card(page, "The Drowned Chapel")).toBeVisible();
  await expect(card(page, "The Drowned Chapel")).toContainText("In progress");
  await expect(card(page, "The Drowned Chapel")).toContainText("Since Dec 5, 2026");
  await expect(page.getByRole("tab", { name: "All 1" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "In progress 1" })).toBeVisible();
});

test("a campaign with no banner shows the dyed-cloth fallback with its initials", async ({ page, newPerson, apiAs, signIn }) => {
  const owner = await newPerson("Hollis Brand");
  await createCampaign(await apiAs(owner), "Curse of the Ashen Crown", "In Progress");
  await signIn(owner);
  await page.goto("/campaigns");

  const crown = card(page, "Curse of the Ashen Crown");
  const cloth = crown.getByRole("img", { name: "Curse of the Ashen Crown: no banner yet" });
  await expect(cloth).toBeVisible();
  await expect(cloth).toHaveText("CA");
  await expect(crown.locator("img")).toHaveCount(0);
});

test("the owner changes and removes a banner from the card", async ({ page, newPerson, apiAs, signIn, hearthside }) => {
  const owner = await newPerson("Mabry Kell");
  const api = await apiAs(owner);
  const id = await createCampaign(api, "Starfall Salvage", "In Progress");
  // Uploads are switched off on the test stack, so storage's two hops are stood in for here: the presigned
  // URL the backend would mint, and S3 taking the image. Saving the key and removing it are the real backend's.
  const key = `campaign-banners/${id}/${crypto.randomUUID()}.webp`;
  const uploads: { type: string | null; bytes: number }[] = [];
  await page.route(`**/api/campaigns/${id}/banner/upload-url`, (route) =>
    route.fulfill({ json: { url: hearthside.url("/fake-storage/put"), method: "PUT", headers: { "Content-Type": "image/webp" }, key } }));
  await page.route("**/fake-storage/put", (route) => {
    uploads.push({ type: route.request().headers()["content-type"] ?? null, bytes: route.request().postDataBuffer()?.length ?? 0 });
    return route.fulfill({ status: 200 });
  });

  await signIn(owner);
  await page.goto("/campaigns");
  const starfall = card(page, "Starfall Salvage");
  await expect(starfall.getByRole("button", { name: "Remove" })).toHaveCount(0);
  await starfall.getByRole("button", { name: "Add banner" }).click();

  const dialog = page.getByRole("dialog", { name: "The campaign's banner" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Pick an image").setInputFiles({
    name: "banner.png",
    mimeType: "image/png",
    // 1 × 1 PNG: the cropper covers the 4:1 frame with it.
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
  });
  await expect(dialog.getByRole("slider", { name: "Zoom" })).toBeVisible();
  await dialog.getByRole("button", { name: "Save the banner" }).click();
  await expect(dialog).toBeHidden();

  expect(uploads).toHaveLength(1);
  expect(uploads[0].bytes).toBeGreaterThan(0);
  expect((await (await api.get(`/api/campaigns/${id}`)).json()).bannerKey).toBe(key);
  await expect(starfall.getByRole("button", { name: "Change banner" })).toBeVisible();

  await starfall.getByRole("button", { name: "Remove" }).click();
  const confirm = page.getByRole("dialog", { name: "Remove the banner?" });
  await confirm.getByRole("button", { name: "Remove it" }).click();
  await expect(confirm).toBeHidden();
  await expect(starfall.getByRole("button", { name: "Add banner" })).toBeVisible();
  await expect(starfall.getByRole("button", { name: "Remove" })).toHaveCount(0);
  await expect(starfall.getByRole("img", { name: "Starfall Salvage: no banner yet" })).toBeVisible();
  expect((await (await api.get(`/api/campaigns/${id}`)).json()).bannerKey).toBeNull();
});

test("other players see no banner controls", async ({ page, newPerson, apiAs, signIn }) => {
  const [owner, player] = await Promise.all([newPerson("Odile Marsh"), newPerson("Fenn Arrow")]);
  const ownerApi = await apiAs(owner);
  const id = await createCampaign(ownerApi, "The Lantern Road", "In Progress");
  // A banner the owner could change or remove, if this were the owner.
  const banner = await ownerApi.put(`/api/campaigns/${id}/banner`, { data: { key: `campaign-banners/${id}/${crypto.randomUUID()}.webp` } });
  expect(banner.status(), await banner.text()).toBe(200);
  const joined = await (await apiAs(player)).post(`/api/campaigns/${id}/join`);
  expect(joined.status(), await joined.text()).toBe(201);

  await signIn(player);
  await page.goto("/campaigns");
  const lantern = card(page, "The Lantern Road");
  await expect(lantern).toBeVisible();
  await expect(lantern.getByRole("button")).toHaveCount(0);
});

test.describe("at 375px", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("nothing scrolls sideways, and the banner is a strip over the panel", async ({ page, newPerson, apiAs, signIn }) => {
    const owner = await newPerson("Tamsin Oakhart-Villeneuve");
    const api = await apiAs(owner);
    const longTitle = "The Extraordinarily Long-Winded Chronicle of the Unpronounceable Archipelagos";
    await createCampaign(api, longTitle, "In Progress");
    await createCampaign(api, "Bones of the Brinewood", "Completed", { endDate: "2026-09-01" });
    await signIn(owner);
    await page.goto("/campaigns");

    const crown = card(page, longTitle);
    await expect(crown.getByRole("button", { name: "Add banner" })).toBeVisible();
    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await sideways()).toBeLessThanOrEqual(0);

    // The strip: the whole banner across the card's top, the panel below it.
    const cloth = await crown.getByRole("img", { name: `${longTitle}: no banner yet` }).boundingBox();
    const panel = await crown.getByRole("heading", { name: longTitle }).boundingBox();
    const box = await crown.boundingBox();
    expect(cloth && panel && box).toBeTruthy();
    expect(Math.abs(cloth!.width / cloth!.height - 4)).toBeLessThan(0.1);
    expect(panel!.y).toBeGreaterThanOrEqual(cloth!.y + cloth!.height);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);

    await page.getByRole("button", { name: "New campaign" }).click();
    await expect(page.getByRole("dialog", { name: "New campaign" })).toBeVisible();
    expect(await sideways()).toBeLessThanOrEqual(0);
  });
});

test("on a wide screen the banner fills the card, with the panel over its left side", async ({ page, newPerson, apiAs, signIn }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const owner = await newPerson("Corin Vale");
  await createCampaign(await apiAs(owner), "Curse of the Ashen Crown", "In Progress");
  await signIn(owner);
  await page.goto("/campaigns");

  const crown = card(page, "Curse of the Ashen Crown");
  const cloth = crown.getByRole("img", { name: "Curse of the Ashen Crown: no banner yet" });
  await expect(cloth).toBeVisible();
  const box = (await crown.boundingBox())!;
  const bg = (await cloth.boundingBox())!;
  const panel = (await crown.getByRole("heading", { name: "Curse of the Ashen Crown" }).locator("xpath=ancestor::*[contains(@class,'hs-gilded')][1]").boundingBox())!;
  expect(box.width / box.height).toBeGreaterThanOrEqual(3.95);
  expect(Math.abs(bg.width - box.width)).toBeLessThan(2);
  expect(Math.abs(bg.height - box.height)).toBeLessThan(2);
  expect(panel.width).toBeLessThanOrEqual(box.width * 0.6 + 1);
  expect(panel.x).toBeLessThan(box.x + box.width / 2);
});
