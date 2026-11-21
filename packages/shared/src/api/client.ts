/**
 * The API client both frontends share (#209, spec #69): typed fetch wrappers
 * over the one backend, which each Next app reaches same-origin through its
 * `/api` rewrite.
 *
 * Every request carries `X-Requested-With: gtd`. The backend refuses a
 * cookie-authenticated request that changes data without it (CSRF; see
 * backend/utils/sessionCookie.ts), because SameSite=Lax can't tell the
 * portfolio, Hearthside and Paperclip apart: they're all one site. A page on
 * another origin can't add a custom header without a CORS preflight the
 * backend never grants, so the header is proof the request came from our own
 * code. Sending it on reads too keeps the rule simple and costs nothing.
 *
 * Requests go with `credentials: 'same-origin'`, so the browser carries the
 * HttpOnly session cookie and the client never touches the token itself. The
 * browser apps authenticate that way only (#210; the session client in
 * `@gtd/shared/session` knows who's signed in). Bearer clients (scripts, and
 * the desktop and mobile apps to come) pass a token instead (`getToken`, or
 * `token` per call); the backend then authenticates by the bearer and ignores
 * any cookie.
 */

export const CSRF_HEADER = "X-Requested-With";
export const CSRF_VALUE = "gtd";

/** A non-2xx reply. `message` is the server's `error` when it sent one. */
export class ApiError extends Error {
  readonly status: number;
  /** The parsed JSON reply, or the raw text when it wasn't JSON. */
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * What to show for a failed call: the server's own `error` when it sent one,
 * else `fallback` (a network failure's "Failed to fetch" is no help to anyone).
 */
export function errorOf(err: unknown, fallback: string): string {
  const said = err instanceof ApiError ? (err.body as { error?: unknown } | undefined)?.error : undefined;
  return typeof said === "string" && said ? said : fallback;
}

export interface ApiRequestOptions {
  method?: string;
  /**
   * A plain value goes as JSON. FormData, Blob, URLSearchParams, ArrayBuffer
   * and strings go as they are, with whatever content type fetch gives them.
   */
  body?: unknown;
  headers?: HeadersInit;
  signal?: AbortSignal;
  /**
   * A bearer token for this call, over the client's `getToken`. `null` sends
   * none. For bearer clients; the browser apps use the cookie.
   */
  token?: string | null;
}

export type ApiCallOptions = Omit<ApiRequestOptions, "method" | "body">;

export interface ApiClientOptions {
  /** Prefixed to every path. Default `""`: the page's own origin. */
  baseUrl?: string;
  /** Default: the global fetch, looked up per call. */
  fetch?: typeof fetch;
  /**
   * Where a bearer token comes from, if anywhere. For bearer clients (scripts,
   * desktop and mobile apps); the browser apps leave it unset and let the
   * session cookie authenticate.
   */
  getToken?: () => string | null | undefined;
  /**
   * Called with the error when a reply is 401, before it's thrown: the
   * session has expired or never existed. The browser apps point it at the
   * session client's `expire`, which sends the person to log in and back.
   */
  onUnauthorized?: (error: ApiError) => void;
}

export interface ApiClient {
  request<T = unknown>(path: string, options?: ApiRequestOptions): Promise<T>;
  get<T = unknown>(path: string, options?: ApiCallOptions): Promise<T>;
  post<T = unknown>(path: string, body?: unknown, options?: ApiCallOptions): Promise<T>;
  put<T = unknown>(path: string, body?: unknown, options?: ApiCallOptions): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown, options?: ApiCallOptions): Promise<T>;
  delete<T = unknown>(path: string, options?: ApiCallOptions): Promise<T>;
}

/** Bodies fetch already knows how to send. Anything else is JSON. */
function isRawBody(body: unknown): body is BodyInit {
  return typeof body === "string"
    || (typeof FormData !== "undefined" && body instanceof FormData)
    || (typeof Blob !== "undefined" && body instanceof Blob)
    || (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams)
    || (typeof ArrayBuffer !== "undefined" && (body instanceof ArrayBuffer || ArrayBuffer.isView(body)))
    || (typeof ReadableStream !== "undefined" && body instanceof ReadableStream);
}

/** The reply as JSON, the raw text if it isn't JSON, or undefined if it's empty. */
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(body: unknown, status: number): string {
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  return typeof error === "string" && error ? error : `Request failed (${status})`;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? "";

  async function request<T>(path: string, init: ApiRequestOptions = {}): Promise<T> {
    const headers = new Headers(init.headers);
    // Set last, so nothing a caller passes can drop or change it.
    headers.set(CSRF_HEADER, CSRF_VALUE);

    const token = init.token !== undefined ? init.token : options.getToken?.();
    if (token) headers.set("Authorization", `Bearer ${token}`);

    let body: BodyInit | undefined;
    if (init.body !== undefined) {
      if (isRawBody(init.body)) {
        body = init.body;
      } else {
        body = JSON.stringify(init.body);
        if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
      }
    }

    const doFetch = options.fetch ?? fetch;
    const res = await doFetch(`${baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers,
      body,
      credentials: "same-origin",
      signal: init.signal,
    });
    const parsed = await readBody(res);
    if (!res.ok) {
      const error = new ApiError(errorMessage(parsed, res.status), res.status, parsed);
      if (res.status === 401) options.onUnauthorized?.(error);
      throw error;
    }
    return parsed as T;
  }

  return {
    request,
    get: (path, o) => request(path, { ...o, method: "GET" }),
    post: (path, body, o) => request(path, { ...o, method: "POST", body }),
    put: (path, body, o) => request(path, { ...o, method: "PUT", body }),
    patch: (path, body, o) => request(path, { ...o, method: "PATCH", body }),
    delete: (path, o) => request(path, { ...o, method: "DELETE" }),
  };
}
