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
 *   signIn       signIn(person): this test's browser is signed in on both sites,
 *                with the backend's own session cookie on the parent domain.
 *   apiAs        apiAs(person): an APIRequestContext on the backend as them
 *                (bearer, so no CSRF header): seed what a test needs through the API.
 *   newPerson    newPerson(name): a fresh account, for a test that changes
 *                someone and so mustn't use the shared party.
 */
import { test as base, expect, request, type APIRequestContext } from "@playwright/test";
import crypto from "node:crypto";
import { bearerFor, backendCall, signUp, type Party, type Person } from "./stack/party";
import { STACK_ENV, type Stack } from "./stack/stack";

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
  signIn: (person: Pick<Person, "email" | "password">) => Promise<void>;
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

  signIn: async ({ context, stack }, use) => {
    await use(async (person) => {
      const { setCookie } = await backendCall(stack.backend, "POST", "/api/users/login", { body: { email: person.email, password: person.password } });
      const issued = setCookie.find((c) => c.startsWith(`${stack.cookie.name}=`));
      if (!issued) throw new Error(`Login set no ${stack.cookie.name} cookie: ${JSON.stringify(setCookie)}`);
      // Planted with the attributes the backend sent, so the browser treats it as it would the real one.
      const [pair, ...parts] = issued.split(";").map((p) => p.trim());
      const attrs = new Map(parts.map((p) => {
        const eq = p.indexOf("=");
        return eq < 0 ? [p.toLowerCase(), ""] : [p.slice(0, eq).toLowerCase(), p.slice(eq + 1)];
      }));
      const maxAge = Number(attrs.get("max-age"));
      const sameSite = ({ strict: "Strict", lax: "Lax", none: "None" } as const)[(attrs.get("samesite") ?? "lax").toLowerCase() as "lax"];
      await context.addCookies([{
        name: stack.cookie.name,
        value: pair.slice(stack.cookie.name.length + 1),
        domain: attrs.get("domain") ?? new URL(stack.portfolio).hostname,
        path: attrs.get("path") ?? "/",
        httpOnly: attrs.has("httponly"),
        secure: attrs.has("secure"),
        sameSite: sameSite ?? "Lax",
        expires: Number.isFinite(maxAge) ? Math.floor(Date.now() / 1000) + maxAge : -1,
      }]);
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
