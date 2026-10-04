/**
 * Side-effect import for the test scripts: give the process a JWT secret (#95).
 *
 * utils/jwt.ts has no default, so a script that mints or verifies tokens needs
 * one. A secret already in the environment is kept; otherwise each run gets a
 * fresh random one, which is all a test needs, since every token it makes is
 * signed and verified inside this one process. Import it first, before the
 * route modules:
 *   import "./use-test-jwt-secret.js";
 */
import crypto from "crypto";

process.env.JWT_SECRET ||= `test-${crypto.randomBytes(32).toString("hex")}`;
