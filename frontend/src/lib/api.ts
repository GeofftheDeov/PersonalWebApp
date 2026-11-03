import { createApiClient } from '@gtd/shared/api';

/**
 * The portfolio's API client (#209), from the package it shares with
 * Hearthside. Every call sends the CSRF header and lets the browser carry the
 * session cookie.
 *
 * It still sends the bearer token from localStorage, so nothing changes for a
 * signed-in user while that's where the token lives. The session client
 * (#210) drops `getToken` and leaves the cookie to authenticate.
 */
export const api = createApiClient({
    getToken: () => (typeof window !== 'undefined' ? localStorage.getItem('token') : null),
});
