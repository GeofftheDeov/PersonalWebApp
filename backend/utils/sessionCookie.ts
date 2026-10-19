import type { Request, Response } from "express";
import { isDevEnv } from "./env.js";

/**
 * The session cookie (#69, cross-site login).
 *
 * Login puts the same JWT it returns in the response body into an HttpOnly
 * cookie, so the portfolio and Hearthside, which sit on sibling subdomains and
 * proxy /api to this one backend, share one login. Bearer auth stays for the
 * Electron and React Native clients and the scripts.
 *
 * Every host (both environments, plus Paperclip) shares only the parent
 * domain, so both environments' cookies reach every host. Each environment
 * therefore uses its own cookie NAME and reads only that one:
 *   SESSION_COOKIE_NAME    gtd_session in prod, gtd_session_deov in dev.
 *                          Unset means the cookie is off: nothing is issued
 *                          and nothing is read, so auth is bearer-only.
 *   SESSION_COOKIE_DOMAIN  .geoffthedeov.net in the deployed environments.
 *                          Unset gives a host-only cookie, which is what
 *                          localhost needs.
 * Dev and prod also sign with different JWT secrets, so a cookie that crossed
 * over under the right name would still fail verification.
 *
 * Read per call, not at import, for the same reason as utils/jwt.ts: route
 * modules load before server.ts runs dotenv.config().
 */

/** Matches the token's own expiresIn ("1h") in userRoutes. */
const MAX_AGE_MS = 60 * 60 * 1000;

/**
 * The header a cookie-authenticated write must carry (CSRF). All the
 * subdomains count as the same site, so SameSite=Lax doesn't stop a page on
 * one of them (Paperclip, say) from posting as the user. A cross-origin page
 * can't set a custom header without a CORS preflight, and nothing here allows
 * credentials cross-origin.
 */
export const CSRF_HEADER = "x-requested-with";
export const CSRF_VALUE = "gtd";

export function sessionCookieName(): string | null {
    const name = process.env.SESSION_COOKIE_NAME?.trim();
    return name ? name : null;
}

function cookieOptions() {
    const domain = process.env.SESSION_COOKIE_DOMAIN?.trim();
    return {
        httpOnly: true,
        // Plain-http localhost under `npm run dev` would otherwise drop it in
        // browsers that don't exempt localhost.
        secure: !isDevEnv(),
        sameSite: "lax" as const,
        path: "/",
        ...(domain ? { domain } : {}),
    };
}

/** Issue the session cookie for a freshly signed token. No-op when the cookie is off. */
export function setSessionCookie(res: Response, token: string): void {
    const name = sessionCookieName();
    if (!name) return;
    res.cookie(name, token, { ...cookieOptions(), maxAge: MAX_AGE_MS });
}

/** Clear it on the same name, domain and path it was set with. */
export function clearSessionCookie(res: Response): void {
    const name = sessionCookieName();
    if (!name) return;
    res.clearCookie(name, cookieOptions());
}

/**
 * This environment's session token from the Cookie header, or null. Any other
 * cookie, including the other environment's session, is ignored.
 */
export function readSessionCookie(req: Pick<Request, "headers">): string | null {
    const name = sessionCookieName();
    const header = req.headers.cookie;
    if (!name || !header) return null;
    for (const part of header.split(";")) {
        const eq = part.indexOf("=");
        if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
        const raw = part.slice(eq + 1).trim();
        try {
            return decodeURIComponent(raw) || null;
        } catch {
            return null;
        }
    }
    return null;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** True when a cookie-authenticated request may proceed past the CSRF check. */
export function passesCsrfCheck(req: Pick<Request, "method" | "headers">): boolean {
    if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
    return req.headers[CSRF_HEADER] === CSRF_VALUE;
}

/**
 * The pages allowed to open the live channel with the session cookie (#107):
 *   SESSION_COOKIE_ORIGINS  comma-separated origins, e.g.
 *                           https://deov.geoffthedeov.net,https://deov.hearthside.geoffthedeov.net
 * A browser sends the cookie on a WebSocket upgrade from any page on the
 * parent domain, and an upgrade has no CORS preflight or custom header to lean
 * on, so the Origin header is the CSRF check here. Unset means no page may:
 * the cookie is ignored on upgrades and the first-frame token is the only way in.
 */
export function cookieOriginAllowed(origin: string | undefined): boolean {
    if (!origin) return false;
    const want = normalizeOrigin(origin);
    return (process.env.SESSION_COOKIE_ORIGINS ?? "")
        .split(",")
        .map(normalizeOrigin)
        .some((allowed) => allowed !== "" && allowed === want);
}

function normalizeOrigin(origin: string): string {
    return origin.trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * This environment's session token from a WebSocket upgrade, or null when the
 * cookie is off, absent, or came from a page not in SESSION_COOKIE_ORIGINS.
 */
export function readUpgradeSessionCookie(req: Pick<Request, "headers">): string | null {
    const token = readSessionCookie(req);
    if (!token) return null;
    const origin = req.headers.origin;
    if (!cookieOriginAllowed(origin)) {
        console.warn(`[live] session cookie ignored: origin ${origin ?? "(none)"} is not in SESSION_COOKIE_ORIGINS`);
        return null;
    }
    return token;
}
