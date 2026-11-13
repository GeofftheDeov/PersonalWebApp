/**
 * Hearthside's signing-in pages, and one login across both sites (#219, spec #69).
 * The portfolio-to-Hearthside direction is in tests/portfolio/smoke.spec.ts.
 */
import { test, expect, logInAndPlant, verifyLinkToken } from "../../fixtures";
import { backendCall } from "../../stack/party";
import { startDevEnvironment } from "../../stack/dev-environment";
import type { BrowserContext, Page } from "@playwright/test";

/** A first visit compiles the page (dev mode): wait the navigation budget, not the assertion one. */
const FIRST_VISIT = { timeout: 45_000 };

// One at a time: each test's first visits compile pages, and ten tests compiling at once (beside the
// other specs') ran past the navigation budget. In order, a failure doesn't skip the rest.
test.describe.configure({ mode: "default" });

/** Sign in on the login page, once it's the one showing. */
async function fillLogin(page: Page, person: { email: string; password: string }) {
  await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible(FIRST_VISIT);
  await page.getByLabel("Email").fill(person.email);
  await page.getByLabel("Password").fill(person.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

const hasCookie = async (context: BrowserContext, name: string) => (await context.cookies()).some((c) => c.name === name);

test("a gated page sends you to sign in, back again after, and the portfolio is signed in too", async ({ page, party, portfolio }) => {
  await page.goto("/campaigns");
  await expect(page).toHaveURL(/\/login\?redirect=%2Fcampaigns$/, FIRST_VISIT);
  await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible(FIRST_VISIT);

  await fillLogin(page, party.players[0]);
  await expect(page).toHaveURL(/\/campaigns$/);
  await expect(page.getByRole("main").getByRole("heading", { name: "Campaigns", level: 1 })).toBeVisible(FIRST_VISIT);

  await page.goto(portfolio.url("/"));
  await expect(page.getByRole("button", { name: "LOGOUT" })).toBeVisible(FIRST_VISIT);
});

test("a wrong password says so, and a return URL off this site is ignored", async ({ page, party, hearthside }) => {
  await page.goto("/login?redirect=https%3A%2F%2Fevil.example%2F");
  await fillLogin(page, { email: party.outsider.email, password: "not-the-password" });
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("That email and password don’t match an account.", FIRST_VISIT);

  await fillLogin(page, party.outsider);
  await expect(page).toHaveURL(hearthside.url("/"), FIRST_VISIT);
  await expect(page.getByRole("button", { name: "LOGOUT" })).toBeVisible();
});

test("logging out on Hearthside logs you out of the portfolio", async ({ page, context, party, portfolio, signIn, stack }) => {
  await signIn(party.players[1]);
  await page.goto("/");
  await page.getByRole("button", { name: "LOGOUT" }).click();
  await expect(page.getByRole("link", { name: "LOGIN" }).first()).toBeVisible();
  await expect.poll(() => hasCookie(context, stack.cookie.name)).toBe(false);

  await page.goto(portfolio.url("/"));
  await expect(page.getByRole("link", { name: "LOGIN" }).first()).toBeVisible(FIRST_VISIT);
});

test("logging out on the portfolio logs you out of Hearthside", async ({ page, context, party, portfolio, signIn, stack }) => {
  await signIn(party.players[1]);
  await page.goto(portfolio.url("/"));
  await page.getByRole("button", { name: "LOGOUT" }).click();
  await expect.poll(() => hasCookie(context, stack.cookie.name)).toBe(false);

  await page.goto("/campaigns");
  await expect(page).toHaveURL(/\/login\?redirect=%2Fcampaigns$/, FIRST_VISIT);
});

test("when the session expires mid-page, you sign in and come back to that page", async ({ page, context, party, signIn }) => {
  const [player] = party.players;
  await signIn(player);
  await page.goto("/campaigns");
  await expect(page.getByRole("tab", { name: /^All \d+$/ })).toBeVisible(FIRST_VISIT);

  // The cookie lasts as long as its token: when the token expires, the browser drops it.
  await context.clearCookies();
  await page.getByRole("button", { name: "New campaign" }).click();
  const dialog = page.getByRole("dialog", { name: "New campaign" });
  await dialog.getByLabel("Title").fill("Never Saved");
  await dialog.getByLabel("Description").fill("The session ran out first.");
  await dialog.getByLabel("Starts").fill("2026-12-05");
  await dialog.getByRole("button", { name: "Create the campaign" }).click();

  await expect(page).toHaveURL(/\/login\?redirect=%2Fcampaigns$/, FIRST_VISIT);
  await fillLogin(page, player);
  await expect(page).toHaveURL(/\/campaigns$/);
  await expect(page.getByRole("main").getByRole("heading", { name: "Campaigns", level: 1 })).toBeVisible();
});

test("signing up on Hearthside, then following the email's link in the same browser, signs you in", async ({ page, context, stack }) => {
  const email = `t219-${crypto.randomUUID()}@people.test`;
  await page.goto("/signup?redirect=%2Fcampaigns");
  await page.getByLabel("Your name").fill("Wren Halloway");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("a-long-enough-password");
  await page.getByRole("button", { name: "Create my account" }).click();
  await expect(page.getByRole("heading", { name: "Check your email", level: 1 })).toBeVisible(FIRST_VISIT);
  expect(await hasCookie(context, stack.cookie.name)).toBe(false);

  await page.goto(`/verify-email?token=${await verifyLinkToken(stack, email)}`);
  await expect(page.getByRole("heading", { name: "Welcome to the table", level: 1 })).toBeVisible(FIRST_VISIT);
  // On by itself, back to where the signup came from, signed in.
  await expect(page).toHaveURL(/\/campaigns$/, FIRST_VISIT);
  await expect(page.getByRole("main").getByRole("heading", { name: "Campaigns", level: 1 })).toBeVisible(FIRST_VISIT);
  expect(await hasCookie(context, stack.cookie.name)).toBe(true);
});

test("following the email's link in another browser confirms the email, and you sign in next", async ({ page, context, newPerson, stack }) => {
  // Signed up through the API: this browser never had the signup cookie.
  const person = await newPerson("Corin Vale");
  const token = await verifyLinkToken(stack, person.email);
  await page.goto(`/verify-email?token=${token}`);
  await expect(page.getByRole("heading", { name: "Email confirmed", level: 1 })).toBeVisible(FIRST_VISIT);
  expect(await hasCookie(context, stack.cookie.name)).toBe(false);

  // On by itself to sign in.
  await expect(page).toHaveURL(/\/login$/, FIRST_VISIT);
  await fillLogin(page, person);
  await expect(page.getByRole("button", { name: "LOGOUT" })).toBeVisible(FIRST_VISIT);

  // The link works once.
  await page.goto(`/verify-email?token=${token}`);
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("Invalid or expired token");
});

test("forgot password sends a link, and a reset link that doesn't work says so", async ({ page, party }) => {
  await page.goto("/login");
  await page.getByRole("link", { name: "Forgot your password?" }).click();
  await expect(page.getByRole("heading", { name: "Forgot your password?", level: 1 })).toBeVisible(FIRST_VISIT);
  await page.getByLabel("Email").fill(party.outsider.email);
  await page.getByRole("button", { name: "Send the link" }).click();
  await expect(page.getByRole("status")).toContainText("a reset link is on its way", FIRST_VISIT);

  await page.goto("/reset-password?token=not-a-real-token");
  await page.getByLabel("New password", { exact: true }).fill("another-password");
  await page.getByLabel("The same again").fill("another-passwrod");
  await page.getByRole("button", { name: "Set my password" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("The two passwords don’t match.", FIRST_VISIT);
  await page.getByLabel("The same again").fill("another-password");
  await page.getByRole("button", { name: "Set my password" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("Invalid or expired token Send a new link");
});

test.describe("at 375px", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("the sign-in pages fit a phone", async ({ page }) => {
    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    for (const [path, heading] of [["/login", "Sign in"], ["/signup", "Join the party"]] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible(FIRST_VISIT);
      expect(await sideways(), path).toBeLessThanOrEqual(0);
    }
  });
});

test("each environment's session cookie signs nobody in on the other's hosts", async ({ page, context, party, signIn, stack }) => {
  // Starting the dev backend (and its database) takes a while.
  test.setTimeout(150_000);
  const dev = await startDevEnvironment(stack);
  try {
    const person = party.outsider;
    // The same person, with the same password, in the dev environment's own database.
    await backendCall(dev.backend, "POST", "/api/users/register", { body: { name: person.name, email: person.email, password: person.password } });

    // Prod's cookie, on the parent domain, reaches the dev host; dev's backend ignores it.
    await signIn(person);
    await page.goto(`${dev.hearthside}/campaigns`);
    await expect(page).toHaveURL(`${dev.hearthside}/login?redirect=%2Fcampaigns`, FIRST_VISIT);
    expect((await context.cookies(dev.hearthside)).map((c) => c.name)).toContain(stack.cookie.name);

    // Dev's own cookie does sign in there...
    await logInAndPlant(context, dev.backend, person, dev.cookieName, new URL(dev.hearthside).hostname);
    await page.goto(`${dev.hearthside}/campaigns`);
    await expect(page.getByRole("main").getByRole("heading", { name: "Campaigns", level: 1 })).toBeVisible(FIRST_VISIT);

    // ...and, alone, signs nobody in on prod's hosts.
    await context.clearCookies({ name: stack.cookie.name });
    await page.goto("/campaigns");
    await expect(page).toHaveURL(/\/login\?redirect=%2Fcampaigns$/, FIRST_VISIT);
    expect((await context.cookies(page.url())).map((c) => c.name)).toContain(dev.cookieName);
  } finally {
    await dev.stop();
  }
});
