/**
 * The party every run starts with, made through the backend's own API (as the
 * apps would make it), so it's whatever a real signup and campaign look like:
 *
 *   gm         created the campaign, so owns it and holds the torch (Game Master)
 *   players    two Players, who joined it
 *   outsider   has an account and no campaigns
 *   campaign   "The Sunken Lantern", In Progress
 *
 * Passwords are new each run. Each run has its own database, so the emails
 * can be fixed.
 */
import crypto from "node:crypto";

export interface Person {
  id: string;
  name: string;
  email: string;
  password: string;
}

export interface Party {
  gm: Person;
  players: [Person, Person];
  outsider: Person;
  campaign: { id: string; title: string };
}

/** A JSON call to the backend; throws on any status but the expected ones. */
export async function backendCall<T = any>(
  backendUrl: string,
  method: string,
  path: string,
  { body, token }: { body?: unknown; token?: string } = {},
): Promise<{ status: number; json: T; setCookie: string[] }> {
  const res = await fetch(`${backendUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = text;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return { status: res.status, json, setCookie: res.headers.getSetCookie() };
}

/** Signs up through the API. Signup doesn't sign in (spec #69), and login doesn't need the email verified. */
export async function signUp(backendUrl: string, name: string, email: string): Promise<Person> {
  const password = crypto.randomBytes(12).toString("base64url");
  await backendCall(backendUrl, "POST", "/api/users/register", { body: { name, email, password } });
  const { json } = await backendCall(backendUrl, "POST", "/api/users/login", { body: { email, password } });
  return { id: String(json.user.id), name, email, password };
}

/** A bearer token for someone: bearer calls need no CSRF header. */
export async function bearerFor(backendUrl: string, person: Pick<Person, "email" | "password">): Promise<string> {
  const { json } = await backendCall(backendUrl, "POST", "/api/users/login", { body: { email: person.email, password: person.password } });
  return json.token;
}

export async function seedParty(backendUrl: string): Promise<Party> {
  const [gm, p1, p2, outsider] = await Promise.all([
    signUp(backendUrl, "Morwen Ashby", "gm@party.test"),
    signUp(backendUrl, "Tobin Reed", "tobin@party.test"),
    signUp(backendUrl, "Isolde Varga", "isolde@party.test"),
    signUp(backendUrl, "Pell Outrider", "outsider@party.test"),
  ]);

  const title = "The Sunken Lantern";
  const { json } = await backendCall(backendUrl, "POST", "/api/campaigns", {
    token: await bearerFor(backendUrl, gm),
    body: {
      title,
      description: "A drowned lighthouse, and whatever keeps its lamp lit.",
      status: "In Progress",
      startDate: new Date().toISOString(),
    },
  });
  const campaign = { id: String(json.campaign.id), title };
  for (const player of [p1, p2]) {
    await backendCall(backendUrl, "POST", `/api/campaigns/${campaign.id}/join`, { token: await bearerFor(backendUrl, player) });
  }
  return { gm, players: [p1, p2], outsider, campaign };
}
