/**
 * What every spec imports instead of @playwright/test:
 *
 *   import { test, expect } from "../fixtures";
 *
 * Fixtures, beyond Playwright's own:
 *   site         "portfolio" or "hearthside": which app `page.goto("/…")` and
 *                `baseURL` mean. Set by the project (tests/portfolio/,
 *                tests/hearthside/); `test.use({ site })` overrides it.
 *   stack        the run's stack (stack/stack.ts): both origins, the backend, the cookie.
 *   portfolio    url(path) on the portfolio, for a spec that visits both sites.
 *   hearthside   url(path) on Hearthside.
 *   party        the seeded party (stack/party.ts): gm, players[0..1], outsider, campaign.
 *   signIn       signIn(person, context?): this test's browser (or another
 *                context, for a second person in the same test) is signed in on both sites,
 *                with the backend's own session cookie on the parent domain.
 *   apiAs        apiAs(person): an APIRequestContext on the backend as them
 *                (bearer, so no CSRF header): seed what a test needs through the API.
 *   newPerson    newPerson(name): a fresh account, for a test that changes
 *                someone and so mustn't use the shared party.
 */
import { test as base, expect, request, type APIRequestContext, type BrowserContext } from "@playwright/test";
import crypto from "node:crypto";
import { bearerFor, backendCall, signUp, type Party, type Person } from "./stack/party";
import { runBackendScript, STACK_ENV, type Stack } from "./stack/stack";

export type Site = "portfolio" | "hearthside";

export interface SiteUrls {
  origin: string;
  url(path?: string): string;
}

export interface Options {
  site: Site;
}

interface Fixtures {
  portfolio: SiteUrls;
  hearthside: SiteUrls;
  party: Party;
  signIn: (person: Pick<Person, "email" | "password">, other?: BrowserContext) => Promise<void>;
  apiAs: (person: Pick<Person, "email" | "password">) => Promise<APIRequestContext>;
  newPerson: (name: string) => Promise<Person>;
}

interface WorkerFixtures {
  stack: Stack;
}

const siteUrls = (origin: string): SiteUrls => ({ origin, url: (path = "/") => new URL(path, origin).toString() });

export const test = base.extend<Options & Fixtures, WorkerFixtures>({
  site: ["portfolio", { option: true }],
  stack: [async ({}, use) => {
    const raw = process.env[STACK_ENV];
    if (!raw) throw new Error(`${STACK_ENV} isn't set: run the specs through playwright.config.ts, whose global setup starts the stack.`);
    await use(JSON.parse(raw));
  }, { scope: "worker" }],
  baseURL: async ({ site, stack }, use) => use(stack[site]),
  portfolio: async ({ stack }, use) => use(siteUrls(stack.portfolio)),
  hearthside: async ({ stack }, use) => use(siteUrls(stack.hearthside)),
  party: async ({ stack }, use) => use(stack.party),

  signIn: async ({ context: own, stack }, use) => {
    await use(async (person, context = own) => {
      await logInAndPlant(context, stack.backend, person, stack.cookie.name, new URL(stack.portfolio).hostname);
    });
  },

  apiAs: async ({ stack }, use) => {
    const contexts: APIRequestContext[] = [];
    await use(async (person) => {
      const ctx = await request.newContext({
        baseURL: stack.backend,
        extraHTTPHeaders: { authorization: `Bearer ${await bearerFor(stack.backend, person)}` },
      });
      contexts.push(ctx);
      return ctx;
    });
    await Promise.all(contexts.map((c) => c.dispose()));
  },

  newPerson: async ({ stack }, use) => {
    await use((name) => signUp(stack.backend, name, `${crypto.randomUUID()}@people.test`));
  },
});

export { expect };

/**
 * Log `person` in on `backendUrl` and plant the session cookie it issued (`cookieName`) in `context`,
 * with the attributes the backend sent, so the browser treats it as it would the real one. `host` is
 * where a cookie without a Domain goes. `signIn` uses it for the stack; a test of another environment
 * (stack/dev-environment.ts) uses it for that one's backend.
 */
export async function logInAndPlant(
  context: BrowserContext, backendUrl: string, person: Pick<Person, "email" | "password">, cookieName: string, host: string,
): Promise<void> {
  const { setCookie } = await backendCall(backendUrl, "POST", "/api/users/login", { body: { email: person.email, password: person.password } });
  const issued = setCookie.find((c) => c.startsWith(`${cookieName}=`));
  if (!issued) throw new Error(`Login set no ${cookieName} cookie: ${JSON.stringify(setCookie)}`);
  const [pair, ...parts] = issued.split(";").map((p) => p.trim());
  const attrs = new Map(parts.map((p) => {
    const eq = p.indexOf("=");
    return eq < 0 ? [p.toLowerCase(), ""] : [p.slice(0, eq).toLowerCase(), p.slice(eq + 1)];
  }));
  const maxAge = Number(attrs.get("max-age"));
  const sameSite = ({ strict: "Strict", lax: "Lax", none: "None" } as const)[(attrs.get("samesite") ?? "lax").toLowerCase() as "lax"];
  await context.addCookies([{
    name: cookieName,
    value: pair.slice(cookieName.length + 1),
    domain: attrs.get("domain") ?? host,
    path: attrs.get("path") ?? "/",
    httpOnly: attrs.has("httponly"),
    secure: attrs.has("secure"),
    sameSite: sameSite ?? "Lax",
    expires: Number.isFinite(maxAge) ? Math.floor(Date.now() / 1000) + maxAge : -1,
  }]);
}

/**
 * The token the verify email would carry for `email`, an account that signed up and isn't verified yet:
 * the stack sends no mail, so a fresh one is issued in its place (backend/scripts/e2e-database.ts).
 */
export async function verifyLinkToken(stack: Stack, email: string): Promise<string> {
  return (await runBackendScript(["scripts/e2e-database.ts", "verify-token", stack.databaseUrl, email])).trim();
}
