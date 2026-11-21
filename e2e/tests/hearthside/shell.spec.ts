import { test, expect } from "../../fixtures";

test.beforeEach(async ({ signIn, party }) => {
  await signIn(party.players[0]);
});

test("Hearthside renders its shell under the top bar", async ({ page }) => {
  await page.goto("/");

  // The GeofftheDeov top bar, signed in.
  await expect(page.getByRole("link", { name: "GEOFFTHEDEV" })).toBeVisible();
  await expect(page.getByRole("button", { name: "LOGOUT" })).toBeVisible();

  // The shell: the rail's nav with this place marked, and the page.
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link")).toHaveText(["The Hearth", "Campaigns", "Almanac", "Adventurers", "Your Room"]);
  await expect(nav.getByRole("link", { name: "The Hearth" })).toHaveAttribute("aria-current", "page");
  // The Hearth greets the player (#222).
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toHaveText(/^Good (morning|afternoon|evening), Tobin$/);
});

// The fonts are committed with the app (src/fonts), not fetched from Google
// Fonts when it builds: every face loads, from Hearthside's own host.
test("every font loads, from Hearthside itself", async ({ page }) => {
  const fontHosts = new Set<string>();
  page.on("request", (r) => { if (r.resourceType() === "font") fontHosts.add(new URL(r.url()).host); });
  await page.goto("/");
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();

  const families = [
    "Hearthside IM Fell English SC", "Hearthside IM Fell English", "Hearthside Alegreya Sans SC",
    "Hearthside Alegreya Sans", "Hearthside Inter", "Hearthside Permanent Marker",
  ];
  // Loads each family's Latin face (bold for the small caps, which has no 400) and reports how many loaded.
  const loaded = await page.evaluate(async (names) => Promise.all(names.map(async (name) => {
    const faces = await document.fonts.load(`${name.endsWith("Sans SC") ? 700 : 400} 16px "${name}"`, "Aa");
    return [name, faces.filter((f) => f.status === "loaded").length] as const;
  })), families);
  for (const [name, count] of loaded) expect(count, `${name} loads`).toBeGreaterThan(0);
  expect([...fontHosts]).toEqual([new URL(page.url()).host]);
});

test.describe("at 375px", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("nothing scrolls sideways, and the nav opens from its menu button", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toHaveText(/^Good (morning|afternoon|evening), Tobin$/);
    await expect(page.getByRole("region", { name: "The Notice Board" })).toBeVisible();
    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await sideways()).toBeLessThanOrEqual(0);

    const nav = page.getByRole("navigation", { name: "Main" });
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    await expect(nav).toBeHidden();
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await expect(nav.getByRole("link")).toHaveText(["The Hearth", "Campaigns", "Almanac", "Adventurers", "Your Room"]);
    expect(await sideways()).toBeLessThanOrEqual(0);
  });
});
