import { ApiError, createApiClient } from '@gtd/shared/api';
import { session } from './session';

/**
 * The portfolio's API client (#209), from the package it shares with
 * Hearthside. Every call sends the CSRF header and lets the browser carry the
 * session cookie, which is the only credential the browser has (#210): no
 * bearer token, nothing in localStorage.
 *
 * A 401 means the session ended (or never began): the session client signs
 * out and sends the person to log in, coming back to where they were.
 */
export const api = createApiClient({
    onUnauthorized: () => session.expire(),
});

/**
 * What to show for a failed call: the server's own `error` when it sent one,
 * else `fallback` (a network failure's "Failed to fetch" is no help to anyone).
 */
export function errorOf(err: unknown, fallback: string): string {
    const said = err instanceof ApiError ? (err.body as { error?: unknown } | undefined)?.error : undefined;
    return typeof said === 'string' && said ? said : fallback;
}
