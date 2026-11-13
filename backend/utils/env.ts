/**
 * True only when NODE_ENV is explicitly "development" (set by `npm run dev`
 * via nodemon.json). Anything else — including unset — is treated as prod.
 *
 * Never infer this from the Host header: in ECS the frontend proxies to the
 * backend at http://localhost:5000, so every prod request arrives with
 * `Host: localhost:5000`.
 *
 * A function, not a constant, so it sees the environment as it is when
 * called, whichever module loaded .env (loadEnv.ts, or a script's own).
 */
export const isDevEnv = () => process.env.NODE_ENV === "development";
