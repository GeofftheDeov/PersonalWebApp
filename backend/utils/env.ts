/**
 * True only when NODE_ENV is explicitly "development" (set by `npm run dev`
 * via nodemon.json). Anything else — including unset — is treated as prod.
 *
 * Never infer this from the Host header: in ECS the frontend proxies to the
 * backend at http://localhost:5000, so every prod request arrives with
 * `Host: localhost:5000`.
 *
 * A function, not a constant, because route modules are imported (ESM
 * hoisting) before server.ts calls dotenv.config().
 */
export const isDevEnv = () => process.env.NODE_ENV === "development";
