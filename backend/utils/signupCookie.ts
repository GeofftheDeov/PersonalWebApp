import crypto from "crypto";
import type { Request, Response } from "express";
import { isDevEnv } from "./env.js";
import { macFor } from "./jwt.js";
import { readCookie, sessionCookieName } from "./sessionCookie.js";

/**
 * The signup cookie (#219, spec #69): verifying an email signs you in only in
 * the browser that signed up.
 *
 * Verify-email signs the person in (#215). Without this, that would make a
 * known attack worse: someone signs up with your email and a password of
 * theirs, you click the real verify link, and you're signed into the account
 * they control. So signing up (POST /api/users/register, POST /api/leads)
 * also sets this cookie, bound to the new account, and verify-email issues
 * the session only when the request carries it and it names the account
 * being verified. Anywhere else the link still verifies the email, and the
 * person signs in next.
 *
 * The value is `v1.<account id>.<expiry, unix seconds>.<mac>`, an HMAC under
 * the JWT secret (utils/jwt.ts `macFor`). It is deliberately not a JWT, so it
 * can't pass as a login anywhere that takes one.
 *
 * The cookie is:
 *   - named after the session cookie (`<SESSION_COOKIE_NAME>_signup`), and
 *     off with it: bearer-only backends set none, and verify signs nobody in;
 *   - HttpOnly, Secure outside development, SameSite=Lax;
 *   - on the host that signed up only (no Domain), and sent only to
 *     /api/users, where verify-email is: the verify link goes back to the
 *     site the signup came from (#215), so that's the host that needs it;
 *   - good for the day the verify email promises (VERIFY_SIGN_IN_WINDOW_S),
 *     and cleared once it has signed someone in.
 */

/** How long after signing up a verify link can also sign you in: the 24 hours the email promises. */
export const VERIFY_SIGN_IN_WINDOW_S = 24 * 60 * 60;

const PURPOSE = "signup-cookie:v1";
const PATH = "/api/users";

/** `<SESSION_COOKIE_NAME>_signup`, or null when the session cookie is off. */
export function signupCookieName(): string | null {
    const session = sessionCookieName();
    return session ? `${session}_signup` : null;
}

function cookieOptions() {
    return { httpOnly: true, secure: !isDevEnv(), sameSite: "lax" as const, path: PATH };
}

/** The cookie's value for this account, good until `expiresAtMs`. Exported for the tests. */
export function signupCookieValue(accountId: string, expiresAtMs: number): string {
    const data = `${accountId}.${Math.floor(expiresAtMs / 1000)}`;
    return `v1.${data}.${macFor(PURPOSE, data)}`;
}

/** Set the signup cookie for the account just created. No-op when the session cookie is off. */
export function setSignupCookie(res: Response, accountId: unknown): void {
    const name = signupCookieName();
    if (!name || !accountId) return;
    const value = signupCookieValue(String(accountId), Date.now() + VERIFY_SIGN_IN_WINDOW_S * 1000);
    res.cookie(name, value, { ...cookieOptions(), maxAge: VERIFY_SIGN_IN_WINDOW_S * 1000 });
}

/** Clear it on the same name and path it was set with. */
export function clearSignupCookie(res: Response): void {
    const name = signupCookieName();
    if (name) res.clearCookie(name, cookieOptions());
}

/**
 * True when this request carries a genuine, unexpired signup cookie for
 * `accountId`: the browser that signed that account up.
 */
export function signedUpHere(req: Pick<Request, "headers">, accountId: unknown): boolean {
    const name = signupCookieName();
    const raw = name ? readCookie(req, name) : null;
    if (!raw || !accountId) return false;
    const match = /^v1\.([^.]+)\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(raw);
    if (!match) return false;
    const [, id, exp, mac] = match;
    let genuine = false;
    try {
        const want = Buffer.from(macFor(PURPOSE, `${id}.${exp}`));
        const got = Buffer.from(mac);
        genuine = want.length === got.length && crypto.timingSafeEqual(want, got);
    } catch {
        return false;
    }
    return genuine && id === String(accountId) && Number(exp) * 1000 > Date.now();
}
