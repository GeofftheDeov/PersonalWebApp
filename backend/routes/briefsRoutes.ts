import express from 'express';
import { renderPage } from '../utils/adminUi.js';
import { renderMarkdown } from '../utils/markdown.js';
import { listBriefs, readBrief, BRIEF_DATE, type BriefMeta } from '../utils/briefs.js';
import { pullVault, vaultSyncStatus } from '../services/vaultSync.js';
import { SKILLS, isSkill, enqueueRun, listRuns, runnerOnline, runnerLastSeen, type AgentRun } from '../services/agentRuns.js';

/**
 * /admin/briefs — the morning briefs from the vault's outputs/briefs/.
 *
 * Mounted inside adminRoutes after verifyToken + requireAdmin, so every route
 * here is admin-only. Read-only apart from "pull now", which only fast-forwards
 * the vault checkout.
 */
const router = express.Router();

const esc = (v: unknown) => String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const fmtTime = (iso: string | null) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? esc(iso)
        : d.toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' });
};

const statusPill = (s: string | null) => {
    const cls = s === 'ok' ? 'pill-ok' : s === 'partial' ? 'pill-partial' : 'pill-unknown';
    return `<span class="pill ${cls}">${esc(s ?? 'unknown')}</span>`;
};

const historyItem = (b: BriefMeta, selected: string | undefined, token: string) => `
    <a class="history-item ${b.date === selected ? 'active' : ''}" href="/admin/briefs?date=${b.date}&token=${encodeURIComponent(token)}">
        <span>${esc(b.date)}</span>${statusPill(b.status)}
    </a>`;

const runPill = (s: AgentRun['status']) => {
    const cls = s === 'succeeded' ? 'pill-ok' : s === 'failed' ? 'pill-partial' : 'pill-unknown';
    return `<span class="pill ${cls}">${esc(s)}</span>`;
};

function runsPanel(runs: AgentRun[] | null, runsError: string | null): string {
    const seen = runnerLastSeen();
    const status = runnerOnline()
        ? `<div><span class="dot dot-on"></span>runner online <span class="muted">(${esc(seen?.runner)})</span></div>`
        : `<div><span class="dot dot-off"></span>runner offline</div><div class="muted">last seen ${seen ? fmtTime(seen.at.toISOString()) : 'never (since boot)'}</div>`;
    const buttons = SKILLS.map(k =>
        `<button class="run-btn" data-skill="${esc(k.id)}" onclick="runSkill(this)" ${runsError ? 'disabled' : ''}>RUN ${esc(k.label.toUpperCase())}</button>`).join('');
    const list = runsError
        ? `<div class="err">${esc(runsError)}</div>`
        : (runs ?? []).map(r => `
            <div class="run-item" title="${esc(r.summary ?? '')}">
                <div class="run-row"><span>${esc(r.skill)}</span>${runPill(r.status)}</div>
                <div class="muted">${fmtTime(r.finished_at ?? r.claimed_at ?? r.requested_at)}${r.summary ? ' · ' + esc(r.summary) : ''}</div>
            </div>`).join('') || '<div class="muted">no runs yet</div>';
    return `
        <div class="side-header">RUN</div>
        <div class="runs">
            ${status}
            ${buttons}
            <div class="run-list">${list}</div>
        </div>`;
}

router.get('/', async (req, res) => {
    const token = String(req.query.token ?? '');
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
    const sync = vaultSyncStatus();

    // The queue lives in Postgres; if the migration hasn't been applied (or the
    // DB is down) the briefs still render and the RUN panel says why.
    let runs: AgentRun[] | null = null;
    let runsError: string | null = null;
    try { runs = await listRuns(6); }
    catch (err: any) {
        runsError = /agent_runs/.test(err.message) ? 'run queue unavailable: apply db/migrations/2026-09-26-agent-runs.sql' : 'run queue unavailable';
        console.error('[briefs] listRuns failed:', err.message);
    }
    const active = (runs ?? []).some(r => r.status === 'queued' || r.status === 'running');

    const history = vaultPath ? listBriefs(vaultPath, 30) : [];
    const requested = typeof req.query.date === 'string' && BRIEF_DATE.test(req.query.date) ? req.query.date : undefined;
    const date = requested ?? history[0]?.date;
    const brief = vaultPath && date ? readBrief(vaultPath, date) : null;

    let main: string;
    if (!vaultPath) {
        main = `<div class="empty">OBSIDIAN_VAULT_PATH is not configured on this service.</div>`;
    } else if (!brief) {
        main = requested
            ? `<div class="empty">No brief for ${esc(requested)}.</div>`
            : `<div class="empty">No briefs yet. The first appears after <code>/morning-brief</code> runs and Obsidian Git pushes <code>outputs/briefs/</code>.</div>`;
    } else {
        const failed = brief.failed.length
            ? `<div class="failed">Unavailable: ${brief.failed.map(f => `<span class="chip">${esc(f)}</span>`).join(' ')}</div>`
            : '';
        main = `
            <div class="brief-header">
                <div class="brief-title">MORNING BRIEF // ${esc(brief.date)} ${statusPill(brief.status)}</div>
                <div class="brief-meta">generated ${fmtTime(brief.generated)} · ${esc(brief.run ?? 'unknown')} run</div>
                ${failed}
            </div>
            <div class="markdown-body">${renderMarkdown(brief.body)}</div>`;
    }

    const content = `
        <div class="briefs-layout">
            <aside class="briefs-side">
                ${runsPanel(runs, runsError)}
                <div class="side-header">HISTORY</div>
                <div class="history">${history.map(b => historyItem(b, date, token)).join('') || '<div class="muted">none</div>'}</div>
                <div class="side-header">VAULT SYNC</div>
                <div class="sync">
                    <div>${sync.ok === null ? 'not pulled since boot' : sync.ok ? 'last pull ok' : 'last pull failed'}</div>
                    <div class="muted">${fmtTime(sync.at)}</div>
                    ${sync.ok === false ? `<div class="err">${esc(sync.message)}</div>` : ''}
                    <button id="pull-btn" onclick="pullNow()">PULL NOW</button>
                </div>
            </aside>
            <section class="briefs-main">${main}</section>
        </div>
        <script>
        const Q = '?token=' + encodeURIComponent(${JSON.stringify(token)});
        async function runSkill(btn) {
            btn.disabled = true; const label = btn.textContent; btn.textContent = 'QUEUING...';
            try {
                const r = await fetch('/admin/briefs/runs' + Q, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ skill: btn.dataset.skill }) });
                if (r.ok) { location.reload(); return; }
                btn.textContent = 'FAILED';
            } catch { btn.textContent = 'FAILED'; }
            setTimeout(() => { btn.disabled = false; btn.textContent = label; }, 3000);
        }
        // While a run is queued or running, refresh so its status updates.
        ${active ? 'setTimeout(() => location.reload(), 15000);' : ''}
        async function pullNow() {
            const btn = document.getElementById('pull-btn');
            btn.disabled = true; btn.textContent = 'PULLING...';
            try {
                const r = await fetch('/admin/briefs/pull' + Q, { method: 'POST' });
                const data = await r.json();
                if (data.ok) { location.reload(); return; }
                btn.textContent = 'FAILED';
            } catch { btn.textContent = 'FAILED'; }
            setTimeout(() => { btn.disabled = false; btn.textContent = 'PULL NOW'; }, 3000);
        }
        </script>`;

    const extraStyles = `
        /* The shared admin shell centres a 100vh flex body, which pushes anything
           taller than the viewport off the top. Like .vault-layout, pin this page to
           the viewport below the nav and scroll the panels instead. */
        .briefs-layout { display: grid; grid-template-columns: 220px 1fr; gap: 1.5rem; padding: 1.5rem; box-sizing: border-box;
            width: 100%; max-width: 1200px; height: calc(100vh - 60px); margin: 0 auto; position: relative; z-index: 95; }
        @media (max-width: 800px) {
            .briefs-layout { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); gap: 1rem; padding: 1rem; }
            .briefs-side { max-height: 30vh; }
        }
        .briefs-side { border: 1px solid #333; background: #1e1e1e; padding: 1rem; overflow-y: auto; min-height: 0; align-self: start; max-height: 100%; box-sizing: border-box; }
        .side-header { color: #0d9488; font-size: 0.7rem; letter-spacing: 2px; font-weight: bold; margin: 0.5rem 0; }
        .history { display: flex; flex-direction: column; gap: 0.25rem; margin-bottom: 1rem; }
        .history-item { display: flex; justify-content: space-between; align-items: center; color: #ccc; text-decoration: none; padding: 0.3rem 0.4rem; font-size: 0.8rem; }
        .history-item:hover, .history-item.active { background: #2b2b2b; color: #fff; }
        .sync { font-size: 0.8rem; display: flex; flex-direction: column; gap: 0.35rem; }
        .sync button { margin-top: 0.4rem; background: #0d9488; color: #000; border: none; padding: 0.45rem; font-family: inherit; font-weight: bold; letter-spacing: 1px; cursor: pointer; }
        .sync button:disabled { opacity: 0.6; cursor: default; }
        .muted { color: #666; font-size: 0.75rem; }
        .runs { font-size: 0.8rem; display: flex; flex-direction: column; gap: 0.4rem; margin-bottom: 1rem; }
        .run-btn { background: #f97316; color: #000; border: none; padding: 0.45rem; font-family: inherit; font-weight: bold; letter-spacing: 1px; cursor: pointer; }
        .run-btn:disabled { opacity: 0.6; cursor: default; }
        .run-list { display: flex; flex-direction: column; gap: 0.35rem; margin-top: 0.25rem; }
        .run-item { border-left: 2px solid #333; padding-left: 0.4rem; }
        .run-row { display: flex; justify-content: space-between; align-items: center; }
        .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 0.4rem; }
        .dot-on { background: #0d9488; } .dot-off { background: #555; }
        .err { color: #f97316; font-size: 0.75rem; word-break: break-word; }
        .briefs-main { border: 1px solid #333; background: #1e1e1e; padding: 1.5rem; min-width: 0; min-height: 0; overflow-y: auto; box-sizing: border-box; }
        .briefs-main::-webkit-scrollbar, .briefs-side::-webkit-scrollbar { width: 6px; }
        .briefs-main::-webkit-scrollbar-thumb, .briefs-side::-webkit-scrollbar-thumb { background: #333; }
        .brief-header { border-bottom: 1px solid #333; padding-bottom: 0.75rem; margin-bottom: 1rem; }
        .brief-title { color: #fff; font-weight: bold; letter-spacing: 2px; display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
        .brief-meta { color: #888; font-size: 0.75rem; margin-top: 0.35rem; }
        .failed { margin-top: 0.5rem; font-size: 0.75rem; color: #f97316; }
        .chip { display: inline-block; border: 1px solid #f97316; padding: 0 0.4rem; margin: 0.1rem; }
        .pill { font-size: 0.65rem; padding: 0.1rem 0.45rem; letter-spacing: 1px; text-transform: uppercase; }
        .pill-ok { background: #0d9488; color: #000; }
        .pill-partial { background: #f97316; color: #000; }
        .pill-unknown { background: #444; color: #ccc; }
        .empty { color: #888; padding: 2rem 0; text-align: center; }
        .markdown-body { line-height: 1.6; color: #ddd; overflow-wrap: anywhere; }
        .markdown-body h1, .markdown-body h2, .markdown-body h3 { color: #0d9488; margin: 1.2em 0 0.4em; }
        .markdown-body a { color: #f97316; }
        .markdown-body code { background: #2b2b2b; padding: 0.1em 0.3em; }
        .markdown-body blockquote { border-left: 3px solid #f97316; margin: 0.5em 0; padding: 0.2em 0.8em; color: #bbb; background: #262626; }
        .markdown-body table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
        .markdown-body th, .markdown-body td { border: 1px solid #333; padding: 0.4em 0.8em; text-align: left; }
        .markdown-body th { background: #262626; color: #0d9488; }
    `;

    res.send(renderPage({ token, title: 'Morning Briefs', activePage: 'briefs', content, extraStyles }));
});

router.post('/runs', async (req: any, res) => {
    const skill = req.body?.skill;
    if (!isSkill(skill)) return res.status(400).json({ error: 'unknown skill' });
    try {
        const { run, created } = await enqueueRun(skill, req.adminUser?.id ?? null);
        res.status(created ? 201 : 200).json({ run, created });
    } catch (err: any) {
        console.error('[briefs] enqueue failed:', err.message);
        res.status(500).json({ error: 'could not enqueue' });
    }
});

router.post('/pull', async (_req, res) => {
    const result = await pullVault();
    res.status(result.ok ? 200 : 502).json(result);
});

export default router;
