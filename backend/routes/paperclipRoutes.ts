import express, { Response, NextFunction } from 'express';
import { auth } from '../middleware/auth.js';
import Account from '../models/Account.js';
import { isUuid } from '../db/model.js';
import { personDisplayName } from '../utils/personUtils.js';
import { resolvePaperclipIdentity, setPaperclipIdentity } from '../services/paperclipIdentity.js';

const router = express.Router();

/**
 * Paperclip access (#35, plan §3.4).
 *
 * This was `req.user.type !== 'User'`, using the JWT's type as a proxy for
 * "staff". After the merge everyone is an account, so that test would have been
 * true for everybody and 403'd the entire site — including the one person who
 * uses Paperclip.
 *
 * Geoff's ruling: an admin of Paperclip may hold their access through EITHER
 * Salesforce or the web app, and both should get in. Until #36 that was
 * `app_role = 'admin'` OR a record from the Salesforce User object, which said
 * nothing about Paperclip. Phase 4 (#36, plan §4.6) replaced the Salesforce half
 * with what it stood in for: a linked Paperclip identity
 * (services/paperclipIdentity.ts), found by email in the company's member list,
 * however the person signs in. It is deliberately not `account_tier`: a tier is
 * what somebody has paid for and must never move their access (#28).
 */
async function requirePaperclipAccess(req: any, res: Response, next: NextFunction) {
  try {
    const person = await Account.findById(req.user?.id).select("appRole handle name firstName lastName");
    if (!person) return res.status(403).json({ error: 'Forbidden' });
    const identity = await resolvePaperclipIdentity(String(req.user.id));
    if (person.appRole !== 'admin' && !identity) {
      return res.status(403).json({ error: 'Forbidden: Paperclip access needs a Paperclip account with the same email, or an admin' });
    }
    req.paperclip = { person, identity };
    next();
  } catch (err) {
    next(err);
  }
}

router.use(auth, requirePaperclipAccess);

// PUT /api/paperclip/identity/:accountId  — admin only. body: { paperclipUserId: string | null, role? }
// For a member whose Paperclip email isn't their app email. Clearing a link
// sticks only while the emails differ: a match links them again.
router.put('/identity/:accountId', async (req: any, res: Response) => {
  if (req.paperclip.person.appRole !== 'admin') return res.status(403).json({ error: 'Admins only' });
  if (!isUuid(req.params.accountId)) return res.status(400).json({ error: 'accountId must be an account id' });
  const { paperclipUserId, role } = req.body ?? {};
  if (paperclipUserId !== null && (typeof paperclipUserId !== 'string' || !paperclipUserId.trim())) {
    return res.status(400).json({ error: 'paperclipUserId must be a Paperclip user id, or null to unlink' });
  }
  const userId = paperclipUserId === null ? null : paperclipUserId.trim();
  try {
    const found = await setPaperclipIdentity(req.params.accountId, userId, typeof role === 'string' ? role : null);
    if (!found) return res.status(404).json({ error: 'Account not found' });
    res.json({ accountId: req.params.accountId, paperclipUserId: userId });
  } catch (err: any) {
    if (err?.code === '23505') return res.status(409).json({ error: 'Another account is already linked to that Paperclip user' });
    console.error('[paperclip] setting an identity link failed:', err);
    res.status(500).json({ error: 'Failed to set the Paperclip link' });
  }
});

// ── Config ────────────────────────────────────────────────────────────────────
// Shared Paperclip client lives in services/paperclipClient.ts (also used by
// the admin portal). Paperclip runs as its own ECS service — see
// .aws/PAPERCLIP_SERVICE.md for deployment + env wiring.

import {
  pcFetch,
  paperclipConfigured,
  PAPERCLIP_COMPANY_ID,
} from '../services/paperclipClient.js';

// ── Guards ────────────────────────────────────────────────────────────────────

function requireBaseUrl(res: Response): boolean {
  if (!paperclipConfigured()) {
    res.status(503).json({
      error: 'Paperclip is not configured on this environment (PAPERCLIP_BASE_URL is unset)',
    });
    return false;
  }
  return true;
}

function requireCompanyId(res: Response): string | null {
  if (!requireBaseUrl(res)) return null;
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
  if (!requireBaseUrl(res)) return;
  const result = await pcFetch(`/api/agents/${req.params.id}`);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
});

// POST /api/paperclip/agents/:id/pause
router.post('/agents/:id/pause', async (req: any, res: Response) => {
  if (!requireBaseUrl(res)) return;
  const result = await pcFetch(`/api/agents/${req.params.id}/pause`, { method: 'POST' });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
});

// POST /api/paperclip/agents/:id/resume
router.post('/agents/:id/resume', async (req: any, res: Response) => {
  if (!requireBaseUrl(res)) return;
  const result = await pcFetch(`/api/agents/${req.params.id}/resume`, { method: 'POST' });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
});

// POST /api/paperclip/agents/:id/heartbeat  →  POST /api/agents/:id/heartbeat/invoke
router.post('/agents/:id/heartbeat', async (req: any, res: Response) => {
  if (!requireBaseUrl(res)) return;
  const result = await pcFetch(`/api/agents/${req.params.id}/heartbeat/invoke`, {
    method: 'POST',
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
});

// PATCH /api/paperclip/agents/:id/budget  →  PATCH /api/agents/:id/budgets
// (verified: the plain agent PATCH schema has no budgetMonthlyCents field —
// only the dedicated /budgets endpoint accepts it)
router.patch('/agents/:id/budget', async (req: any, res: Response) => {
  if (!requireBaseUrl(res)) return;
  const { budgetMonthlyCents } = req.body as { budgetMonthlyCents?: number };
  if (typeof budgetMonthlyCents !== 'number') {
    return res.status(400).json({ error: 'budgetMonthlyCents (number) is required' });
  }
  const result = await pcFetch(`/api/agents/${req.params.id}/budgets`, {
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

/**
 * Every ticket goes in under the one shared PAPERCLIP_API_KEY, so Paperclip
 * can't tell who filed it (#36). #29 found no on-behalf-of mechanism, so the
 * description says, with the account id in a comment for anything that needs
 * to look it up.
 */
export function withFiledBy(description: string | undefined, req: any): string {
  const person = req.paperclip?.person;
  const who = person?.handle ? `@${person.handle}` : personDisplayName(person);
  const footer = `_Filed by ${who} via PersonalWebApp_\n<!-- pwa-account:${req.user.id} -->`;
  return description?.trim() ? `${description.trimEnd()}\n\n${footer}` : footer;
}

// Verified upstream enum; Paperclip defaults to 'medium' when omitted.
const ISSUE_PRIORITIES = ['critical', 'high', 'medium', 'low'];

// POST /api/paperclip/issues  — body: { title, description?, assigneeAgentId?, priority? }
// (verified: with an assignee and no explicit status, Paperclip creates the
// issue as 'todo' and queues an assignment wakeup run for that agent)
router.post('/issues', async (req: any, res: Response) => {
  const cid = requireCompanyId(res);
  if (!cid) return;
  const { title, description, assigneeAgentId, priority } = req.body as {
    title?: string;
    description?: string;
    assigneeAgentId?: string;
    priority?: string;
  };
  if (!title?.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  if (priority !== undefined && !ISSUE_PRIORITIES.includes(priority)) {
    return res.status(400).json({ error: `priority must be one of ${ISSUE_PRIORITIES.join(', ')}` });
  }
  const result = await pcFetch(`/api/companies/${cid}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title, description: withFiledBy(description, req), assigneeAgentId, priority }),
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(201).json(result.data);
});

// GET /api/paperclip/issues/:id
router.get('/issues/:id', async (req: any, res: Response) => {
  if (!requireBaseUrl(res)) return;
  const result = await pcFetch(`/api/issues/${req.params.id}`);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
});

// GET /api/paperclip/issues/:id/runs
// (verified: newest-first array of { runId, status, agentId, createdAt, ... };
// includes the assignment wakeup run queued when the issue was created)
router.get('/issues/:id/runs', async (req: any, res: Response) => {
  if (!requireBaseUrl(res)) return;
  const result = await pcFetch(`/api/issues/${encodeURIComponent(req.params.id)}/runs`);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
});

// PATCH /api/paperclip/issues/:id
router.patch('/issues/:id', async (req: any, res: Response) => {
  if (!requireBaseUrl(res)) return;
  const result = await pcFetch(`/api/issues/${req.params.id}`, {
    method: 'PATCH',
    body: JSON.stringify(req.body),
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
});

// GET /api/paperclip/costs  →  /api/companies/:cid/costs/summary
// (verified: there is no bare /costs upstream; summary returns
// { companyId, spendCents, budgetCents, utilizationPercent })
router.get('/costs', async (req: any, res: Response) => {
  const cid = requireCompanyId(res);
  if (!cid) return;
  const result = await pcFetch(`/api/companies/${cid}/costs/summary`);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
});

// ── Run status + events (simple passthroughs) ─────────────────────────────────
// These replace the old SSE polling bridge. Clients poll these directly with a
// normal Authorization header. (EventSource can't send headers, so the old SSE
// route always got a 401 from the auth middleware — it was never reachable.)
// Upstream paths verified against the deployed instance (paperclipai
// 2026.707.0): runs live under /api/heartbeat-runs/{runId}; run.status is one
// of queued | scheduled_retry | running | succeeded | failed | cancelled |
// timed_out. Events return a BARE ARRAY of rows with a numeric monotonic
// `seq`; incremental polling uses ?afterSeq=<seq>&limit=<n>.

// GET /api/paperclip/runs/:runId
router.get('/runs/:runId', async (req: any, res: Response) => {
  if (!requireBaseUrl(res)) return;
  const result = await pcFetch(`/api/heartbeat-runs/${req.params.runId}`);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
});

// GET /api/paperclip/runs/:runId/events?afterSeq=<numeric seq cursor>
router.get('/runs/:runId/events', async (req: any, res: Response) => {
  if (!requireBaseUrl(res)) return;
  const afterSeq = Number(req.query.afterSeq ?? 0);
  const qs = Number.isFinite(afterSeq) && afterSeq > 0 ? `?afterSeq=${afterSeq}` : '';
  const result = await pcFetch(`/api/heartbeat-runs/${req.params.runId}/events${qs}`);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.data);
});

export default router;
