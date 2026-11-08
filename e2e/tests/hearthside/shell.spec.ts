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
  await expect(page.getByRole("main").getByRole("heading", { name: "The Hearth" })).toBeVisible();
});

test.describe("at 375px", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("nothing scrolls sideways, and the nav opens from its menu button", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("main").getByRole("heading", { name: "The Hearth" })).toBeVisible();
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
