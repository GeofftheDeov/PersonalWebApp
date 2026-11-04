/**
 * The session client both frontends share (#210, spec #69): who is signed in,
 * logging in and out, and sending someone whose session has ended to log in
 * and back.
 *
 * The session cookie (#174) is the only thing that says somebody is signed in.
 * It's HttpOnly, so no script can read it; the client asks the backend instead
 * (`GET /api/users/profile` for the person, `GET /api/users/me/capabilities`
 * for what they may do) and keeps the answer in memory, never in storage. A
 * reload asks again, and the cookie answers. Because the cookie sits on the
 * parent domain, logging in or out on the portfolio does the same on
 * Hearthside.
 *
 * Login still returns the JWT in the response body for bearer clients
 * (scripts, the desktop and mobile apps). The session client drops it: the
 * cookie that came with the same response carries the session.
 *
 *   const session = createSessionClient();
 *   const api = createApiClient({ onUnauthorized: () => session.expire() });
 *
 *   session.getState()      // { status: 'loading' | 'signedOut' | 'signedIn', user, capabilities }
 *   session.subscribe(fn)   // fn runs on every change; returns the unsubscribe
 *   await session.ensure()  // asks the backend once, the first time it's needed
 *   await session.login(email, password)  // or loginWithGoogle(idToken)
 *   await session.logout()
 *   session.expire()        // a 401: signed out, then off to log in and back
 */
import { ApiError, createApiClient, type ApiClient } from "../api/client";

/** The signed-in person, as the profile read returns them. */
export interface SessionUser {
  id: string;
  email: string | null;
  /** A display name: `name`, else the first name, else "User" (as login's own user object). */
  name: string;
  firstName?: string | null;
  lastName?: string | null;
  handle: string | null;
  profilePicture: string | null;
  userNumber?: string | null;
  userDigit?: string | null;
  phone?: string | null;
  company?: string | null;
  industry?: string | null;
  website?: string | null;
  /** Everything else the profile read returns (bio, favourite games, Discord handle...). */
  [field: string]: unknown;
}

/**
 * What the signed-in person may do, from the server. For DISPLAY only:
 * deciding what to render. Every surface it gates is also gated server-side,
 * and that gate is the one that matters.
 */
export interface Capabilities {
  appRole: "user" | "admin" | null;
  accountTier: "free" | "member" | "patron" | null;
  recordType: string | null;
  handle: string | null;
  profilePicture: string | null;
  /** Admin, or linked to a Paperclip account (#36). */
  paperclip: boolean;
}

export type SessionState =
  /** Not asked yet, or asking. Render nothing that depends on who's signed in. */
  | { status: "loading"; user: null; capabilities: null }
  | { status: "signedOut"; user: null; capabilities: null }
  | { status: "signedIn"; user: SessionUser; capabilities: Capabilities };

export const LOADING: SessionState = Object.freeze({ status: "loading", user: null, capabilities: null });
export const SIGNED_OUT: SessionState = Object.freeze({ status: "signedOut", user: null, capabilities: null });

const NO_CAPABILITIES: Capabilities = {
  appRole: null, accountTier: null, recordType: null, handle: null, profilePicture: null, paperclip: false,
};

/** Admin portal, /db, and campaign-wide visibility. */
export const canAdmin = (c: Capabilities | null | undefined) => c?.appRole === "admin";

/**
 * Paperclip: admins, and anyone linked to a member of the Paperclip company
 * (#36). Never the tier: what somebody has paid for must not move their access.
 */
export const canPaperclip = (c: Capabilities | null | undefined) => c?.paperclip === true;

/** The query parameter the login page reads its return URL from. */
export const RETURN_PARAM = "redirect";

/**
 * A return URL that's safe to send someone to after login: a path on this
 * site, never another origin. Anything else is null.
 */
export function safeReturnTo(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  // One leading slash: "//evil.example" and "/\evil.example" are other origins
  // to a browser, and anything without the slash is a scheme or a relative path.
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return null;
  if (/[\u0000-\u001f]/.test(raw)) return null;
  return raw;
}

export interface SessionClientOptions {
  /** Prefixed to every API path. Default `""`: the page's own origin. */
  baseUrl?: string;
  /** Default: the global fetch, looked up per call. */
  fetch?: typeof fetch;
  /** The login page's path on this site. Default `/login`. */
  loginPath?: string;
  /** Where the browser is now, to come back to. Default: path, query and hash of `window.location`. */
  currentUrl?: () => string;
  /** How to go to the login page. Default: `window.location.assign`. */
  navigate?: (url: string) => void;
}

export interface SessionClient {
  getState(): SessionState;
  /** `listener` runs after every change. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Ask the backend who is signed in, now. A 401 means signed out (no redirect). */
  refresh(): Promise<SessionState>;
  /** Ask once: the first call refreshes, later ones share its answer. */
  ensure(): Promise<SessionState>;
  /**
   * Log in with a password. Resolves once the session is confirmed through
   * the cookie. A refusal rejects with the server's ApiError (`body` carries
   * e.g. `requiresReset`).
   */
  login(email: string, password: string): Promise<SessionUser>;
  /** Log in with a Google ID token, as `login`. */
  loginWithGoogle(idToken: string): Promise<SessionUser>;
  /** Clear the cookie on the backend (both sites), then the client's state. */
  logout(): Promise<void>;
  /**
   * The session ended (a 401 from any call): signed out, then off to the
   * login page with a return URL. Safe to call many times at once; it goes
   * once. Does nothing on the login page itself.
   */
  expire(): void;
  /** Off to the login page with a return URL (default: where the browser is now). */
  redirectToLogin(returnTo?: string): void;
  /** The login page's URL, returning to `returnTo` (default: where the browser is now). */
  loginUrl(returnTo?: string): string;
}

function browserUrl(): string {
  if (typeof window === "undefined") return "/";
  const { pathname, search, hash } = window.location;
  return `${pathname}${search}${hash}`;
}

/** The profile read's person, with the fields the client relies on filled in. */
function toUser(raw: Record<string, unknown>): SessionUser {
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    ...raw,
    id: String(raw.id ?? raw._id ?? ""),
    email: str(raw.email),
    name: str(raw.name) ?? str(raw.firstName) ?? "User",
    handle: str(raw.handle),
    profilePicture: str(raw.profilePicture),
  };
}

export function createSessionClient(options: SessionClientOptions = {}): SessionClient {
  // Its own API client, without the 401 hook: a 401 here means "signed out"
  // (on asking) or "wrong password" (on login), never "go and log in".
  const api: ApiClient = createApiClient({ baseUrl: options.baseUrl, fetch: options.fetch });
  const loginPath = options.loginPath ?? "/login";
  const currentUrl = options.currentUrl ?? browserUrl;
  const navigate = options.navigate ?? ((url: string) => { window.location.assign(url); });

  let state: SessionState = LOADING;
  const listeners = new Set<() => void>();
  let inflight: Promise<SessionState> | null = null;
  let asked = false;
  /** Bumped on every login, logout and expiry, so an older answer can't overwrite a newer one. */
  let generation = 0;
  let redirecting = false;

  function set(next: SessionState) {
    if (next === state) return;
    state = next;
    if (next.status === "signedIn") redirecting = false;
    for (const l of [...listeners]) {
      try { l(); } catch { /* one listener's failure isn't the session's */ }
    }
  }

  /** Who the cookie says is signed in. Throws on anything but a clean answer or a 401. */
  async function ask(): Promise<SessionState> {
    try {
      const [profile, caps] = await Promise.all([
        api.get<Record<string, unknown>>("/api/users/profile"),
        api.get<Partial<Capabilities>>("/api/users/me/capabilities"),
      ]);
      return { status: "signedIn", user: toUser(profile ?? {}), capabilities: { ...NO_CAPABILITIES, ...caps } };
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 404)) return SIGNED_OUT;
      throw err;
    }
  }

  function refresh(): Promise<SessionState> {
    asked = true;
    const gen = generation;
    const p = ask().then(
      (next) => {
        if (gen === generation) set(next);
        return state;
      },
      (err) => {
        // The backend couldn't say (offline, a 5xx). Keep what's known; a
        // first ask with no answer counts as signed out, so pages don't spin.
        if (gen === generation && state.status === "loading") set(SIGNED_OUT);
        throw err;
      },
    ).finally(() => { if (inflight === p) inflight = null; });
    inflight = p;
    return p;
  }

  function ensure(): Promise<SessionState> {
    if (inflight) return inflight;
    if (asked) return Promise.resolve(state);
    return refresh().catch(() => state);
  }

  async function establish(path: string, body: unknown): Promise<SessionUser> {
    const gen = ++generation;
    // The reply's token is for bearer clients; the cookie that came with it is ours.
    await api.post(path, body);
    if (gen !== generation) throw new Error("Signed in elsewhere in the meantime");
    const next = await ask();
    if (gen !== generation) throw new Error("Signed in elsewhere in the meantime");
    asked = true;
    set(next);
    if (next.status !== "signedIn") {
      throw new Error("Signed in, but no session cookie came back. Is SESSION_COOKIE_NAME set on the backend?");
    }
    return next.user;
  }

  function loginUrl(returnTo?: string): string {
    const back = safeReturnTo(returnTo ?? currentUrl());
    if (!back || back === loginPath || back.startsWith(`${loginPath}?`) || back.startsWith(`${loginPath}#`)) return loginPath;
    return `${loginPath}?${RETURN_PARAM}=${encodeURIComponent(back)}`;
  }

  function redirectToLogin(returnTo?: string) {
    const here = currentUrl();
    const onLogin = here === loginPath || here.startsWith(`${loginPath}?`) || here.startsWith(`${loginPath}#`);
    if (redirecting || onLogin) return;
    redirecting = true;
    navigate(loginUrl(returnTo));
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    refresh,
    ensure,
    login: (email, password) => establish("/api/users/login", { email, password }),
    loginWithGoogle: (idToken) => establish("/api/users/google-login", { idToken }),
    async logout() {
      generation++;
      asked = true;
      try {
        await api.post("/api/users/logout");
      } finally {
        // Signed out here whatever the backend said: the person asked to be.
        set(SIGNED_OUT);
      }
    },
    expire() {
      generation++;
      asked = true;
      set(SIGNED_OUT);
      redirectToLogin();
    },
    redirectToLogin,
    loginUrl,
  };
}
