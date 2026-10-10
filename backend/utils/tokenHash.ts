import crypto from "crypto";

/**
 * One-time tokens (password reset, email verification) are stored as their
 * SHA-256 and redeemed by hashing what the user submits. The raw token leaves
 * only in the email, so a read of an accounts row yields nothing redeemable.
 *
 * Plain SHA-256, no salt or work factor: the tokens are 160 random bits, not
 * guessable passwords, so there is no dictionary for a slow hash to defend.
 */
export const hashToken = (token: string): string =>
    crypto.createHash("sha256").update(token).digest("hex");
