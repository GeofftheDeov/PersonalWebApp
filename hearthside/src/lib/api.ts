import { createApiClient } from '@gtd/shared/api';
import { session } from './session';

/**
 * Hearthside's API client (#209): same-origin `/api`, which the app's
 * rewrites send to the shared backend (next.config.js). Every call sends the
 * CSRF header and lets the browser carry the session cookie, its only
 * credential (#210).
 *
 * A 401 means the session ended (or never began): the session client signs
 * out and sends the person to log in, coming back to where they were.
 */
export const api = createApiClient({
    onUnauthorized: () => session.expire(),
});

/**
 * A read that may fail quietly: the reply, or null if it failed. For pages
 * that show what they could load. A 401 still ends the session.
 */
export const getOrNull = <T,>(path: string): Promise<T | null> =>
    api.get<T>(path).catch(() => null);

/**
 * What to show for a failed call: the server's own `error` when it sent one,
 * else `fallback`.
 */
export { errorOf } from '@gtd/shared/api';
