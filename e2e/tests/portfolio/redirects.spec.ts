/**
 * The portfolio hands Game Night to Hearthside (#234, spec #69, "Route ownership
 * and redirects"): `/game-night`, `/game-night/*` and `/players/:id` answer with
 * a 308 to the matching Hearthside page, prefix stripped and query string kept,
 * and the browser keeps the `#` anchor. The portfolio also links to Hearthside.
 *
 * The stack builds the portfolio with NEXT_PUBLIC_HEARTHSIDE_URL set to its
 * Hearthside host, so the redirects are on here. The other half of the gate (no
 * host configured, so the old /game-night pages keep serving) is checked against
 * the portfolio's real next.config.js in packages/shared/test/hearthside-redirects.test.ts:
 * a second portfolio dev server without the setting would need its own .next folder
 * and a cold compile of every /game-night page, for a switch that lives in the config.
 */
import { request, type Page, type Response } from "@playwright/test";
import { test, expect } from "../../fixtures";

/** A first visit compiles the route in dev mode, which can take most of the 15s assertion budget. */
const FIRST_LOAD = { timeout: 45_000 };

const main = (page: Page) => page.getByRole("main");

/**
 * The portfolio's own answer on the way to where a navigation landed: the
 * response to the first request of its redirect chain, and how many hops it took.
 */
async function firstHop(landed: Response | null) {
  expect(landed, "the navigation got a response").not.toBeNull();
  let req = landed!.request();
  let hops = 0;
  while (req.redirectedFrom()) {
    req = req.redirectedFrom()!;
    hops += 1;
  }
  const answer = await req.response();
  return { url: req.url(), status: answer?.status(), location: answer?.headers()["location"], hops };
}

test("the 308 itself: prefix stripped, query string kept, to the configured Hearthside host", async ({ stack, hearthside }) => {
  // Node's HTTP client doesn't use the browser's host rules (stack/hosts.ts), so ask the portfolio's
  // server at 127.0.0.1 with its real Host header. Its redirects happen before any page renders.
  const portfolio = new URL(stack.portfolio);
  const api = await request.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: { host: portfolio.host } });
  try {
    const cases: [string, string][] = [
      ["/game-night/join/c-234", "/join/c-234"],
      ["/game-night/campaigns/c-234?x=1", "/campaigns/c-234?x=1"],
      ["/players/p-234", "/players/p-234"],
      ["/game-night", "/"],
      ["/game-night?tab=sessions", "/?tab=sessions"],
      ["/game-night/sessions/s-234?a=1&b=two%20words", "/sessions/s-234?a=1&b=two%20words"],
      ["/game-night/characters/a-234", "/characters/a-234"],
    ];
    for (const [from, to] of cases) {
      const res = await api.get(`https://127.0.0.1:${portfolio.port}${from}`, { maxRedirects: 0 });
      expect(res.status(), from).toBe(308);
      expect(res.headers()["location"], from).toBe(hearthside.url(to));
    }
  } finally {
    await api.dispose();
  }
});

test("an old invite link, /game-night/join/:id, opens the campaign's invite on Hearthside", async ({ page, party, signIn, portfolio, hearthside }) => {
  const { id, title } = party.campaign;
  await signIn(party.outsider);
  const landed = await page.goto(portfolio.url(`/game-night/join/${id}`));
  expect(await firstHop(landed)).toEqual({
    url: portfolio.url(`/game-night/join/${id}`), status: 308, location: hearthside.url(`/join/${id}`), hops: 1,
  });
  await expect(page).toHaveURL(hearthside.url(`/join/${id}`));
  await expect(main(page).getByRole("heading", { name: title, level: 1 })).toBeVisible(FIRST_LOAD);
});

test("a bookmarked campaign page keeps its query string and its #anchor", async ({ page, party, signIn, portfolio, hearthside }) => {
  const { id, title } = party.campaign;
  await signIn(party.gm);
  const landed = await page.goto(portfolio.url(`/game-night/campaigns/${id}?x=1#notice-board`));
  // The anchor never reaches the server, so the Location hasn't one; the browser keeps it.
  expect(await firstHop(landed)).toEqual({
    url: portfolio.url(`/game-night/campaigns/${id}?x=1`), status: 308, location: hearthside.url(`/campaigns/${id}?x=1`), hops: 1,
  });
  await expect(page).toHaveURL(hearthside.url(`/campaigns/${id}?x=1#notice-board`));
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible(FIRST_LOAD);
});

test("a player's page, /players/:id, opens on Hearthside", async ({ page, party, signIn, portfolio, hearthside }) => {
  const { gm } = party;
  await signIn(party.players[0]);
  const landed = await page.goto(portfolio.url(`/players/${gm.id}`));
  expect(await firstHop(landed)).toEqual({
    url: portfolio.url(`/players/${gm.id}`), status: 308, location: hearthside.url(`/players/${gm.id}`), hops: 1,
  });
  await expect(page).toHaveURL(hearthside.url(`/players/${gm.id}`));
  await expect(main(page).getByRole("heading", { level: 1 })).toHaveText(gm.name, FIRST_LOAD);
});

test("the portfolio links to Hearthside: from its home page, and Game Night in the top bar", async ({ page, party, signIn, hearthside }) => {
  // Signed out, the home page's "What's Inside" lists the planner, with a link to its site.
  await page.goto("/");
  const visit = page.getByRole("link", { name: "Visit Hearthside" });
  await expect(visit).toHaveAttribute("href", hearthside.url("/"), FIRST_LOAD);

  // Signed in, the top bar's Game Night goes straight to Hearthside, not through the redirect.
  await signIn(party.players[0]);
  await page.goto("/about");
  await page.getByRole("button", { name: "MORE" }).click();
  const gameNight = page.getByRole("link", { name: "GAME NIGHT" });
  await expect(gameNight).toHaveAttribute("href", hearthside.url("/"), FIRST_LOAD);
  await gameNight.click();
  await expect(page).toHaveURL(hearthside.url("/"), FIRST_LOAD);
});
