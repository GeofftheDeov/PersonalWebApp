import express, { Response, NextFunction } from 'express';
import { auth } from '../middleware/auth.js';

const router = express.Router();

// Paperclip is restricted to Users only — Leads and Accounts may not access it.
function userOnly(req: any, res: Response, next: NextFunction) {
  if (req.user?.type !== 'User') {
    return res.status(403).json({ error: 'Forbidden: Paperclip access requires a User account' });
  }
  next();
}

router.use(auth, userOnly);

// ── Config ────────────────────────────────────────────────────────────────────

const PAPERCLIP_BASE_URL = process.env.PAPERCLIP_BASE_URL ?? 'http://127.0.0.1:3100';
const PAPERCLIP_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID ?? '';
const PAPERCLIP_API_KEY = process.env.PAPERCLIP_API_KEY ?? '';

// Assumed endpoint paths — verify these against the running Paperclip instance.
// TODO: confirm /api/runs/{runId}/events?after={cursor} is the correct events polling path.
const RUN_EVENTS_PATH = (runId: string, after: string) =>
  `/api/runs/${runId}/events${after ? `?after=${encodeURIComponent(after)}` : ''}`;
// TODO: confirm /api/runs/{runId} returns a { status } field (completed/failed/cancelled).
const RUN_STATUS_PATH = (runId: string) => `/api/runs/${runId}`;

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const SSE_HEARTBEAT_MS = 15_000;
const SSE_POLL_MS = 2_000;
const SSE_TIMEOUT_MS = 10 * 60 * 1_000; // 10 minutes

const PROXY_ALLOWED_METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE']);

// ── Helper: typed upstream fetch ──────────────────────────────────────────────

interface PcResponse<T = unknown> {
  data?: T;
  error?: string;
  status: number;
}

async function pcFetch<T = unknown>(
  path: string,
  init?: RequestInit
): Promise<PcResponse<T>> {
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

// ── Guard: require PAPERCLIP_COMPANY_ID ──────────────────────────────────────

function requireCompanyId(res: Response): string | null {
  if (!PAPERCLIP_COMPANY_ID) {
    res.status(503).json({
      error: 'PAPERCLIP_COMPANY_ID is not configured on the server',
    });
    return null;
  }
  return PAPERCLIP_COMPANY_ID;
}

// ── Curated routes ────────────────────────────────────────────────────────────

// GET /api/paperclip/org
router.get('/org', async (req: any, res: Response) => {
  const cid = requireCompanyId(res);
  if (!cid) return;
  const result = await pcFetch(`/api/companies/${cid}/org`);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
});

// GET /api/paperclip/agents
router.get('/agents', async (req: any, res: Response) => {
  const cid = requireCompanyId(res);
  if (!cid) return;
  const result = await pcFetch(`/api/companies/${cid}/agents`);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
});

// GET /api/paperclip/agents/:id
router.get('/agents/:id', async (req: any, res: Response) => {
  const result = await pcFetch(`/api/agents/${req.params.id}`);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
});

// POST /api/paperclip/agents/:id/pause
router.post('/agents/:id/pause', async (req: any, res: Response) => {
  const result = await pcFetch(`/api/agents/${req.params.id}/pause`, { method: 'POST' });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
});

// POST /api/paperclip/agents/:id/resume
router.post('/agents/:id/resume', async (req: any, res: Response) => {
  const result = await pcFetch(`/api/agents/${req.params.id}/resume`, { method: 'POST' });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
});

// POST /api/paperclip/agents/:id/heartbeat  →  POST /api/agents/:id/heartbeat/invoke
router.post('/agents/:id/heartbeat', async (req: any, res: Response) => {
  const result = await pcFetch(`/api/agents/${req.params.id}/heartbeat/invoke`, {
    method: 'POST',
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
});

// PATCH /api/paperclip/agents/:id/budget  — body: { budgetMonthlyCents: number }
router.patch('/agents/:id/budget', async (req: any, res: Response) => {
  const { budgetMonthlyCents } = req.body as { budgetMonthlyCents?: number };
  if (typeof budgetMonthlyCents !== 'number') {
    return res.status(400).json({ error: 'budgetMonthlyCents (number) is required' });
  }
  const result = await pcFetch(`/api/agents/${req.params.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ budgetMonthlyCents }),
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
});

// GET /api/paperclip/issues
router.get('/issues', async (req: any, res: Response) => {
  const cid = requireCompanyId(res);
  if (!cid) return;
  const result = await pcFetch(`/api/companies/${cid}/issues`);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
});

// POST /api/paperclip/issues  — body: { title, description?, assigneeAgentId? }
router.post('/issues', async (req: any, res: Response) => {
  const cid = requireCompanyId(res);
  if (!cid) return;
  const { title, description, assigneeAgentId } = req.body as {
    title?: string;
    description?: string;
    assigneeAgentId?: string;
  };
  if (!title?.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  const result = await pcFetch(`/api/companies/${cid}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title, description, assigneeAgentId }),
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(201).json(result.data);
});

// GET /api/paperclip/issues/:id
router.get('/issues/:id', async (req: any, res: Response) => {
  const result = await pcFetch(`/api/issues/${req.params.id}`);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
});

// PATCH /api/paperclip/issues/:id
router.patch('/issues/:id', async (req: any, res: Response) => {
  const result = await pcFetch(`/api/issues/${req.params.id}`, {
    method: 'PATCH',
    body: JSON.stringify(req.body),
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
});

// GET /api/paperclip/costs
router.get('/costs', async (req: any, res: Response) => {
  const cid = requireCompanyId(res);
  if (!cid) return;
  const result = await pcFetch(`/api/companies/${cid}/costs`);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
});

// ── SSE run-events stream ─────────────────────────────────────────────────────

// GET /api/paperclip/runs/:runId/stream
// Polls the Paperclip run-events endpoint every 2 s and forwards new events
// as SSE `event: run_event` frames.  Ends with `event: done` when the run
// reaches a terminal status or after 10 minutes.
router.get('/runs/:runId/stream', async (req: any, res: Response) => {
  const { runId } = req.params as { runId: string };

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  (res as any).flushHeaders?.();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  console.log(`[paperclip] stream: opened for run ${runId}`);
  send('status', { text: 'Connected — waiting for run events…' });

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* socket closed */ }
  }, SSE_HEARTBEAT_MS);

  req.on('close', () => {
    console.log(`[paperclip] stream: req close event for run ${runId} (may be benign body-end)`);
  });

  let cursor = '';
  let done = false;

  const timeoutHandle = setTimeout(() => {
    console.log(`[paperclip] stream: timeout for run ${runId}`);
    try { send('error', { message: 'Stream timed out after 10 minutes' }); } catch { /* closed */ }
    done = true;
    cleanup();
  }, SSE_TIMEOUT_MS);

  function cleanup() {
    clearInterval(heartbeat);
    clearTimeout(timeoutHandle);
    try { res.end(); } catch { /* already ended */ }
  }

  try {
    while (!done) {
      // Poll for new events
      const eventsResult = await pcFetch<{ events?: unknown[]; items?: unknown[] }>(
        RUN_EVENTS_PATH(runId, cursor)
      );

      if (eventsResult.error) {
        send('error', { message: eventsResult.error });
        done = true;
        break;
      }

      // Accept either { events: [...] } or { items: [...] } shapes
      // TODO: confirm the exact response envelope shape from the Paperclip events endpoint.
      const rawEvents = eventsResult.data?.events ?? eventsResult.data?.items ?? [];
      const newEvents = Array.isArray(rawEvents) ? rawEvents : [];

      for (const evt of newEvents) {
        send('run_event', evt);
        // Advance cursor if events carry an id field
        if (typeof (evt as any)?.id === 'string') {
          cursor = (evt as any).id;
        }
      }

      // Check run terminal status
      const runResult = await pcFetch<{ status?: string }>( RUN_STATUS_PATH(runId) );

      if (runResult.error) {
        // Non-fatal: run status check may lag; continue polling
        console.warn(`[paperclip] stream: run status check failed for ${runId}: ${runResult.error}`);
      } else {
        const status = runResult.data?.status ?? '';
        if (TERMINAL_STATUSES.has(status)) {
          send('done', { runId, status });
          done = true;
          break;
        }
      }

      // Wait before next poll
      await new Promise<void>((resolve) => setTimeout(resolve, SSE_POLL_MS));
    }
  } catch (err: any) {
    console.error(`[paperclip] stream error for run ${runId}:`, err?.message, err?.stack);
    try { send('error', { message: err.message }); } catch { /* socket already closed */ }
  } finally {
    cleanup();
  }
});

// ── Generic proxy fallback ────────────────────────────────────────────────────

// ALL /api/paperclip/proxy/* → forwards to ${PAPERCLIP_BASE_URL}/api/*
// Allowed methods: GET, POST, PATCH, DELETE.
// The client's Authorization header is intentionally NOT forwarded upstream —
// the app's JWT is not a Paperclip credential.
router.all('/proxy/*path', async (req: any, res: Response) => {
  const method = req.method.toUpperCase();
  if (!PROXY_ALLOWED_METHODS.has(method)) {
    return res.status(405).json({ error: `Method ${method} not allowed via proxy` });
  }

  // Strip the leading "/proxy" to get the downstream path fragment, then prepend /api/
  const fragment = (req.params as any)['path'] as string; // everything after /proxy/
  const upstreamPath = `/api/${fragment}`;

  // Forward query string
  const qs = new URLSearchParams(req.query as Record<string, string>).toString();
  const fullPath = qs ? `${upstreamPath}?${qs}` : upstreamPath;

  const hasBody = method !== 'GET' && method !== 'DELETE' && req.body && Object.keys(req.body).length > 0;

  const result = await pcFetch(fullPath, {
    method,
    ...(hasBody ? { body: JSON.stringify(req.body) } : {}),
  });

  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(result.status).json(result.data);
});

export default router;
