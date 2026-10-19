import express from 'express';
import crypto from 'crypto';
import { claimNext, completeRun, isSkill, isRecordedTrigger, recordFinishedRun, RECORDED_TRIGGERS } from '../services/agentRuns.js';
import { pullVault } from '../services/vaultSync.js';

/**
 * /api/runner — the machine-to-machine side of the skill-run queue, called by
 * scripts/runner.ps1 in the Obsidian vault on Geoff's PC.
 *
 * Auth is a shared secret, RUNNER_TOKEN, sent as `Authorization: Bearer …`.
 * It can claim and complete runs, and record runs that finished outside the
 * queue, and nothing else: what gets enqueued is decided by the admin page,
 * and what gets executed by the runner's own list.
 */
const router = express.Router();

const authenticateRunner = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const expected = process.env.RUNNER_TOKEN;
    if (!expected) return res.status(503).json({ error: 'RUNNER_TOKEN is not configured on the server.' });
    const header = req.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    if (!given || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Unauthorized' });
    return next();
};

router.use(authenticateRunner);

/** 200 with { run } when there is work, 204 when there is none. */
router.post('/claim', async (req, res) => {
    const runner = String(req.body?.runner ?? 'unknown').slice(0, 100);
    // Windows PowerShell 5.1 can serialize a one-element array as a bare string.
    const raw = req.body?.skills;
    const skills = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []).map(String).slice(0, 20);
    try {
        const run = await claimNext(runner, skills);
        if (!run) return res.status(204).end();
        res.json({ run: { id: run.id, skill: run.skill, requested_at: run.requested_at } });
    } catch (err: any) {
        console.error('[runner] claim failed:', err.message);
        res.status(500).json({ error: 'claim failed' });
    }
});

/**
 * Record a run that already finished outside the queue (#138): a scheduled
 * (Task Scheduler) or manual (terminal) wrapper run, posted once afterwards.
 * Body `{ skill, trigger, ok, runner?, startedAt?, summary?, outputPath?, usage? }`.
 * 400 unless `skill` is runnable and `trigger` is `scheduled` or `manual`;
 * everything else is best effort (see recordFinishedRun). 201 with { run }.
 */
router.post('/runs', async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (!isSkill(body.skill)) return res.status(400).json({ error: 'unknown skill' });
    if (!isRecordedTrigger(body.trigger)) {
        return res.status(400).json({ error: `trigger must be one of ${RECORDED_TRIGGERS.join(', ')} (button runs go through the queue)` });
    }
    try {
        const run = await recordFinishedRun({
            skill: body.skill,
            trigger: body.trigger,
            ok: body.ok === true,
            runner: typeof body.runner === 'string' ? body.runner : undefined,
            startedAt: body.startedAt,
            summary: typeof body.summary === 'string' ? body.summary : undefined,
            outputPath: typeof body.outputPath === 'string' ? body.outputPath : undefined,
            usage: body.usage,
        });
        // As on complete: the run's output may already be on its way through the vault.
        void pullVault();
        res.status(201).json({ run });
    } catch (err: any) {
        console.error('[runner] record failed:', err.message,
            err.code === '42703' ? '(apply db/migrations/2026-10-12-agent-run-usage.sql)' : '');
        res.status(500).json({ error: 'record failed' });
    }
});

router.post('/runs/:id/complete', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad run id' });
    try {
        const run = await completeRun(id, {
            ok: req.body?.ok === true,
            summary: typeof req.body?.summary === 'string' ? req.body.summary : undefined,
            outputPath: typeof req.body?.outputPath === 'string' ? req.body.outputPath : undefined,
            // Optional { costUsd, inputTokens, outputTokens, durationMs } (#137). Bad
            // fields are stored as null, never a 4xx: the vault's runner lags the server.
            usage: req.body?.usage,
        });
        if (!run) return res.status(409).json({ error: 'run is not running (unknown, already completed, or expired)' });
        // The output travels through the vault; Obsidian Git may not have pushed
        // yet, but an early pull is cheap and often catches it.
        void pullVault();
        res.json({ run });
    } catch (err: any) {
        // 42703 = undefined column: the code deployed ahead of its migration.
        console.error('[runner] complete failed:', err.message,
            err.code === '42703' ? '(apply db/migrations/2026-10-12-agent-run-usage.sql)' : '');
        res.status(500).json({ error: 'complete failed' });
    }
});

export default router;
