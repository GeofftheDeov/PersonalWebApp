import crypto from "crypto";
import jwt, { type JwtPayload, type SignOptions } from "jsonwebtoken";

/**
 * The one JWT secret (#95). Every place that signs or verifies one of our
 * tokens goes through here: REST auth, the /admin and /db portals, the SSE
 * streams, the Google Calendar OAuth state, the helper and test scripts, and
 * the live channel (#98) after them. Nothing else reads JWT_SECRET.
 *
 * There is no default. Each route used to fall back to a string that is
 * published in this repo, so a process started without the variable accepted
 * tokens anybody could mint. server.ts refuses to boot in that state, in every
 * environment, and if the variable still goes missing at runtime, signJwt and
 * verifyJwt throw: callers already treat a throw as "invalid token", so that
 * fails closed.
 *
 * The secret is read per call, not at import. server.ts loads .env first
 * (loadEnv.ts, #245), but scripts and tests import this module on their own
 * and may set the variable after it loads.
 */

/** Values that mean "nobody set this": the old fallback and the old example-file placeholder. */
const INSECURE_SECRETS: readonly string[] = ["your-secret-key-change-this", "your-super-secret-jwt-key"];

/** Why `value` cannot be the JWT secret, or null when it can. */
export function jwtSecretProblem(value: string | undefined): string | null {
    if (!value || !value.trim()) {
        return "JWT_SECRET is not set. The backend signs and verifies every login token with it and has no default.";
    }
    if (INSECURE_SECRETS.includes(value.trim())) {
        return "JWT_SECRET is set to an insecure placeholder that is published in this repo.";
    }
    return null;
}

/** How to fix it, for the boot error. */
export const JWT_SECRET_HELP =
    "Set JWT_SECRET to a long random string (in backend/.env for local dev). Generate one with:\n" +
    "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"";

/** Throws with a message fit for the boot log when the secret is unusable. */
export function assertJwtSecretConfigured(): void {
    const problem = jwtSecretProblem(process.env.JWT_SECRET);
    if (problem) throw new Error(`${problem}\n${JWT_SECRET_HELP}`);
}

function secret(): string {
    assertJwtSecretConfigured();
    return process.env.JWT_SECRET as string;
}

/**
 * The claim that marks a token issued for the session cookie (#212, spec #69
 * story 10). The cookie reaches every host on the parent domain, Paperclip
 * included, so its token must be good for nothing but the cookie: replayed as
 * `Authorization: Bearer`, it would also skip the CSRF check. setSessionCookie
 * is the only place that adds it; the token in a login response body, for
 * bearer clients, never carries it.
 */
export const COOKIE_TOKEN_CLAIM = "cookie";

/** Sign a token with the configured secret (HS256). */
export function signJwt(payload: object, options?: SignOptions): string {
    return jwt.sign(payload, secret(), options);
}

/**
 * What a token is for (#240). Every kind of token is signed with the one
 * secret, so the signature alone can't tell them apart: a Google Calendar
 * OAuth state, which travels through Google's redirect URL, used to open every
 * door a login does. A login (session) token carries no `purpose` claim; every
 * other kind names its own, and each verifier asks for the kind it expects.
 *
 *   - "session": login tokens (bearer, `?token=` on /admin and /db, the live
 *     channel, the session cookie). The default.
 *   - "gcal-connect": the Google Calendar OAuth `state`, good for /callback only.
 *   - "account-sync": the Salesforce batch token (scripts/generateJWT.ts), good
 *     for /api/accounts only.
 */
export type TokenPurpose = "session" | "gcal-connect" | "account-sync";

/** The kind of token `decoded` is: its `purpose` claim, or "session" when it has none. */
export function tokenPurpose(decoded: JwtPayload): string {
    return decoded.purpose === undefined ? "session" : String(decoded.purpose);
}

/**
 * Verify a token against the configured secret. Throws when the token is
 * malformed, expired, signed with anything else, or the secret is unusable,
 * and when it is not for `purpose` (one kind, or any of a list). Without
 * `purpose` only a session token passes, so a caller that forgets to ask still
 * refuses the other kinds (#240).
 *
 * Also throws on a session-cookie token (one carrying COOKIE_TOKEN_CLAIM)
 * unless `fromCookie` says the caller read it from the session cookie. So
 * every other way in (bearer header, `?token=`, the live channel's first
 * frame) refuses it without having to remember to (#212).
 */
export function verifyJwt(
    token: string,
    { purpose = "session", fromCookie = false }: { purpose?: TokenPurpose | readonly TokenPurpose[]; fromCookie?: boolean } = {},
): JwtPayload {
    const decoded = jwt.verify(token, secret(), { algorithms: ["HS256"] });
    if (typeof decoded === "string") throw new Error("Token payload is not an object");
    const allowed: readonly string[] = typeof purpose === "string" ? [purpose] : purpose;
    const actual = tokenPurpose(decoded);
    if (!allowed.includes(actual)) {
        throw new Error(`A ${actual} token is not accepted here (wants ${allowed.join(" or ")})`);
    }
    if (!fromCookie && COOKIE_TOKEN_CLAIM in decoded) {
        throw new Error("A session-cookie token is only accepted from the session cookie");
    }
    return decoded;
}

/**
 * An HMAC-SHA256 of `data` under the same secret (base64url), kept apart from
 * every other use of it by `purpose`. For a signed value that must never pass
 * as a login token: it isn't a JWT, so verifyJwt, and everything behind it,
 * refuses it. The signup cookie (utils/signupCookie.ts, #219) is one.
 */
export function macFor(purpose: string, data: string): string {
    return crypto.createHmac("sha256", secret()).update(`${purpose}\n${data}`).digest("base64url");
}
