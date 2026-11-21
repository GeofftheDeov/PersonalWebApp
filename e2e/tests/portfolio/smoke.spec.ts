import { test, expect } from "../../fixtures";

test("the portfolio renders", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "GEOFFTHEDEV" })).toBeVisible();
  // Signed out, the home page shows its hero once the backend has said so.
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Geoff's");
});

test("logging in on the portfolio logs you in on Hearthside, with a Secure cookie on the parent domain", async ({ page, context, party, hearthside, stack }) => {
  const [player] = party.players;
  await page.goto("/login");
  await page.getByPlaceholder("name@example.com").fill(player.email);
  await page.getByPlaceholder("••••••••").fill(player.password);
  await page.getByRole("button", { name: "SIGN IN", exact: true }).click();
  // The dashboard's first visit compiles it (dev mode), which under the whole suite's load can take most of
  // 15s: give it the navigation budget (playwright.config.ts), not the assertion one.
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 45_000 });

  const cookie = (await context.cookies()).find((c) => c.name === stack.cookie.name);
  expect(cookie).toMatchObject({ domain: stack.cookie.domain, secure: true, httpOnly: true, sameSite: "Lax" });

  await page.goto(hearthside.url("/"));
  await expect(page.getByRole("button", { name: "LOGOUT" })).toBeVisible();
});
