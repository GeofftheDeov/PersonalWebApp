// Shared client for the Paperclip control plane.
// Paperclip runs as its own ECS service (see .aws/PAPERCLIP_SERVICE.md).
// There is intentionally NO localhost fallback — if PAPERCLIP_BASE_URL is
// unset, callers should surface an explicit "not configured" error instead
// of dialing a port that has nothing behind it.

export const PAPERCLIP_BASE_URL = process.env.PAPERCLIP_BASE_URL ?? '';
export const PAPERCLIP_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID ?? '';
const PAPERCLIP_API_KEY = process.env.PAPERCLIP_API_KEY ?? '';

export const paperclipConfigured = (): boolean => Boolean(PAPERCLIP_BASE_URL);

export interface PcResponse<T = unknown> {
  data?: T;
  error?: string;
  status: number;
}

export async function pcFetch<T = unknown>(
  path: string,
  init?: RequestInit
): Promise<PcResponse<T>> {
  if (!PAPERCLIP_BASE_URL) {
    return {
      error: 'Paperclip is not configured on this environment (PAPERCLIP_BASE_URL is unset)',
      status: 503,
    };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (PAPERCLIP_API_KEY) {
    headers['Authorization'] = `Bearer ${PAPERCLIP_API_KEY}`;
  }

  let res: globalThis.Response;
  try {
    res = await fetch(`${PAPERCLIP_BASE_URL}${path}`, { ...init, headers });
  } catch (err: any) {
    return { error: `Paperclip unreachable: ${err.message}`, status: 502 };
  }

  let body: unknown;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  if (!res.ok) {
    const msg =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as any).error)
        : `Upstream ${res.status}`;
    return { error: msg, status: res.status };
  }

  return { data: body as T, status: res.status };
}
