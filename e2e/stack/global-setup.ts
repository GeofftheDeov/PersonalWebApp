/**
 * Starts the run's stack before any test and stops it after the last
 * (Playwright runs the function this returns as the global teardown).
 * The tests read the stack from E2E_STACK: Playwright starts its workers
 * after this, with this process's environment.
 */
import { startStack, STACK_ENV } from "./stack";

export default async function globalSetup() {
  const started = Date.now();
  const { stack, stop } = await startStack();
  process.env[STACK_ENV] = JSON.stringify(stack);
  console.log(`[e2e] stack up in ${((Date.now() - started) / 1000).toFixed(0)}s: ${stack.portfolio} · ${stack.hearthside} · logs ${stack.logs}`);
  return stop;
}
