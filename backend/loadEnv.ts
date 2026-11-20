/**
 * Loads backend/.env into process.env. server.ts imports this first (#245).
 *
 * ESM evaluates every `import` before the importing module's own code runs, so
 * a `dotenv.config()` call in server.ts's body ran after db/index.ts had
 * already built the pool from an unset DATABASE_URL. A module imported ahead
 * of the rest is evaluated ahead of them, so this one must stay first.
 *
 * Variables already in the environment win over .env (dotenv's default); in
 * ECS there is no .env and this does nothing.
 */
import dotenv from "dotenv";

dotenv.config();
