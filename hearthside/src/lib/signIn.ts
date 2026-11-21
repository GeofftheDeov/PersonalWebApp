import { RETURN_PARAM, safeReturnTo } from '@gtd/shared/session';

/**
 * Where Hearthside's signing-in pages send people (#219, spec #69). No React,
 * so the rules are tested on their own (test/sign-in.test.ts).
 *
 * - Login returns to `?redirect=`, a path on this site (`safeReturnTo`), and
 *   otherwise to the Hearth. A 401 anywhere (`session.expire()`), a gated page
 *   (`useRequiredSession`) and the top bar's Login all send people to
 *   `/login?redirect=<where they were>`.
 * - The links between the pages (login ↔ signup, login → forgot password)
 *   carry the return along (`withReturn`).
 * - Signing up is finished by a link in an email, often opened in a new tab,
 *   so the signup page keeps its return in localStorage (`rememberReturn`)
 *   and the verify page takes it (`takeReturn`). It's a path, never the
 *   session: the cookie is the only thing that says who's signed in.
 */

/** The signing-in pages, which are never somewhere to come back to. */
export const SIGN_IN_PATHS = ['/login', '/signup', '/check-email', '/verify-email', '/forgot-password', '/reset-password'] as const;

const HOME = '/';

/** `raw` if it's a path on this site worth returning to, else null. */
function returnPath(raw: string | null | undefined): string | null {
  const path = safeReturnTo(raw);
  if (!path) return null;
  const bare = path.split(/[?#]/)[0];
  return (SIGN_IN_PATHS as readonly string[]).includes(bare) ? null : path;
}

/** Where to go after signing in, from a page's query string: the `redirect` path, or the Hearth. */
export function returnTarget(search: string | URLSearchParams): string {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  return returnPath(params.get(RETURN_PARAM)) ?? HOME;
}

/** `path` (a signing-in page), carrying `target` along when there's somewhere to return to. */
export function withReturn(path: string, target: string | null | undefined): string {
  const back = returnPath(target);
  return back && back !== HOME ? `${path}?${RETURN_PARAM}=${encodeURIComponent(back)}` : path;
}

/** localStorage, or a stand-in for the tests. */
export interface ReturnStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const RETURN_AFTER_SIGNUP_KEY = 'hearthside.returnAfterSignup';

/** As long as a verify link can sign you in (the backend's VERIFY_SIGN_IN_WINDOW_S). */
const KEEP_MS = 24 * 60 * 60 * 1000;

/** The browser's localStorage, or null where there's none (a server render, storage refused). */
export function browserStorage(): ReturnStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Keep a signup's return until its email is verified. The Hearth needs no keeping. */
export function rememberReturn(storage: ReturnStorage | null, target: string, now = Date.now()): void {
  try {
    const path = returnPath(target);
    if (!storage) return;
    if (!path || path === HOME) storage.removeItem(RETURN_AFTER_SIGNUP_KEY);
    else storage.setItem(RETURN_AFTER_SIGNUP_KEY, JSON.stringify({ path, at: now }));
  } catch { /* no storage: the person lands on the Hearth instead */ }
}

/** The kept return, once (it's removed), if it's still within the day; else the Hearth. */
export function takeReturn(storage: ReturnStorage | null, now = Date.now()): string {
  if (!storage) return HOME;
  try {
    const raw = storage.getItem(RETURN_AFTER_SIGNUP_KEY);
    storage.removeItem(RETURN_AFTER_SIGNUP_KEY);
    if (!raw) return HOME;
    const kept = JSON.parse(raw) as { path?: unknown; at?: unknown };
    const fresh = typeof kept.at === 'number' && now - kept.at < KEEP_MS;
    return (fresh && typeof kept.path === 'string' && returnPath(kept.path)) || HOME;
  } catch {
    return HOME;
  }
}
