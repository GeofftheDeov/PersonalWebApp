import express from 'express';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { pullVault, vaultSyncStatus } from '../services/vaultSync.js';
import {
    watchWallet, resyncWallet, alpacaRest, restBase, AlpacaError, WALLET_IDS,
    type AlpacaCreds, type WalletId,
} from '../services/alpacaStream.js';
import { renderPage } from '../utils/adminUi.js';
import { renderMarkdown } from '../utils/markdown.js';
import AlpacaSnapshot from '../models/AlpacaSnapshot.js';
import { getDecryptedKeys } from './apiKeyRoutes.js';
import { evaluateLiveApplyGate } from '../utils/liveApplyGate.js';
import { pcFetch, paperclipConfigured, PAPERCLIP_COMPANY_ID } from '../services/paperclipClient.js';

const router = express.Router();

// Middleware to verify token in query param - consistent with dbRoutes
// Also attaches decoded userId to req.adminUser so personal-key routes can
// look up vault entries for the requesting admin.
const verifyToken = (req: any, res: express.Response, next: express.NextFunction) => {
    const token = req.query.token as string;
    const loginUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/login`;

    if (!token) {
        console.log(`[AUTH] 401: No token provided for ${req.originalUrl}`);
        return res.redirect('/login');
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || "your-secret-key-change-this") as any;
        req.adminUser = { id: decoded.id, email: decoded.email };
        next();
    } catch (err: any) {
        console.log(`[AUTH] 401: Invalid token for ${req.originalUrl}. Error: ${err.message}`);
        return res.redirect(loginUrl);
    }
};

router.use(verifyToken);

// ── Obsidian vault helpers ────────────────────────────────────────────────────

const VAULT_EXCLUDED = new Set(['.git', 'private', 'node_modules']);

interface VaultNode { name: string; type: 'file' | 'dir'; path: string; children?: VaultNode[]; }

function buildVaultTree(dir: string, base: string = ''): VaultNode[] {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    const nodes: VaultNode[] = [];
    for (const e of entries) {
        if (e.name.startsWith('.') || VAULT_EXCLUDED.has(e.name)) continue;
        const full = path.join(dir, e.name);
        const rel = (base ? base + '/' : '') + e.name;
        if (e.isDirectory()) {
            nodes.push({ name: e.name, type: 'dir', path: rel, children: buildVaultTree(full, rel) });
        } else if (e.name.endsWith('.md')) {
            nodes.push({ name: e.name, type: 'file', path: rel });
        }
    }
    return nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
}

function safeVaultRead(vaultPath: string, relativePath: string): string | null {
    const full = path.resolve(vaultPath, relativePath);
    if (!full.startsWith(path.resolve(vaultPath))) return null;
    try { return fs.readFileSync(full, 'utf-8'); } catch { return null; }
}

router.get('/', (req, res) => {
    const token = req.query.token as string;
    
    const content = `
        <div class="admin-panel">
            <h1>Admin Command</h1>
            <div class="nav-grid">
                <a href="/db?token=${token}" class="nav-btn">
                    Manage Database
                </a>
                <a href="/admin/cloud-claw?token=${token}" class="nav-btn">
                    Cloud-Claw Trading Agent
                </a>
                <a href="/admin/obsidian?token=${token}" class="nav-btn">
                    Obsidian Vault
                </a>
                <a href="/admin/alpaca?token=${token}" class="nav-btn">
                    Alpaca Dashboard
                </a>
                <a href="/admin/profile?token=${token}" class="nav-btn">
                    Profile &amp; API Keys
                </a>
                <button class="nav-btn nav-btn-action" onclick="openNewProfileModal()">
                    + Add API Key Profile
                </button>
            </div>
            <div class="status">
                SYSTEM STATUS: ONLINE // AUTH: SECURE
            </div>
        </div>

        <!-- Add Profile Modal -->
        <div id="new-profile-modal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.8); z-index:200; align-items:center; justify-content:center;">
            <div style="background:#1e1e1e; border:2px solid #444; width:90%; max-width:480px; font-family:'Courier New',monospace;">
                <div style="display:flex; justify-content:space-between; align-items:center; padding:1rem 1.25rem; border-bottom:1px solid #333; color:#0d9488; font-size:0.85rem; font-weight:bold; letter-spacing:2px;">
                    <span>ADD API KEY PROFILE</span>
                    <button onclick="closeNewProfileModal()" style="background:transparent;border:none;color:#666;font-size:1.1rem;cursor:pointer;">&#10005;</button>
                </div>
                <div style="padding:1.25rem; display:flex; flex-direction:column; gap:1rem;">
                    <div style="display:flex;flex-direction:column;gap:0.35rem;">
                        <label style="font-size:0.65rem;letter-spacing:2px;color:#555;">PROVIDER</label>
                        <select id="np-provider" style="background:#2b2b2b;border:1px solid #444;color:#e0e0e0;padding:0.5rem 0.75rem;font-family:inherit;font-size:0.85rem;outline:none;">
                            <option value="alpaca_live">Alpaca — Live Account</option>
                            <option value="alpaca_paper">Alpaca — Paper Account</option>
                            <option value="google">Google OAuth</option>
                            <option value="discord">Discord OAuth</option>
                        </select>
                    </div>
                    <div style="display:flex;flex-direction:column;gap:0.35rem;">
                        <label style="font-size:0.65rem;letter-spacing:2px;color:#555;">LABEL (optional)</label>
                        <input id="np-label" type="text" placeholder="e.g. My Live Alpaca" autocomplete="off"
                            style="background:#2b2b2b;border:1px solid #444;color:#e0e0e0;padding:0.5rem 0.75rem;font-family:inherit;font-size:0.85rem;outline:none;" />
                    </div>
                    <div style="display:flex;flex-direction:column;gap:0.35rem;">
                        <label style="font-size:0.65rem;letter-spacing:2px;color:#555;">KEY ID / CLIENT ID</label>
                        <input id="np-keyid" type="text" placeholder="Paste key ID here" autocomplete="off"
                            style="background:#2b2b2b;border:1px solid #444;color:#e0e0e0;padding:0.5rem 0.75rem;font-family:inherit;font-size:0.85rem;outline:none;" />
                    </div>
                    <div style="display:flex;flex-direction:column;gap:0.35rem;">
                        <label style="font-size:0.65rem;letter-spacing:2px;color:#555;">SECRET KEY</label>
                        <input id="np-secret" type="password" placeholder="Paste secret here" autocomplete="off"
                            style="background:#2b2b2b;border:1px solid #444;color:#e0e0e0;padding:0.5rem 0.75rem;font-family:inherit;font-size:0.85rem;outline:none;" />
                    </div>
                    <div id="np-status" style="font-size:0.8rem;min-height:1.2em;"></div>
                </div>
                <div style="display:flex;justify-content:flex-end;gap:0.75rem;padding:0.75rem 1.25rem;border-top:1px solid #333;">
                    <button onclick="closeNewProfileModal()" style="background:transparent;border:1px solid #444;color:#888;padding:0.5rem 1.25rem;font-family:inherit;font-size:0.75rem;letter-spacing:1px;cursor:pointer;">CANCEL</button>
                    <button onclick="saveNewProfile()" style="background:#0d9488;border:none;color:#000;padding:0.5rem 1.5rem;font-family:inherit;font-size:0.75rem;font-weight:bold;letter-spacing:1px;cursor:pointer;">SAVE</button>
                </div>
            </div>
        </div>

        <script>
        const TOKEN = '${token}';

        function openNewProfileModal() {
            const m = document.getElementById('new-profile-modal');
            m.style.display = 'flex';
            document.getElementById('np-keyid').value = '';
            document.getElementById('np-secret').value = '';
            document.getElementById('np-label').value = '';
            document.getElementById('np-status').textContent = '';
            document.getElementById('np-status').style.color = '';
        }

        function closeNewProfileModal() {
            document.getElementById('new-profile-modal').style.display = 'none';
        }

        async function saveNewProfile() {
            const provider = document.getElementById('np-provider').value;
            const label    = document.getElementById('np-label').value.trim();
            const keyId    = document.getElementById('np-keyid').value.trim();
            const secret   = document.getElementById('np-secret').value.trim();
            const statusEl = document.getElementById('np-status');

            if (!keyId || !secret) {
                statusEl.textContent = 'Key ID and Secret are required.';
                statusEl.style.color = '#ef4444';
                return;
            }

            statusEl.textContent = 'Saving...';
            statusEl.style.color = '#888';

            const r = await fetch('/api/api-keys/' + encodeURIComponent(provider), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
                body: JSON.stringify({ keyId, secret, label }),
            });

            if (r.ok) {
                statusEl.textContent = 'Saved successfully.';
                statusEl.style.color = '#10b981';
                setTimeout(closeNewProfileModal, 1200);
            } else {
                const d = await r.json().catch(() => ({}));
                statusEl.textContent = 'Error: ' + (d.error || r.status);
                statusEl.style.color = '#ef4444';
            }
        }

        // Close modal on backdrop click
        document.getElementById('new-profile-modal').addEventListener('click', function(e) {
            if (e.target === this) closeNewProfileModal();
        });
        </script>
    `;

    const extraStyles = `
        .admin-panel {
            background-color: #2b2b2b;
            border: 4px solid #444;
            padding: 3rem;
            box-shadow: 15px 15px 0px #000;
            max-width: 600px;
            width: 100%;
            text-align: center;
            position: relative;
            z-index: 95;
        }
        
        h1 {
            color: #0d9488; /* Teal-600 */
            text-transform: uppercase;
            letter-spacing: 4px;
            border-bottom: 4px dashed #444;
            padding-bottom: 1.5rem;
            margin-top: 0;
            margin-bottom: 2rem;
            text-shadow: 2px 2px 0 #000;
        }
        
        .nav-grid {
            display: grid;
            gap: 1.5rem;
        }
        
        a.nav-btn {
            display: block;
            text-decoration: none; 
            color: #fff; 
            background-color: #333;
            padding: 1.5rem;
            border: 2px solid #555;
            text-align: center;
            transition: all 0.2s;
            font-weight: bold;
            font-size: 1.2rem;
            text-transform: uppercase;
            letter-spacing: 2px;
        }
        
        a.nav-btn:hover {
            background-color: #f97316; /* Orange-500 */
            color: #000;
            border-color: #f97316;
            transform: translateY(-4px);
            box-shadow: 0 6px 12px rgba(0,0,0,0.5);
        }

        button.nav-btn {
            font-family: 'Courier New', monospace;
            width: 100%;
            text-align: center;
        }

        button.nav-btn-action {
            border-color: #0d9488;
            color: #0d9488;
        }

        button.nav-btn-action:hover {
            background-color: #0d9488;
            border-color: #0d9488;
            color: #000;
            transform: translateY(-4px);
            box-shadow: 0 6px 12px rgba(0,0,0,0.5);
        }

        .status {
            margin-top: 2rem;
            font-size: 0.8rem;
            color: #666;
            border-top: 1px solid #444;
            padding-top: 1rem;
        }
    `;

    res.send(renderPage({
        token,
        title: "Admin HQ",
        activePage: 'admin',
        content,
        extraStyles
    }));
});

router.get('/cloud-claw', (req, res) => {
    const token = req.query.token as string;

    const content = `
        <div class="chat-container">
            <div class="chat-header">
                <span class="chat-title">CLOUD-CLAW // TRADING AGENT</span>
                <button class="clear-btn" onclick="clearHistory()">CLEAR HISTORY</button>
            </div>
            <div class="messages" id="messages"></div>
            <div class="input-row">
                <input id="input" type="text" placeholder="Send a message..." autocomplete="off" />
                <button onclick="sendMessage()">SEND</button>
            </div>
        </div>
        <script>
            const TOKEN = '${token}';

            async function loadHistory() {
                const res = await fetch('/api/cloud-claw/history', {
                    headers: { Authorization: 'Bearer ' + TOKEN }
                });
                if (!res.ok) return;
                const { messages } = await res.json();
                const box = document.getElementById('messages');
                box.innerHTML = '';
                messages.forEach(m => appendMessage(m.role, m.content, m.html));
            }

            function appendMessage(role, text, html) {
                const box = document.getElementById('messages');
                const div = document.createElement('div');
                div.className = 'message ' + role;
                if (role === 'assistant' && html) {
                    div.classList.add('markdown-body');
                    div.innerHTML = html;
                } else {
                    div.textContent = text;
                }
                box.appendChild(div);
                box.scrollTop = box.scrollHeight;
                return div;
            }

            function createStreamingAssistant() {
                const box = document.getElementById('messages');
                const wrap = document.createElement('div');
                wrap.className = 'message assistant streaming';
                const activity = document.createElement('div');
                activity.className = 'activity';
                const text = document.createElement('div');
                text.className = 'text';
                wrap.appendChild(activity);
                wrap.appendChild(text);
                box.appendChild(wrap);
                box.scrollTop = box.scrollHeight;
                return { wrap, activity, text };
            }

            function addActivityLine(activity, kind, content) {
                const line = document.createElement('div');
                line.className = 'activity-line ' + kind;
                line.textContent = content;
                activity.appendChild(line);
                document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
                return line;
            }

            async function sendMessage() {
                const input = document.getElementById('input');
                const text = input.value.trim();
                if (!text) return;
                input.value = '';
                appendMessage('user', text);

                const bubble = createStreamingAssistant();
                let statusLine = addActivityLine(bubble.activity, 'status', 'Thinking…');
                let pendingToolLine = null;

                try {
                    const res = await fetch('/api/cloud-claw/chat/stream', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
                        body: JSON.stringify({ message: text })
                    });
                    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);

                    const reader = res.body.getReader();
                    const decoder = new TextDecoder();
                    let buf = '';

                    while (true) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        buf += decoder.decode(value, { stream: true });
                        const events = buf.split('\\n\\n');
                        buf = events.pop() || '';
                        for (const block of events) {
                            const lines = block.split('\\n');
                            let evt = 'message', data = '';
                            for (const ln of lines) {
                                if (ln.startsWith('event: ')) evt = ln.slice(7).trim();
                                else if (ln.startsWith('data: ')) data += ln.slice(6);
                                else if (ln.startsWith(':')) { /* heartbeat */ }
                            }
                            if (!data) continue;
                            let payload;
                            try { payload = JSON.parse(data); } catch { continue; }

                            if (evt === 'status') {
                                if (statusLine) statusLine.textContent = payload.text;
                                else statusLine = addActivityLine(bubble.activity, 'status', payload.text);
                            } else if (evt === 'tool_use') {
                                if (statusLine) { statusLine.remove(); statusLine = null; }
                                pendingToolLine = addActivityLine(bubble.activity, 'tool', '→ ' + payload.description);
                            } else if (evt === 'tool_result') {
                                if (pendingToolLine) {
                                    pendingToolLine.textContent += '  ' + payload.summary;
                                    pendingToolLine.classList.add('tool-done');
                                    pendingToolLine = null;
                                } else {
                                    addActivityLine(bubble.activity, 'tool tool-done', payload.summary);
                                }
                            } else if (evt === 'text') {
                                if (statusLine) { statusLine.remove(); statusLine = null; }
                                bubble.text.textContent += payload.delta;
                                document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
                            } else if (evt === 'error') {
                                if (statusLine) { statusLine.remove(); statusLine = null; }
                                addActivityLine(bubble.activity, 'error', '[Error: ' + payload.message + ']');
                            } else if (evt === 'done') {
                                if (statusLine) { statusLine.remove(); statusLine = null; }
                                bubble.wrap.classList.remove('streaming');
                                if (payload.html) {
                                    bubble.text.classList.add('markdown-body');
                                    bubble.text.innerHTML = payload.html;
                                }
                            }
                        }
                    }
                } catch (e) {
                    if (statusLine) { statusLine.remove(); statusLine = null; }
                    addActivityLine(bubble.activity, 'error', '[Stream failed: ' + e.message + ']');
                }
            }

            async function clearHistory() {
                await fetch('/api/cloud-claw/chat', {
                    method: 'DELETE',
                    headers: { Authorization: 'Bearer ' + TOKEN }
                });
                document.getElementById('messages').innerHTML = '';
            }

            document.getElementById('input').addEventListener('keydown', e => {
                if (e.key === 'Enter') sendMessage();
            });

            loadHistory();
        </script>
    `;

    const extraStyles = `
        body { align-items: stretch; padding-top: 60px; }

        .chat-container {
            display: flex;
            flex-direction: column;
            height: calc(100vh - 60px);
            width: 100%;
            max-width: 900px;
            margin: 0 auto;
            position: relative;
            z-index: 95;
            padding: 1rem;
            box-sizing: border-box;
            gap: 0.75rem;
        }

        .chat-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0.75rem 1rem;
            background: #2b2b2b;
            border: 2px solid #444;
        }

        .chat-title {
            font-weight: bold;
            letter-spacing: 2px;
            color: #0d9488;
        }

        .clear-btn {
            background: transparent;
            border: 1px solid #555;
            color: #888;
            padding: 0.25rem 0.75rem;
            font-family: inherit;
            font-size: 0.75rem;
            letter-spacing: 1px;
            cursor: pointer;
        }
        .clear-btn:hover { border-color: #f97316; color: #f97316; }

        .messages {
            flex: 1;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
            padding: 0.5rem;
            background: #1e1e1e;
            border: 2px solid #333;
        }

        .message {
            padding: 0.75rem 1rem;
            max-width: 80%;
            white-space: pre-wrap;
            line-height: 1.5;
            font-size: 0.95rem;
        }
        .message.user {
            align-self: flex-end;
            background: #1e3a3a;
            border: 1px solid #0d9488;
            color: #e0e0e0;
        }
        .message.assistant {
            align-self: flex-start;
            background: #2b2b2b;
            border: 1px solid #444;
            color: #e0e0e0;
        }
        .message.assistant.streaming { border-color: #0d9488; }
        .message.assistant .activity {
            display: flex;
            flex-direction: column;
            gap: 0.2rem;
            margin-bottom: 0.4rem;
        }
        .message.assistant .activity:empty { display: none; }
        .message.assistant .activity-line {
            font-size: 0.75rem;
            color: #888;
            font-style: italic;
            padding: 0.1rem 0;
            line-height: 1.3;
        }
        .message.assistant .activity-line.tool { color: #fbbf24; font-style: normal; }
        .message.assistant .activity-line.tool.tool-done { color: #10b981; }
        .message.assistant .activity-line.error { color: #ef4444; font-style: normal; }
        .message.assistant .text { white-space: pre-wrap; }
        .message.assistant .text:empty { display: none; }
        .message.assistant .text.markdown-body { white-space: normal; }

        .message.assistant.markdown-body { white-space: normal; }
        .markdown-body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; }
        .markdown-body > *:first-child { margin-top: 0; }
        .markdown-body > *:last-child { margin-bottom: 0; }
        .markdown-body h1, .markdown-body h2, .markdown-body h3,
        .markdown-body h4, .markdown-body h5, .markdown-body h6 {
            color: #0d9488;
            font-weight: 600;
            margin: 1em 0 0.4em;
            line-height: 1.25;
        }
        .markdown-body h1 { font-size: 1.35rem; }
        .markdown-body h2 { font-size: 1.2rem; }
        .markdown-body h3 { font-size: 1.05rem; }
        .markdown-body p { margin: 0.4em 0; }
        .markdown-body a { color: #7c6fe0; text-decoration: none; }
        .markdown-body a:hover { color: #a78bfa; text-decoration: underline; }
        .markdown-body strong { color: #f4f4f4; }
        .markdown-body ul, .markdown-body ol { margin: 0.4em 0 0.6em; padding-left: 1.4em; }
        .markdown-body li { margin: 0.15em 0; }
        .markdown-body blockquote {
            border-left: 3px solid #0d9488;
            margin: 0.6em 0;
            padding: 0.1em 0.8em;
            color: #b8b8b8;
            background: #1b1b1b;
        }
        .markdown-body code {
            font-family: 'Courier New', monospace;
            background: #1b1b1b;
            color: #fbbf24;
            padding: 0.1em 0.3em;
            border-radius: 3px;
            font-size: 0.88em;
        }
        .markdown-body pre {
            background: #1b1b1b;
            border: 1px solid #333;
            padding: 0.7em 0.9em;
            overflow-x: auto;
            border-radius: 4px;
            margin: 0.5em 0;
        }
        .markdown-body pre code { background: transparent; color: #d8d8d8; padding: 0; font-size: 0.85rem; }
        .markdown-body table { border-collapse: collapse; margin: 0.5em 0; font-size: 0.88rem; }
        .markdown-body th, .markdown-body td { border: 1px solid #333; padding: 0.3em 0.6em; text-align: left; }
        .markdown-body th { background: #1e1e1e; color: #0d9488; }
        .markdown-body hr { border: none; border-top: 1px solid #333; margin: 1em 0; }

        .input-row {
            display: flex;
            gap: 0.5rem;
        }

        .input-row input {
            flex: 1;
            background: #2b2b2b;
            border: 2px solid #444;
            color: #e0e0e0;
            padding: 0.75rem 1rem;
            font-family: 'Courier New', monospace;
            font-size: 1rem;
            outline: none;
        }
        .input-row input:focus { border-color: #0d9488; }

        .input-row button {
            background: #0d9488;
            border: none;
            color: #000;
            padding: 0.75rem 1.5rem;
            font-family: 'Courier New', monospace;
            font-weight: bold;
            letter-spacing: 2px;
            cursor: pointer;
        }
        .input-row button:hover { background: #f97316; }
    `;

    res.send(renderPage({
        token,
        title: 'Cloud-Claw',
        activePage: 'cloud-claw',
        content,
        extraStyles
    }));
});

// ── Obsidian vault API (JSON, protected by verifyToken above) ────────────────

router.get('/obsidian/api/tree', (req, res) => {
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
    if (!vaultPath) return res.status(503).json({ error: 'OBSIDIAN_VAULT_PATH is not set on this server.' });
    if (!fs.existsSync(vaultPath)) {
        return res.status(503).json({ error: `The vault folder (${vaultPath}) does not exist on this server — the boot-time clone never ran or failed.` });
    }
    res.json({ tree: buildVaultTree(vaultPath) });
});

/** The newest commit in the vault checkout: how fresh the notes on disk are. */
function vaultHead(vaultPath: string): Promise<{ commit: string; date: string; subject: string } | null> {
    const SEP = String.fromCharCode(31); // git's %x1f
    return new Promise((resolve) => {
        execFile('git', ['-C', vaultPath, 'log', '-1', '--format=%h%x1f%cI%x1f%s'], { timeout: 10_000 }, (err, stdout) => {
            if (err) return resolve(null);
            const [commit, date, subject] = stdout.trim().split(SEP);
            resolve(commit ? { commit, date, subject: subject ?? '' } : null);
        });
    });
}

async function vaultStatus() {
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
    if (!vaultPath) return { configured: false };
    const exists = fs.existsSync(vaultPath);
    const isGit = exists && fs.existsSync(path.join(vaultPath, '.git'));
    return { configured: true, exists, isGit, head: isGit ? await vaultHead(vaultPath) : null, sync: vaultSyncStatus() };
}

router.get('/obsidian/api/status', async (_req, res) => {
    res.json(await vaultStatus());
});

// Pull now instead of waiting for the 10-minute loop (services/vaultSync.ts).
router.post('/obsidian/api/pull', async (_req, res) => {
    await pullVault();
    res.json(await vaultStatus());
});

router.get('/obsidian/api/file', (req, res) => {
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
    if (!vaultPath) return res.status(503).json({ error: 'OBSIDIAN_VAULT_PATH not configured' });
    const filePath = req.query.path as string;
    if (!filePath) return res.status(400).json({ error: 'path is required' });
    const content = safeVaultRead(vaultPath, filePath);
    if (content === null) return res.status(400).json({ error: 'File not found or access denied' });
    const html = filePath.endsWith('.md') ? renderMarkdown(content) : '';
    res.json({ path: filePath, content, html });
});

// ── Obsidian vault browser page ───────────────────────────────────────────────

router.get('/obsidian', (req, res) => {
    const token = req.query.token as string;

    const content = `
        <div class="vault-layout">
            <div class="vault-sidebar" id="sidebar">
                <div class="vault-sidebar-header">
                    <span>OBSIDIAN VAULT</span>
                    <div class="vault-sync">
                        <div id="vault-sync-text" class="vault-sync-text">Checking vault…</div>
                        <button id="vault-pull-btn" class="vault-pull-btn" title="git pull the vault now instead of waiting for the 10-minute sync">PULL</button>
                    </div>
                    <input id="vault-search" type="text" placeholder="Search..." oninput="filterTree(this.value)" />
                </div>
                <div class="vault-tree" id="vault-tree">
                    <span class="tree-loading">Loading vault...</span>
                </div>
            </div>
            <div class="vault-content" id="vault-content">
                <div class="vault-welcome">
                    <p>Select a note from the sidebar to view it here.</p>
                </div>
            </div>
        </div>
        <script>
        const TOKEN = '${token}';
        let fullTree = [];

        function treeMessage(text, isError) {
            const el = document.getElementById('vault-tree');
            el.innerHTML = '';
            const span = document.createElement('span');
            span.className = 'tree-loading' + (isError ? ' err' : '');
            span.textContent = text;
            el.appendChild(span);
        }

        async function loadTree() {
            try {
                const r = await fetch('/admin/obsidian/api/tree?token=' + TOKEN);
                const data = await r.json().catch(function() { return {}; });
                if (!r.ok || data.error) { treeMessage(data.error || ('Failed to load vault (HTTP ' + r.status + ').'), true); return; }
                fullTree = data.tree || [];
                if (!fullTree.length) { treeMessage('The vault folder has no notes in it.', true); return; }
                const q = document.getElementById('vault-search').value;
                if (q) filterTree(q); else renderTree(fullTree, document.getElementById('vault-tree'));
            } catch(e) {
                treeMessage('Failed to load vault: ' + e.message, true);
            }
        }

        // ── Sync status: how fresh the notes on disk are, and the last git pull ──
        function ago(iso) {
            const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
            if (s < 90) return 'just now';
            if (s < 5400) return Math.round(s / 60) + 'm ago';
            if (s < 129600) return Math.round(s / 3600) + 'h ago';
            return Math.round(s / 86400) + 'd ago';
        }

        function renderSync(st) {
            const el = document.getElementById('vault-sync-text');
            el.className = 'vault-sync-text';
            el.innerHTML = '';
            const line = function(text, cls) {
                const d = document.createElement('div');
                d.textContent = text;
                if (cls) d.className = cls;
                el.appendChild(d);
            };
            if (!st.configured) { line('OBSIDIAN_VAULT_PATH is not set.', 'err'); return; }
            if (!st.exists) { line('Vault folder missing on this server.', 'err'); return; }
            if (!st.isGit) line('Not a git checkout — cannot pull.', 'err');
            if (st.head) {
                line('Newest note commit ' + ago(st.head.date) + ' · ' + st.head.commit);
                el.title = st.head.subject;
            }
            const sync = st.sync || {};
            if (sync.ok === false) line('Last pull failed ' + (sync.at ? ago(sync.at) : '') + ': ' + sync.message, 'err');
            else if (sync.ok === true) line('Pulled ' + ago(sync.at) + ' — ' + sync.message, 'ok');
            else line('No in-app pull yet (next within 10 min).', 'muted');
        }

        async function loadStatus() {
            try {
                const r = await fetch('/admin/obsidian/api/status?token=' + TOKEN);
                renderSync(await r.json());
            } catch (e) {
                document.getElementById('vault-sync-text').textContent = 'Status unavailable: ' + e.message;
            }
        }

        document.getElementById('vault-pull-btn').addEventListener('click', async function() {
            const btn = this;
            btn.disabled = true;
            btn.textContent = 'PULLING…';
            try {
                const r = await fetch('/admin/obsidian/api/pull?token=' + TOKEN, { method: 'POST' });
                renderSync(await r.json());
                await loadTree();
            } catch (e) {
                document.getElementById('vault-sync-text').textContent = 'Pull failed: ' + e.message;
            } finally {
                btn.disabled = false;
                btn.textContent = 'PULL';
            }
        });

        // Built with textContent: note and folder names come from the vault.
        function renderTree(nodes, container, depth, expandAll) {
            depth = depth || 0;
            container.innerHTML = '';
            const ul = document.createElement('ul');
            ul.className = 'tree-ul';
            nodes.forEach(function(node) {
                const li = document.createElement('li');
                if (node.type === 'dir') {
                    const label = document.createElement('span');
                    label.className = 'tree-dir';
                    label.style.paddingLeft = (depth * 12) + 'px';
                    const childContainer = document.createElement('div');
                    childContainer.style.display = expandAll ? 'block' : 'none';
                    renderTree(node.children || [], childContainer, depth + 1, expandAll);
                    const setLabel = function(open) { label.textContent = (open ? '▼ ' : '▶ ') + node.name + '/'; };
                    setLabel(!!expandAll);
                    label.addEventListener('click', function(e) {
                        e.stopPropagation();
                        const open = childContainer.style.display === 'none';
                        childContainer.style.display = open ? 'block' : 'none';
                        setLabel(open);
                    });
                    li.appendChild(label);
                    li.appendChild(childContainer);
                } else {
                    const label = document.createElement('span');
                    label.className = 'tree-file';
                    label.style.paddingLeft = (depth * 12 + 12) + 'px';
                    label.textContent = '📄 ' + node.name;
                    label.title = node.path;
                    label.addEventListener('click', function() {
                        document.querySelectorAll('.tree-file').forEach(function(el) { el.classList.remove('active'); });
                        label.classList.add('active');
                        openFile(node.path);
                    });
                    li.appendChild(label);
                }
                ul.appendChild(li);
            });
            container.appendChild(ul);
        }

        function filterTree(q) {
            if (!q) { renderTree(fullTree, document.getElementById('vault-tree')); return; }
            const lower = q.toLowerCase();
            function filter(nodes) {
                return nodes.flatMap(function(n) {
                    if (n.type === 'file') return n.name.toLowerCase().includes(lower) ? [n] : [];
                    const ch = filter(n.children || []);
                    return ch.length ? [Object.assign({}, n, {children: ch})] : [];
                });
            }
            const hits = filter(fullTree);
            if (!hits.length) { treeMessage('No notes match "' + q + '".'); return; }
            renderTree(hits, document.getElementById('vault-tree'), 0, true);
        }

        async function openFile(p) {
            const content = document.getElementById('vault-content');
            content.innerHTML = '<div class="vault-welcome"><p>Loading...</p></div>';
            try {
                const r = await fetch('/admin/obsidian/api/file?path=' + encodeURIComponent(p) + '&token=' + TOKEN);
                const data = await r.json();
                if (data.error) { content.innerHTML = '<div class="vault-welcome"><p class="err">' + escHtml(data.error) + '</p></div>'; return; }
                if (data.html) {
                    content.innerHTML = '<div class="vault-file-header">' + escHtml(p) + '</div><div class="vault-md markdown-body">' + data.html + '</div>';
                } else {
                    content.innerHTML = '<div class="vault-file-header">' + escHtml(p) + '</div><pre class="vault-pre">' + escHtml(data.content) + '</pre>';
                }
            } catch(e) {
                content.innerHTML = '<div class="vault-welcome"><p class="err">Failed to load file.</p></div>';
            }
        }

        function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

        loadTree();
        loadStatus();
        </script>
    `;

    const extraStyles = `
        body { align-items: stretch; padding-top: 60px; overflow: hidden; }

        .vault-layout {
            display: flex;
            height: calc(100vh - 60px);
            width: 100%;
            position: relative;
            z-index: 95;
        }

        .vault-sidebar {
            width: 260px;
            min-width: 260px;
            background: #1e1e1e;
            border-right: 2px solid #333;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .vault-sidebar-header {
            padding: 0.75rem;
            border-bottom: 1px solid #333;
            font-size: 0.7rem;
            letter-spacing: 2px;
            color: #0d9488;
            font-weight: bold;
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
        }

        #vault-search {
            background: #2b2b2b;
            border: 1px solid #444;
            color: #e0e0e0;
            padding: 0.3rem 0.5rem;
            font-family: 'Courier New', monospace;
            font-size: 0.8rem;
            outline: none;
            width: 100%;
            box-sizing: border-box;
        }
        #vault-search:focus { border-color: #0d9488; }

        .vault-sync {
            display: flex;
            align-items: flex-start;
            gap: 0.5rem;
            font-weight: normal;
            letter-spacing: 0;
        }
        .vault-sync-text {
            flex: 1;
            min-width: 0;
            font-size: 0.65rem;
            line-height: 1.4;
            color: #888;
            overflow-wrap: anywhere;
        }
        .vault-sync-text .ok { color: #10b981; }
        .vault-sync-text .err { color: #f97316; }
        .vault-sync-text .muted { color: #555; }
        .vault-pull-btn {
            background: transparent;
            border: 1px solid #444;
            color: #0d9488;
            font-family: 'Courier New', monospace;
            font-size: 0.65rem;
            letter-spacing: 1px;
            padding: 0.2rem 0.5rem;
            cursor: pointer;
            white-space: nowrap;
        }
        .vault-pull-btn:hover:not(:disabled) { border-color: #0d9488; color: #2dd4bf; }
        .vault-pull-btn:disabled { opacity: 0.5; }

        .vault-tree {
            flex: 1;
            overflow-y: auto;
            padding: 0.5rem 0;
            font-size: 0.75rem;
        }
        .vault-tree::-webkit-scrollbar { width: 4px; }
        .vault-tree::-webkit-scrollbar-thumb { background: #333; }

        .tree-ul { list-style: none; margin: 0; padding: 0; }
        .tree-ul li { margin: 0; }

        .tree-dir, .tree-file {
            display: block;
            padding: 0.2rem 0.75rem;
            cursor: pointer;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            transition: background 0.1s;
        }
        .tree-dir { color: #aaa; }
        .tree-dir:hover { background: #2b2b2b; color: #fff; }
        .tree-file { color: #7c6fe0; }
        .tree-file:hover { background: #2b2b2b; color: #a78bfa; }
        .tree-file.active { background: #1e3a3a; color: #0d9488; }

        .tree-loading { color: #555; font-size: 0.75rem; padding: 1rem; display: block; }
        .tree-loading.err { color: #f97316; line-height: 1.5; }

        .vault-content {
            flex: 1;
            overflow-y: auto;
            background: #141414;
            display: flex;
            flex-direction: column;
        }
        .vault-content::-webkit-scrollbar { width: 6px; }
        .vault-content::-webkit-scrollbar-thumb { background: #333; }

        .vault-welcome {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #444;
            font-size: 0.85rem;
        }
        .vault-welcome .err { color: #f97316; }

        .vault-file-header {
            padding: 0.75rem 1.25rem;
            font-size: 0.7rem;
            color: #0d9488;
            letter-spacing: 1px;
            border-bottom: 1px solid #222;
            background: #1e1e1e;
            position: sticky;
            top: 0;
        }

        .vault-pre {
            margin: 0;
            padding: 1.25rem;
            font-family: 'Courier New', monospace;
            font-size: 0.8rem;
            color: #ccc;
            white-space: pre-wrap;
            word-break: break-word;
            line-height: 1.6;
            flex: 1;
        }

        .markdown-body {
            padding: 1.5rem 2rem;
            color: #d8d8d8;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 0.95rem;
            line-height: 1.65;
            max-width: 860px;
            box-sizing: border-box;
        }
        .markdown-body h1, .markdown-body h2, .markdown-body h3,
        .markdown-body h4, .markdown-body h5, .markdown-body h6 {
            color: #0d9488;
            font-weight: 600;
            margin: 1.6em 0 0.6em;
            line-height: 1.25;
        }
        .markdown-body h1 { font-size: 1.7rem; border-bottom: 1px solid #333; padding-bottom: 0.3em; }
        .markdown-body h2 { font-size: 1.35rem; border-bottom: 1px solid #2a2a2a; padding-bottom: 0.25em; }
        .markdown-body h3 { font-size: 1.15rem; }
        .markdown-body p { margin: 0.6em 0; }
        .markdown-body a { color: #7c6fe0; text-decoration: none; }
        .markdown-body a:hover { color: #a78bfa; text-decoration: underline; }
        .markdown-body strong { color: #f4f4f4; }
        .markdown-body em { color: #ddd; }
        .markdown-body ul, .markdown-body ol { margin: 0.5em 0 0.8em; padding-left: 1.5em; }
        .markdown-body li { margin: 0.2em 0; }
        .markdown-body blockquote {
            border-left: 3px solid #0d9488;
            margin: 0.8em 0;
            padding: 0.2em 1em;
            color: #b8b8b8;
            background: #1b1b1b;
        }
        .markdown-body code {
            font-family: 'Courier New', monospace;
            background: #2b2b2b;
            color: #fbbf24;
            padding: 0.1em 0.35em;
            border-radius: 3px;
            font-size: 0.88em;
        }
        .markdown-body pre {
            background: #1b1b1b;
            border: 1px solid #2a2a2a;
            padding: 0.9em 1em;
            overflow-x: auto;
            border-radius: 4px;
        }
        .markdown-body pre code {
            background: transparent;
            color: #d8d8d8;
            padding: 0;
            font-size: 0.85rem;
        }
        .markdown-body hr { border: none; border-top: 1px solid #333; margin: 1.5em 0; }
        .markdown-body table {
            border-collapse: collapse;
            margin: 0.8em 0;
            font-size: 0.88rem;
        }
        .markdown-body th, .markdown-body td {
            border: 1px solid #333;
            padding: 0.4em 0.8em;
            text-align: left;
        }
        .markdown-body th { background: #1e1e1e; color: #0d9488; }
        .markdown-body img { max-width: 100%; }
        .markdown-body input[type="checkbox"] { margin-right: 0.4em; }
    `;

    res.send(renderPage({
        token,
        title: 'Obsidian Vault',
        activePage: 'obsidian',
        content,
        extraStyles
    }));
});

// ── Alpaca wallets (JSON + SSE, protected by verifyToken above) ──────────────
// What a wallet is, and how the live stream works: services/alpacaStream.ts.

const WALLET_META: Record<WalletId, { label: string; live: boolean; provider?: string }> = {
    cloudclaw: { label: 'Cloud-Claw paper', live: false },
    paper:     { label: 'My paper', live: false, provider: 'alpaca_paper' },
    live:      { label: 'My live', live: true, provider: 'alpaca_live' },
};

const envPaperCreds = (): AlpacaCreds | null =>
    process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY
        ? { keyId: process.env.ALPACA_API_KEY, secret: process.env.ALPACA_SECRET_KEY, live: false }
        : null;

type ResolvedWallet = { wallet: WalletId; creds: AlpacaCreds; hubKey: string };

/** This admin's credentials for one wallet, or why there are none. */
async function resolveWallet(userId: string, raw: unknown): Promise<ResolvedWallet | { error: string; status: number }> {
    const wallet = String(raw) as WalletId;
    if (!WALLET_IDS.includes(wallet)) return { error: `Unknown wallet "${String(raw)}"`, status: 400 };
    if (wallet === 'cloudclaw') {
        const creds = envPaperCreds();
        if (!creds) return { error: 'ALPACA_API_KEY / ALPACA_SECRET_KEY are not set on this server.', status: 503 };
        return { wallet, creds, hubKey: `cloudclaw:${creds.keyId}` };
    }
    const meta = WALLET_META[wallet];
    const keys = await getDecryptedKeys(userId, meta.provider!);
    if (!keys) return { error: `No ${meta.live ? 'live' : 'paper'} Alpaca keys on your Profile page yet.`, status: 404 };
    // The key id is part of the hub key, so re-saving keys on the Profile page
    // opens fresh upstream connections instead of reusing the old login.
    return { wallet, creds: { ...keys, live: meta.live }, hubKey: `${wallet}:${userId}:${keys.keyId}` };
}

router.get('/alpaca/api/wallets', async (req: any, res) => {
    const userId = String(req.adminUser.id);
    const list = await Promise.all(WALLET_IDS.map(async (id) => {
        const r = await resolveWallet(userId, id).catch((err: any) => ({ error: err.message as string, status: 500 }));
        const missing = 'error' in r;
        return { id, label: WALLET_META[id].label, live: WALLET_META[id].live, available: !missing, reason: missing ? r.error : null };
    }));
    res.json(list);
});

// Server-sent events: a full snapshot of the wallet on connect and on every
// change (price prints, fills, REST resyncs). EventSource reconnects by itself,
// which also covers the Next.js rewrite proxy's 5-minute request timeout.
router.get('/alpaca/api/stream', async (req: any, res) => {
    const w = await resolveWallet(String(req.adminUser.id), req.query.wallet);
    if ('error' in w) return res.status(w.status).json({ error: w.error });
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const unwatch = watchWallet(w.hubKey, w.wallet, w.creds, (snap) => {
        res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    // res, not req: since Node 16 req 'close' fires once the (empty) body is read.
    res.on('close', () => { clearInterval(ping); unwatch(); });
});

const WALLET_READS: Record<string, (q: any) => string> = {
    account: () => '/account',
    positions: () => '/positions',
    orders: () => '/orders?limit=25&status=all&direction=desc',
    // Equity + P&L timeseries. Defaults match the dashboard's 1D / 15-min view.
    history: (q) => '/account/portfolio/history?' + new URLSearchParams({
        period: String(q.period || '1D'),
        timeframe: String(q.timeframe || '15Min'),
        intraday_reporting: 'market_hours',
    }).toString(),
};

router.get('/alpaca/api/w/:wallet/:resource', async (req: any, res) => {
    const read = WALLET_READS[req.params.resource];
    if (!read) return res.status(404).json({ error: `Unknown resource "${req.params.resource}"` });
    const w = await resolveWallet(String(req.adminUser.id), req.params.wallet);
    if ('error' in w) return res.status(w.status).json({ error: w.error });
    try { res.json(await alpacaRest(w.creds, read(req.query))); }
    catch (err: any) { res.status(err instanceof AlpacaError ? err.status : 500).json({ error: err.message }); }
});

// Per-position value timeseries from our own snapshot table (Cloud-Claw paper
// wallet only — that is what snapshotAlpacaNow records).
// period accepted as 1D / 1W / 1M / 3M / ALL.
router.get('/alpaca/api/snapshots', async (req, res) => {
    try {
        const period = ((req.query.period as string) || '1D').toUpperCase();
        const since = new Date();
        switch (period) {
            case '1D': since.setUTCDate(since.getUTCDate() - 1); break;
            case '1W': since.setUTCDate(since.getUTCDate() - 7); break;
            case '1M': since.setUTCMonth(since.getUTCMonth() - 1); break;
            case '3M': since.setUTCMonth(since.getUTCMonth() - 3); break;
            case 'ALL': since.setTime(0); break;
            default: since.setUTCDate(since.getUTCDate() - 1);
        }
        const docs = await AlpacaSnapshot
            .find({ ts: { $gte: since } })
            .sort({ ts: 1 })
            .lean();
        res.json(docs);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /admin/alpaca/api/apply-to-personal
// Mirrors current paper positions as market orders on the live account.
// Body: { orders: [{ symbol, notional }] }  (confirmed by the client modal).
router.post('/alpaca/api/apply-to-personal', async (req: any, res) => {
    // MUR-62 SAFETY GATE: real-money order placement is OFF by default and
    // requires an explicit, per-trade, interactive board-member confirmation.
    // Non-interactive / agent / service-token callers are rejected here before
    // any vault key is decrypted or any order is sent to Alpaca.
    const gate = evaluateLiveApplyGate({
        enabledEnv: process.env.LIVE_APPLY_TO_PERSONAL_ENABLED,
        confirmHeader: req.header('X-Live-Apply-Confirm'),
        confirmBody: req.body?.confirmation,
    });
    if (!gate.allowed) {
        console.warn(`[MUR-62] Blocked live apply-to-personal (${gate.code}) user=${req.adminUser?.id}`);
        return res.status(gate.status).json({ error: gate.error, code: gate.code });
    }

    const { orders } = req.body as { orders?: { symbol: string; notional: number }[] };
    if (!Array.isArray(orders) || orders.length === 0) {
        return res.status(400).json({ error: 'orders array is required' });
    }
    try {
        const userId = String(req.adminUser.id);
        const keys = await getDecryptedKeys(userId, 'alpaca_live');
        if (!keys) return res.status(400).json({ error: 'No personal Alpaca keys found. Add them on the Profile page.' });

        const base = restBase(true);
        const headers: Record<string, string> = {
            'APCA-API-KEY-ID': keys.keyId,
            'APCA-API-SECRET-KEY': keys.secret,
            'Content-Type': 'application/json',
        };

        const results: { symbol: string; ok: boolean; orderId?: string; error?: string }[] = [];
        for (const o of orders) {
            try {
                const r = await fetch(`${base}/orders`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        symbol: o.symbol,
                        notional: o.notional.toFixed(2),
                        side: 'buy',
                        type: 'market',
                        time_in_force: 'day',
                    }),
                });
                if (!r.ok) {
                    results.push({ symbol: o.symbol, ok: false, error: await r.text() });
                } else {
                    const data: any = await r.json();
                    results.push({ symbol: o.symbol, ok: true, orderId: data.id });
                }
            } catch (err: any) {
                results.push({ symbol: o.symbol, ok: false, error: err.message });
            }
        }
        // Anyone watching the live wallet sees the new orders without waiting for the next resync.
        resyncWallet(`live:${userId}:${keys.keyId}`);
        res.json({ results });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// Capture a single snapshot of the Cloud-Claw paper account + positions.
// Exported so server.ts can call it on an interval. Errors are swallowed
// (Alpaca outages / API key issues shouldn't crash the snapshot loop).
export async function snapshotAlpacaNow(): Promise<void> {
    const creds = envPaperCreds();
    if (!creds) return;
    try {
        const [acct, positions] = await Promise.all([
            alpacaRest(creds, '/account'),
            alpacaRest(creds, '/positions') as Promise<any[]>,
        ]);
        const equity      = parseFloat(acct.equity);
        const last_equity = parseFloat(acct.last_equity);
        await AlpacaSnapshot.create({
            ts: new Date(),
            equity,
            last_equity,
            cash:         parseFloat(acct.cash),
            buying_power: parseFloat(acct.buying_power),
            day_pl:       isFinite(equity) && isFinite(last_equity) ? equity - last_equity : 0,
            positions: (Array.isArray(positions) ? positions : []).map((p: any) => ({
                symbol:        p.symbol,
                qty:           parseFloat(p.qty),
                market_value:  parseFloat(p.market_value),
                unrealized_pl: parseFloat(p.unrealized_pl),
                current_price: parseFloat(p.current_price),
            })),
        });
    } catch (err: any) {
        console.error('[ALPACA SNAPSHOT] failed:', err.message);
    }
}

// ── Alpaca dashboard page ─────────────────────────────────────────────────────

router.get('/alpaca', (req, res) => {
    const token = req.query.token as string;

    const content = `
        <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
        <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
        <div class="alpaca-layout">
            <div class="alpaca-header">
                <div class="alpaca-title" id="alpaca-title">ALPACA // WALLETS</div>
                <div class="alpaca-controls">
                    <div class="profile-toggle" id="wallet-tabs"></div>
                    <span id="live-pill" class="live-pill" title="">&#9679; CONNECTING</span>
                    <span id="last-updated" class="last-updated">Loading...</span>
                    <button class="refresh-btn" onclick="reconnect()" title="Reconnect the live stream and reload the charts">&#8635; REFRESH</button>
                    <button id="apply-btn" class="apply-btn" onclick="openApplyModal()" style="display:none;">&#9654; APPLY TO LIVE</button>
                </div>
            </div>

            <div id="alpaca-banner" class="alpaca-banner" style="display:none;"></div>

            <div class="stats-row">
                <div class="stat-box">
                    <div class="stat-label">EQUITY</div>
                    <div class="stat-value" id="stat-equity">—</div>
                </div>
                <div class="stat-box">
                    <div class="stat-label">BUYING POWER</div>
                    <div class="stat-value" id="stat-buying-power">—</div>
                </div>
                <div class="stat-box">
                    <div class="stat-label">DAY P&amp;L</div>
                    <div class="stat-value" id="stat-day-pl">—</div>
                    <div class="stat-sub" id="stat-day-pl-pct"></div>
                </div>
                <div class="stat-box">
                    <div class="stat-label">CASH</div>
                    <div class="stat-value" id="stat-cash">—</div>
                </div>
            </div>

            <div class="section">
                <div class="section-title-row">
                    <div class="section-title">&#9632; KPI TRENDS</div>
                    <div class="range-buttons">
                        <button class="range-btn active" data-range="1D">1D</button>
                        <button class="range-btn" data-range="1W">1W</button>
                        <button class="range-btn" data-range="1M">1M</button>
                        <button class="range-btn" data-range="3M">3M</button>
                        <button class="range-btn" data-range="ALL">ALL</button>
                    </div>
                </div>
                <div class="charts-grid">
                    <div class="chart-card">
                        <div class="chart-label">EQUITY</div>
                        <div class="chart-canvas-wrap"><canvas id="chart-equity"></canvas></div>
                    </div>
                    <div class="chart-card">
                        <div class="chart-label">CUMULATIVE P&amp;L</div>
                        <div class="chart-canvas-wrap"><canvas id="chart-pl"></canvas></div>
                    </div>
                    <div class="chart-card chart-wide">
                        <div class="chart-label">POSITION VALUES (SNAPSHOTTED)</div>
                        <div class="chart-canvas-wrap chart-canvas-wrap-tall"><canvas id="chart-positions"></canvas></div>
                    </div>
                </div>
            </div>

            <div class="section">
                <div class="section-title">&#9632; OPEN POSITIONS</div>
                <div class="table-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th>SYMBOL</th><th>QTY</th><th>AVG ENTRY</th>
                                <th>CURRENT</th><th>MKT VALUE</th><th>UNREALIZED P&amp;L</th><th>P&amp;L %</th>
                            </tr>
                        </thead>
                        <tbody id="positions-body"><tr><td colspan="7" class="loading-row">Loading...</td></tr></tbody>
                    </table>
                </div>
            </div>

            <div class="section">
                <div class="section-title">&#9632; RECENT ORDERS</div>
                <div class="table-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th>DATE</th><th>SYMBOL</th><th>SIDE</th><th>QTY</th>
                                <th>TYPE</th><th>STATUS</th><th>FILLED AT</th>
                            </tr>
                        </thead>
                        <tbody id="orders-body"><tr><td colspan="7" class="loading-row">Loading...</td></tr></tbody>
                    </table>
                </div>
            </div>
        </div>

        <!-- Apply to Personal modal -->
        <div id="apply-modal" class="modal-overlay" style="display:none;">
            <div class="modal-box">
                <div class="modal-header">
                    <span>APPLY PAPER POSITIONS TO YOUR LIVE ACCOUNT</span>
                    <button class="modal-close" onclick="closeApplyModal()">&#10005;</button>
                </div>
                <div class="modal-warning">
                    &#9888; THIS WILL PLACE REAL ORDERS ON YOUR LIVE ALPACA ACCOUNT.
                    Review carefully before confirming.
                </div>
                <div id="modal-paper-summary" class="modal-section">
                    <div class="modal-section-title">PAPER POSITIONS (SOURCE: THE WALLET ON SCREEN)</div>
                    <div id="modal-paper-rows"></div>
                </div>
                <div id="modal-personal-summary" class="modal-section">
                    <div class="modal-section-title">LIVE ACCOUNT BALANCE</div>
                    <div id="modal-personal-balance"></div>
                </div>
                <div class="modal-section">
                    <div class="modal-section-title">PROPOSED ORDERS (market buy, notional = paper market value)</div>
                    <div id="modal-orders-rows"></div>
                </div>
                <div class="modal-footer">
                    <button class="modal-cancel-btn" onclick="closeApplyModal()">CANCEL</button>
                    <button class="modal-confirm-btn" id="modal-confirm-btn" onclick="confirmApply()">CONFIRM — PLACE ORDERS</button>
                </div>
                <div id="modal-result" class="modal-result" style="display:none;"></div>
            </div>
        </div>

        <script>
        const TOKEN = '${token}';
        const q = function (id) { return document.getElementById(id); };

        // ── Formatting helpers ────────────────────────────────────────────────

        function fmt$(v) {
            const n = parseFloat(v);
            if (isNaN(n)) return '—';
            return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }
        function fmtPct(v) {
            const n = parseFloat(v);
            if (isNaN(n)) return '';
            return (n >= 0 ? '+' : '') + (n * 100).toFixed(2) + '%';
        }
        function plClass(v) {
            const n = parseFloat(v);
            return isNaN(n) ? '' : (n >= 0 ? 'pos' : 'neg');
        }
        function escHtml(s) {
            const d = document.createElement('div');
            d.textContent = String(s ?? '—');
            return d.innerHTML;
        }
        function fmtDate(s) {
            if (!s) return '—';
            const d = new Date(s);
            return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
                   d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        }

        // ── Wallets ───────────────────────────────────────────────────────────
        // Each wallet is one Alpaca account; the server streams it to this page.
        let wallets = [];
        let currentWallet = null;
        let stream = null;
        const prevPrice = {};

        function walletApi(wallet, path) {
            return '/admin/alpaca/api/w/' + encodeURIComponent(wallet) + path + (path.indexOf('?') === -1 ? '?' : '&') + 'token=' + TOKEN;
        }
        function walletById(id) { return wallets.find(function (w) { return w.id === id; }); }

        function showBanner(msg, isErr, profileLink) {
            const b = q('alpaca-banner');
            if (!msg) { b.style.display = 'none'; b.textContent = ''; return; }
            b.style.display = 'block';
            b.className = 'alpaca-banner' + (isErr ? ' err' : '');
            b.textContent = msg;
            if (profileLink) {
                const a = document.createElement('a');
                a.href = '/admin/profile?token=' + TOKEN;
                a.textContent = 'Open Profile & API keys →';
                b.appendChild(document.createTextNode(' '));
                b.appendChild(a);
            }
        }

        function setPill(state, text, title) {
            const p = q('live-pill');
            p.className = 'live-pill pill-' + state;
            p.textContent = '● ' + text;
            p.title = title || '';
        }

        function renderWalletTabs() {
            const box = q('wallet-tabs');
            box.innerHTML = '';
            wallets.forEach(function (w) {
                const b = document.createElement('button');
                b.className = 'profile-btn' + (w.id === currentWallet ? ' active' : '') + (w.available ? '' : ' unavailable');
                b.textContent = w.label.toUpperCase() + ' ';
                const badge = document.createElement('span');
                badge.className = 'wallet-mode ' + (w.live ? 'mode-live' : 'mode-paper');
                badge.textContent = w.live ? 'LIVE' : 'PAPER';
                b.appendChild(badge);
                b.title = w.available ? (w.live ? 'Real-money account' : 'Paper account') : w.reason;
                b.onclick = function () {
                    if (!w.available) { showBanner(w.reason, true, w.id !== 'cloudclaw'); return; }
                    if (w.id !== currentWallet) switchWallet(w.id);
                };
                box.appendChild(b);
            });
        }

        function pickInitialWallet() {
            const ok = function (id) { const w = walletById(id); return !!(w && w.available); };
            const fromUrl = new URL(location.href).searchParams.get('wallet');
            let saved = null;
            try { saved = localStorage.getItem('alpaca.wallet'); } catch (e) { /* storage blocked */ }
            if (fromUrl && ok(fromUrl)) return fromUrl;
            if (saved && ok(saved)) return saved;
            const first = wallets.find(function (w) { return w.available; });
            return first ? first.id : null;
        }

        async function loadWallets() {
            try {
                const r = await fetch('/admin/alpaca/api/wallets?token=' + TOKEN);
                wallets = await r.json();
                if (!Array.isArray(wallets)) throw new Error(wallets.error || 'bad response');
            } catch (e) {
                showBanner('Could not list Alpaca wallets: ' + e.message, true);
                setPill('error', 'ERROR');
                return;
            }
            currentWallet = pickInitialWallet();
            renderWalletTabs();
            if (!currentWallet) {
                showBanner('No Alpaca wallet is available: the server has no Cloud-Claw keys and your Profile page has no Alpaca keys.', true, true);
                setPill('error', 'NO WALLET');
                q('last-updated').textContent = '';
                return;
            }
            switchWallet(currentWallet);
        }

        function switchWallet(id) {
            currentWallet = id;
            try { localStorage.setItem('alpaca.wallet', id); } catch (e) { /* storage blocked */ }
            const u = new URL(location.href);
            u.searchParams.set('wallet', id);
            history.replaceState(null, '', u.toString());
            renderWalletTabs();
            const w = walletById(id);
            q('alpaca-title').textContent = 'ALPACA // ' + w.label.toUpperCase() + (w.live ? ' — REAL MONEY' : '');
            const live = walletById('live');
            q('apply-btn').style.display = (!w.live && live && live.available) ? 'inline-block' : 'none';
            resetView();
            connectStream();
            loadCharts();
        }

        function resetView() {
            for (const k in prevPrice) delete prevPrice[k];
            ['stat-equity', 'stat-buying-power', 'stat-day-pl', 'stat-cash'].forEach(function (id) {
                q(id).textContent = '—';
                q(id).className = 'stat-value';
            });
            q('stat-day-pl-pct').textContent = '';
            q('positions-body').innerHTML = '<tr><td colspan="7" class="loading-row">Loading...</td></tr>';
            q('orders-body').innerHTML = '<tr><td colspan="7" class="loading-row">Loading...</td></tr>';
            q('last-updated').textContent = 'Loading...';
            showBanner('');
        }

        // ── Live stream (server-sent events) ─────────────────────────────────
        function connectStream() {
            if (stream) stream.close();
            setPill('connecting', 'CONNECTING');
            const wallet = currentWallet;
            const es = new EventSource('/admin/alpaca/api/stream?wallet=' + encodeURIComponent(wallet) + '&token=' + TOKEN);
            stream = es;
            es.addEventListener('snapshot', function (e) {
                if (stream !== es) return;
                let snap;
                try { snap = JSON.parse(e.data); } catch (err) { return; }
                renderSnapshot(snap);
            });
            es.onerror = function () {
                if (stream !== es) return;
                if (es.readyState === EventSource.CLOSED) setPill('error', 'DISCONNECTED', 'The server refused the stream. Press REFRESH to try again.');
                else setPill('reconnecting', 'RECONNECTING', 'Lost the stream; the browser is reconnecting.');
            };
        }

        function reconnect() {
            if (!currentWallet) { loadWallets(); return; }
            connectStream();
            loadCharts();
        }

        function renderSnapshot(snap) {
            const cloud = snap.wallet === 'cloudclaw';
            if (snap.error) {
                showBanner(snap.error + (cloud
                    ? ' — the server\\'s ALPACA_API_KEY / ALPACA_SECRET_KEY need replacing in Secrets Manager, or add your own paper keys on the Profile page.'
                    : ' — update these keys on the Profile page.'), true, true);
            } else {
                showBanner('');
            }

            const t = snap.streams.trading, d = snap.streams.data;
            const detail = 'Orders: ' + t.state + (t.message ? ' (' + t.message + ')' : '') +
                ' · Prices: ' + d.state + (d.message ? ' (' + d.message + ')' : '');
            if (snap.error && !snap.account) setPill('error', 'ERROR', snap.error);
            else if (t.state === 'live' && (d.state === 'live' || d.state === 'idle')) setPill('live', 'LIVE', detail);
            else if (t.state === 'error' || d.state === 'error') setPill('degraded', 'PARTIAL', detail + ' — values still refresh every 20s');
            else setPill('connecting', (t.state === 'reconnecting' || d.state === 'reconnecting') ? 'RECONNECTING' : 'CONNECTING', detail);

            const at = [snap.tickAt, snap.syncedAt].filter(Boolean).sort().pop();
            if (at) q('last-updated').textContent = 'Updated ' + new Date(at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            else if (snap.error) q('last-updated').textContent = '';

            if (snap.account) {
                renderAccount(snap.account);
                renderPositions(snap.positions);
                renderOrders(snap.orders);
            } else if (snap.error) {
                q('positions-body').innerHTML = '<tr><td colspan="7" class="loading-row">Unavailable.</td></tr>';
                q('orders-body').innerHTML = '<tr><td colspan="7" class="loading-row">Unavailable.</td></tr>';
            }
        }

        function renderAccount(a) {
            q('stat-equity').textContent = fmt$(a.equity);
            q('stat-buying-power').textContent = fmt$(a.buying_power);
            q('stat-cash').textContent = fmt$(a.cash);
            const dayPl = parseFloat(a.equity) - parseFloat(a.last_equity || a.equity);
            const dayPlPct = parseFloat(a.last_equity) > 0 ? dayPl / parseFloat(a.last_equity) : 0;
            const plEl = q('stat-day-pl');
            plEl.textContent = fmt$(dayPl);
            plEl.className = 'stat-value ' + (dayPl >= 0 ? 'pos' : 'neg');
            q('stat-day-pl-pct').textContent = fmtPct(dayPlPct);
        }

        function renderPositions(data) {
            const tbody = q('positions-body');
            if (!Array.isArray(data) || data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="loading-row">No open positions.</td></tr>';
                return;
            }
            tbody.innerHTML = data.map(function (p) {
                const plCls = plClass(p.unrealized_pl);
                const price = parseFloat(p.current_price);
                const before = prevPrice[p.symbol];
                const tick = before === undefined || price === before ? '' : (price > before ? ' tick-up' : ' tick-down');
                prevPrice[p.symbol] = price;
                return '<tr>' +
                    '<td class="sym">' + escHtml(p.symbol) + '</td>' +
                    '<td>' + escHtml(p.qty) + '</td>' +
                    '<td>' + fmt$(p.avg_entry_price) + '</td>' +
                    '<td class="price' + tick + '">' + fmt$(p.current_price) + '</td>' +
                    '<td>' + fmt$(p.market_value) + '</td>' +
                    '<td class="' + plCls + '">' + fmt$(p.unrealized_pl) + '</td>' +
                    '<td class="' + plCls + '">' + fmtPct(p.unrealized_plpc) + '</td>' +
                    '</tr>';
            }).join('');
            // Let the flash fade (td.price has a background transition).
            setTimeout(function () {
                tbody.querySelectorAll('.tick-up, .tick-down').forEach(function (el) { el.classList.remove('tick-up', 'tick-down'); });
            }, 700);
        }

        function renderOrders(data) {
            const tbody = q('orders-body');
            if (!Array.isArray(data) || data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="loading-row">No recent orders.</td></tr>';
                return;
            }
            tbody.innerHTML = data.map(function (o) {
                const sideCls = o.side === 'buy' ? 'side-buy' : 'side-sell';
                return '<tr>' +
                    '<td class="mono-sm">' + fmtDate(o.created_at) + '</td>' +
                    '<td class="sym">' + escHtml(o.symbol) + '</td>' +
                    '<td class="' + sideCls + '">' + escHtml((o.side || '').toUpperCase()) + '</td>' +
                    '<td>' + escHtml(o.qty || o.filled_qty || (o.notional ? fmt$(o.notional) : '')) + '</td>' +
                    '<td>' + escHtml((o.type || '').toUpperCase()) + '</td>' +
                    '<td class="status-' + escHtml(o.status) + '">' + escHtml((o.status || '').toUpperCase()) + '</td>' +
                    '<td>' + (o.filled_avg_price ? fmt$(o.filled_avg_price) : '—') + '</td>' +
                    '</tr>';
            }).join('');
        }

        // ── Apply paper positions to the live account ─────────────────────────
        let pendingOrders = [];

        async function openApplyModal() {
            q('apply-modal').style.display = 'flex';
            q('modal-result').style.display = 'none';
            q('modal-confirm-btn').disabled = false;
            q('modal-confirm-btn').textContent = 'CONFIRM — PLACE ORDERS';
            q('modal-paper-rows').innerHTML = 'Loading...';
            q('modal-personal-balance').innerHTML = 'Loading...';
            q('modal-orders-rows').innerHTML = '';
            pendingOrders = [];

            // Source = the paper wallet on screen; target = the live wallet.
            const [posRes, liveRes] = await Promise.all([
                fetch(walletApi(currentWallet, '/positions')),
                fetch(walletApi('live', '/account')),
            ]);
            const positions = posRes.ok ? await posRes.json() : [];
            const liveAcct = await liveRes.json().catch(function () { return null; });

            if (!Array.isArray(positions) || positions.length === 0) {
                q('modal-paper-rows').innerHTML = '<span class="modal-none">No open paper positions.</span>';
                q('modal-orders-rows').innerHTML = '<span class="modal-none">Nothing to apply.</span>';
                q('modal-confirm-btn').disabled = true;
                return;
            }

            q('modal-paper-rows').innerHTML =
                '<table><thead><tr><th>SYMBOL</th><th>QTY</th><th>MKT VALUE</th><th>UNREAL P&amp;L</th></tr></thead><tbody>' +
                positions.map(function (p) {
                    return '<tr><td class="sym">' + escHtml(p.symbol) + '</td><td>' + escHtml(p.qty) + '</td>' +
                        '<td>' + fmt$(p.market_value) + '</td>' +
                        '<td class="' + (parseFloat(p.unrealized_pl) >= 0 ? 'pos' : 'neg') + '">' + fmt$(p.unrealized_pl) + '</td></tr>';
                }).join('') + '</tbody></table>';

            if (liveRes.ok && liveAcct && !liveAcct.error) {
                q('modal-personal-balance').innerHTML =
                    'Equity: <strong>' + fmt$(liveAcct.equity) + '</strong> &nbsp;|&nbsp; Buying Power: <strong>' + fmt$(liveAcct.buying_power) + '</strong>';
            } else {
                q('modal-personal-balance').innerHTML = '<span class="modal-err">' +
                    escHtml((liveAcct && liveAcct.error) || 'Could not load the live account. Check your API keys on the Profile page.') + '</span>';
            }

            // Proposed orders: market buy, notional = paper market value.
            pendingOrders = positions.map(function (p) {
                return { symbol: p.symbol, notional: Math.abs(parseFloat(p.market_value)) };
            });
            q('modal-orders-rows').innerHTML =
                '<table><thead><tr><th>SYMBOL</th><th>SIDE</th><th>NOTIONAL</th></tr></thead><tbody>' +
                pendingOrders.map(function (o) {
                    return '<tr><td class="sym">' + escHtml(o.symbol) + '</td><td class="side-buy">BUY</td><td>' + fmt$(o.notional) + '</td></tr>';
                }).join('') + '</tbody></table>';
        }

        function closeApplyModal() {
            q('apply-modal').style.display = 'none';
        }

        async function confirmApply() {
            if (!pendingOrders.length) return;

            // MUR-62: real-money orders require an explicit, per-trade interactive
            // confirmation typed by the board member. The phrase is also sent as a
            // header so the server can reject non-interactive / agent callers.
            const CONFIRM_PHRASE = 'I CONFIRM LIVE ORDERS';
            const typed = window.prompt(
                'LIVE REAL-MONEY ORDERS\\n\\nThis places real orders on your live Alpaca account.\\nType exactly the following to confirm:\\n\\n' + CONFIRM_PHRASE
            );
            const resultEl = q('modal-result');
            if (typed !== CONFIRM_PHRASE) {
                resultEl.style.display = 'block';
                resultEl.innerHTML = '<span class="modal-err">Cancelled — confirmation phrase not entered.</span>';
                return;
            }

            const btn = q('modal-confirm-btn');
            btn.disabled = true;
            btn.textContent = 'Placing orders...';

            const r = await fetch('/admin/alpaca/api/apply-to-personal?token=' + TOKEN, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Live-Apply-Confirm': CONFIRM_PHRASE },
                body: JSON.stringify({ orders: pendingOrders, confirmation: CONFIRM_PHRASE }),
            });
            const data = await r.json().catch(function () { return {}; });
            resultEl.style.display = 'block';

            if (!r.ok || data.error) {
                resultEl.innerHTML = '<span class="modal-err">Error: ' + escHtml(data.error || r.status) + '</span>';
                return;
            }
            resultEl.innerHTML = data.results.map(function (res) {
                return '<div class="' + (res.ok ? 'modal-ok' : 'modal-err') + '">' + (res.ok ? '✓' : '✗') + ' ' +
                    escHtml(res.symbol) + ' — ' + escHtml(res.ok ? 'Order ' + res.orderId : res.error) + '</div>';
            }).join('');
            btn.textContent = 'Done';
        }

        // ── Charts ───────────────────────────────────────────────────────────
        let currentRange = '1D';
        const RANGE_TIMEFRAME = { '1D': '15Min', '1W': '1H', '1M': '1D', '3M': '1D', 'ALL': '1D' };
        // Window (ms) bounding what the chart will display in each range.
        const RANGE_MS = {
            '1D': 24 * 60 * 60 * 1000,
            '1W': 7  * 24 * 60 * 60 * 1000,
            '1M': 30 * 24 * 60 * 60 * 1000,
            '3M': 90 * 24 * 60 * 60 * 1000,
        };
        // Time scale "unit" per range (drives how Chart.js spaces / formats ticks).
        const RANGE_UNIT = { '1D': 'hour', '1W': 'day', '1M': 'day', '3M': 'week', 'ALL': 'month' };
        const charts = { equity: null, pl: null, positions: null };

        const chartFontFamily = "'Courier New', monospace";
        const gridColor = '#222';
        const tickColor = '#666';

        function rangeBounds() {
            const max = Date.now();
            const span = RANGE_MS[currentRange];
            return { min: span ? max - span : undefined, max: max };
        }

        function baseChartOpts(yFmt) {
            const { min, max } = rangeBounds();
            return {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                resizeDelay: 100,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: '#000',
                        borderColor: '#0d9488',
                        borderWidth: 1,
                        titleColor: '#0d9488',
                        bodyColor: '#e0e0e0',
                        titleFont: { family: chartFontFamily, size: 11 },
                        bodyFont: { family: chartFontFamily, size: 11 },
                        callbacks: yFmt ? { label: function(ctx) {
                            const lbl = ctx.dataset.label ? ctx.dataset.label + ': ' : '';
                            return lbl + yFmt(ctx.parsed.y);
                        } } : undefined,
                    },
                },
                scales: {
                    x: {
                        type: 'time',
                        min: min,
                        max: max,
                        time: {
                            unit: RANGE_UNIT[currentRange] || 'day',
                            tooltipFormat: currentRange === '1D' ? 'MMM d, h:mm a' : 'MMM d, yyyy',
                            displayFormats: {
                                hour: 'h a',
                                day:  'MMM d',
                                week: 'MMM d',
                                month: 'MMM yyyy',
                            },
                        },
                        grid: { color: gridColor, drawBorder: false },
                        ticks: { color: tickColor, font: { family: chartFontFamily, size: 9 }, maxRotation: 0, autoSkipPadding: 20 },
                    },
                    y: {
                        grid: { color: gridColor, drawBorder: false },
                        ticks: {
                            color: tickColor,
                            font: { family: chartFontFamily, size: 9 },
                            callback: function(v) { return yFmt ? yFmt(v) : v; },
                        },
                    },
                },
            };
        }

        function fmtCompact(v) {
            const n = Number(v);
            if (!isFinite(n)) return '—';
            const a = Math.abs(n);
            if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
            if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'k';
            return '$' + n.toFixed(0);
        }

        // Replace a chart with a one-line message drawn on its canvas.
        function chartMessage(canvasId, key, msg) {
            if (charts[key]) { charts[key].destroy(); charts[key] = null; }
            const canvasEl = q(canvasId);
            // Size the backing store to the element, or CSS stretches the text.
            const dpr = window.devicePixelRatio || 1;
            const w = canvasEl.clientWidth, h = canvasEl.clientHeight;
            canvasEl.width = w * dpr;
            canvasEl.height = h * dpr;
            const ctx = canvasEl.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);
            ctx.fillStyle = '#555';
            ctx.font = '11px ' + chartFontFamily;
            ctx.textAlign = 'center';
            ctx.fillText(msg, w / 2, h / 2);
        }

        function upsertChart(key, canvasId, data, opts) {
            if (charts[key]) {
                charts[key].data = data;
                charts[key].options = opts;
                charts[key].update();
            } else {
                charts[key] = new Chart(q(canvasId).getContext('2d'), { type: 'line', data: data, options: opts });
            }
        }

        async function loadHistoryChart() {
            const wallet = currentWallet;
            const tf = RANGE_TIMEFRAME[currentRange] || '1D';
            const period = currentRange === 'ALL' ? 'all' : currentRange;
            let h;
            try {
                const r = await fetch(walletApi(wallet, '/history?period=' + period + '&timeframe=' + tf));
                h = await r.json();
            } catch (e) { h = { error: e.message }; }
            if (wallet !== currentWallet) return;
            if (!h || h.error || !Array.isArray(h.timestamp)) {
                const msg = 'History unavailable' + (h && h.error ? ': ' + h.error : '');
                chartMessage('chart-equity', 'equity', msg);
                chartMessage('chart-pl', 'pl', msg);
                return;
            }

            const bounds = rangeBounds();
            const equityPts = [];
            const plPts = [];
            for (let i = 0; i < h.timestamp.length; i++) {
                const t = h.timestamp[i] * 1000;
                if (bounds.min !== undefined && t < bounds.min) continue;
                if (t > bounds.max) continue;
                if (h.equity && h.equity[i] != null)         equityPts.push({ x: t, y: h.equity[i] });
                if (h.profit_loss && h.profit_loss[i] != null) plPts.push({ x: t, y: h.profit_loss[i] });
            }

            upsertChart('equity', 'chart-equity', {
                datasets: [{
                    label: 'Equity',
                    data: equityPts,
                    borderColor: '#0d9488',
                    backgroundColor: 'rgba(13, 148, 136, 0.1)',
                    fill: true,
                    pointRadius: 0,
                    borderWidth: 1.5,
                    tension: 0.2,
                }],
            }, baseChartOpts(fmtCompact));

            // Cumulative P&L line (color based on last value within window)
            const finalPl = plPts.length ? plPts[plPts.length - 1].y : 0;
            upsertChart('pl', 'chart-pl', {
                datasets: [{
                    label: 'P&L',
                    data: plPts,
                    borderColor: finalPl >= 0 ? '#10b981' : '#ef4444',
                    backgroundColor: finalPl >= 0 ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                    fill: 'origin',
                    pointRadius: 0,
                    borderWidth: 1.5,
                    tension: 0.2,
                }],
            }, baseChartOpts(fmtCompact));
        }

        const POSITION_COLORS = ['#0d9488','#f97316','#fbbf24','#10b981','#3b82f6','#a855f7','#ec4899','#06b6d4','#eab308','#f43f5e'];

        async function loadPositionsChart() {
            if (currentWallet !== 'cloudclaw') {
                chartMessage('chart-positions', 'positions', 'Position snapshots are recorded for the Cloud-Claw paper wallet only.');
                return;
            }
            const r = await fetch('/admin/alpaca/api/snapshots?period=' + currentRange + '&token=' + TOKEN);
            const snaps = await r.json();
            if (currentWallet !== 'cloudclaw') return;
            if (!Array.isArray(snaps) || snaps.length === 0) {
                chartMessage('chart-positions', 'positions', 'No snapshots yet — the server records one every 5 min.');
                return;
            }

            // Collect all symbols seen across snapshots
            const symbols = [];
            const seen = new Set();
            snaps.forEach(function(s) {
                (s.positions || []).forEach(function(p) {
                    if (!seen.has(p.symbol)) { seen.add(p.symbol); symbols.push(p.symbol); }
                });
            });

            const datasets = symbols.map(function(sym, i) {
                const color = POSITION_COLORS[i % POSITION_COLORS.length];
                return {
                    label: sym,
                    data: snaps.map(function(s) {
                        const p = (s.positions || []).find(function(x) { return x.symbol === sym; });
                        return { x: new Date(s.ts).getTime(), y: p ? p.market_value : 0 };
                    }),
                    borderColor: color,
                    backgroundColor: color + '55',
                    fill: true,
                    pointRadius: 0,
                    borderWidth: 1,
                    tension: 0.2,
                };
            });

            const opts = baseChartOpts(fmtCompact);
            opts.plugins.legend = {
                display: true,
                position: 'bottom',
                labels: { color: '#888', font: { family: chartFontFamily, size: 10 }, boxWidth: 10 },
            };
            opts.scales.y.stacked = true;
            upsertChart('positions', 'chart-positions', { datasets: datasets }, opts);
        }

        function bindRangeButtons() {
            document.querySelectorAll('.range-btn').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    document.querySelectorAll('.range-btn').forEach(function(b) { b.classList.remove('active'); });
                    btn.classList.add('active');
                    currentRange = btn.dataset.range;
                    loadCharts();
                });
            });
        }

        async function loadCharts() {
            if (!currentWallet) return;
            await Promise.all([loadHistoryChart(), loadPositionsChart()]);
        }

        bindRangeButtons();
        loadWallets();
        // Account, positions and orders arrive live over the stream; the charts
        // are history, so a slow refresh is plenty.
        setInterval(loadCharts, 5 * 60 * 1000);
        </script>
    `;

    const extraStyles = `
        body { align-items: stretch; padding-top: 60px; overflow: hidden; }

        .alpaca-layout {
            width: 100%;
            height: calc(100vh - 60px);
            overflow-y: auto;
            padding: 1.25rem 2rem;
            box-sizing: border-box;
            position: relative;
            z-index: 95;
            display: flex;
            flex-direction: column;
            gap: 1.25rem;
        }
        .alpaca-layout::-webkit-scrollbar { width: 6px; }
        .alpaca-layout::-webkit-scrollbar-thumb { background: #333; }

        .alpaca-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding-bottom: 0.75rem;
            border-bottom: 2px solid #333;
        }
        .alpaca-title {
            font-size: 1rem;
            font-weight: bold;
            letter-spacing: 3px;
            color: #0d9488;
        }
        .alpaca-controls { display: flex; align-items: center; gap: 1rem; }
        .last-updated { font-size: 0.7rem; color: #555; letter-spacing: 1px; }
        .refresh-btn {
            background: transparent;
            border: 1px solid #444;
            color: #888;
            padding: 0.3rem 0.75rem;
            font-family: inherit;
            font-size: 0.75rem;
            letter-spacing: 1px;
            cursor: pointer;
            transition: all 0.2s;
        }
        .refresh-btn:hover { border-color: #0d9488; color: #0d9488; }

        .stats-row {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 1rem;
        }
        .stat-box {
            background: #1e1e1e;
            border: 1px solid #333;
            padding: 1rem 1.25rem;
            display: flex;
            flex-direction: column;
            gap: 0.25rem;
        }
        .stat-label { font-size: 0.65rem; color: #555; letter-spacing: 2px; }
        .stat-value { font-size: 1.4rem; font-weight: bold; color: #e0e0e0; }
        .stat-sub { font-size: 0.75rem; color: #666; }
        .stat-value.pos { color: #10b981; }
        .stat-value.neg { color: #ef4444; }

        .section { display: flex; flex-direction: column; gap: 0.5rem; }
        .section-title {
            font-size: 0.7rem;
            letter-spacing: 2px;
            color: #0d9488;
            font-weight: bold;
        }
        .table-wrap { overflow-x: auto; }
        .table-wrap::-webkit-scrollbar { height: 4px; }
        .table-wrap::-webkit-scrollbar-thumb { background: #333; }

        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 0.8rem;
        }
        thead tr { border-bottom: 1px solid #333; }
        th {
            text-align: left;
            padding: 0.4rem 0.75rem;
            font-size: 0.65rem;
            color: #555;
            letter-spacing: 1px;
            white-space: nowrap;
        }
        td {
            padding: 0.45rem 0.75rem;
            color: #ccc;
            border-bottom: 1px solid #1a1a1a;
            white-space: nowrap;
        }
        tr:hover td { background: #1e1e1e; }
        .loading-row { color: #444; text-align: center; padding: 1.5rem; }
        .sym { color: #e0e0e0; font-weight: bold; }
        .mono-sm { font-size: 0.72rem; color: #888; }
        .pos { color: #10b981; }
        .neg { color: #ef4444; }
        .side-buy { color: #10b981; font-weight: bold; }
        .side-sell { color: #ef4444; font-weight: bold; }
        .status-filled { color: #10b981; }
        .status-canceled, .status-cancelled { color: #555; }
        .status-pending_new, .status-new { color: #f97316; }
        .status-partially_filled { color: #fbbf24; }

        .section-title-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .range-buttons { display: flex; gap: 0.4rem; }
        .range-btn {
            background: transparent;
            border: 1px solid #333;
            color: #666;
            padding: 0.25rem 0.6rem;
            font-family: inherit;
            font-size: 0.65rem;
            letter-spacing: 1px;
            cursor: pointer;
            transition: all 0.15s;
        }
        .range-btn:hover { color: #aaa; border-color: #555; }
        .range-btn.active {
            background: #0d9488;
            color: #000;
            border-color: #0d9488;
            font-weight: bold;
        }

        .charts-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 1rem;
        }
        .chart-card {
            background: #1e1e1e;
            border: 1px solid #333;
            padding: 0.75rem 1rem 1rem;
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
        }
        .chart-card.chart-wide { grid-column: 1 / -1; }
        .chart-label {
            font-size: 0.65rem;
            color: #555;
            letter-spacing: 2px;
        }
        .chart-canvas-wrap {
            position: relative;
            width: 100%;
            height: 200px;
        }
        .chart-canvas-wrap-tall { height: 260px; }
        .chart-canvas-wrap canvas {
            position: absolute;
            top: 0;
            left: 0;
            width: 100% !important;
            height: 100% !important;
        }

        /* Profile toggle */
        .profile-toggle {
            display: flex;
            border: 1px solid #444;
            overflow: hidden;
        }
        .profile-btn {
            background: transparent;
            border: none;
            color: #666;
            padding: 0.3rem 0.75rem;
            font-family: inherit;
            font-size: 0.7rem;
            letter-spacing: 1px;
            cursor: pointer;
            transition: all 0.15s;
        }
        .profile-btn:hover { color: #aaa; }
        .profile-btn.active { background: #0d9488; color: #000; font-weight: bold; }
        .profile-btn.unavailable { color: #444; text-decoration: line-through; }
        .profile-btn + .profile-btn { border-left: 1px solid #333; }
        .wallet-mode {
            font-size: 0.55rem;
            letter-spacing: 1px;
            padding: 0.05rem 0.3rem;
            border: 1px solid currentColor;
            margin-left: 0.2rem;
            vertical-align: middle;
        }
        .wallet-mode.mode-live { color: #f97316; }
        .profile-btn.active .wallet-mode.mode-live { color: #7c2d12; }

        /* Stream health */
        .live-pill {
            font-size: 0.65rem;
            letter-spacing: 1px;
            padding: 0.2rem 0.5rem;
            border: 1px solid #333;
            color: #666;
            white-space: nowrap;
            cursor: help;
        }
        .live-pill.pill-live { color: #10b981; border-color: #065f46; }
        .live-pill.pill-live::first-letter { animation: livepulse 1.6s ease-in-out infinite; }
        .live-pill.pill-degraded { color: #fbbf24; border-color: #78350f; }
        .live-pill.pill-reconnecting, .live-pill.pill-connecting { color: #888; }
        .live-pill.pill-error { color: #ef4444; border-color: #7f1d1d; }
        @keyframes livepulse { 50% { opacity: 0.25; } }

        .alpaca-banner {
            border: 1px solid #333;
            background: #111;
            padding: 0.6rem 0.9rem;
            font-size: 0.78rem;
            color: #ccc;
        }
        .alpaca-banner.err { border-color: #7f1d1d; color: #fca5a5; }
        .alpaca-banner a { color: #2dd4bf; margin-left: 0.25rem; }

        /* Price prints flash the CURRENT cell */
        td.price { transition: background-color 0.6s ease-out; }
        td.price.tick-up { background-color: rgba(16, 185, 129, 0.28); color: #10b981; }
        td.price.tick-down { background-color: rgba(239, 68, 68, 0.28); color: #ef4444; }

        /* Apply button */
        .apply-btn {
            background: #f97316;
            border: none;
            color: #000;
            padding: 0.3rem 0.9rem;
            font-family: inherit;
            font-size: 0.75rem;
            font-weight: bold;
            letter-spacing: 1px;
            cursor: pointer;
            transition: background 0.15s;
        }
        .apply-btn:hover { background: #fb923c; }

        /* Apply modal */
        .modal-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.8);
            z-index: 200;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 2rem;
        }
        .modal-box {
            background: #1e1e1e;
            border: 2px solid #444;
            width: 100%;
            max-width: 700px;
            max-height: 85vh;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 0;
        }
        .modal-box::-webkit-scrollbar { width: 4px; }
        .modal-box::-webkit-scrollbar-thumb { background: #333; }
        .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 1rem 1.25rem;
            border-bottom: 1px solid #333;
            font-size: 0.8rem;
            font-weight: bold;
            letter-spacing: 2px;
            color: #0d9488;
        }
        .modal-close {
            background: transparent;
            border: none;
            color: #666;
            font-size: 1rem;
            cursor: pointer;
            line-height: 1;
        }
        .modal-close:hover { color: #ef4444; }
        .modal-warning {
            background: #2d1a00;
            border-bottom: 1px solid #5a3a00;
            padding: 0.75rem 1.25rem;
            font-size: 0.75rem;
            color: #f97316;
            font-weight: bold;
        }
        .modal-section { padding: 0.75rem 1.25rem; border-bottom: 1px solid #1a1a1a; }
        .modal-section-title { font-size: 0.6rem; letter-spacing: 2px; color: #555; margin-bottom: 0.6rem; }
        .modal-none { font-size: 0.8rem; color: #555; }
        .modal-err { font-size: 0.8rem; color: #ef4444; }
        .modal-ok  { font-size: 0.8rem; color: #10b981; }
        .modal-footer {
            display: flex;
            justify-content: flex-end;
            gap: 0.75rem;
            padding: 1rem 1.25rem;
        }
        .modal-cancel-btn {
            background: transparent;
            border: 1px solid #444;
            color: #888;
            padding: 0.5rem 1.25rem;
            font-family: inherit;
            font-size: 0.75rem;
            letter-spacing: 1px;
            cursor: pointer;
        }
        .modal-cancel-btn:hover { border-color: #666; color: #aaa; }
        .modal-confirm-btn {
            background: #f97316;
            border: none;
            color: #000;
            padding: 0.5rem 1.5rem;
            font-family: inherit;
            font-size: 0.75rem;
            font-weight: bold;
            letter-spacing: 1px;
            cursor: pointer;
        }
        .modal-confirm-btn:hover:not(:disabled) { background: #fb923c; }
        .modal-confirm-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .modal-result {
            padding: 0.75rem 1.25rem;
            display: flex;
            flex-direction: column;
            gap: 0.3rem;
        }
    `;

    res.send(renderPage({
        token,
        title: 'Alpaca Dashboard',
        activePage: 'alpaca',
        content,
        extraStyles
    }));
});

// ── Paperclip control-plane page ─────────────────────────────────────────────
// Read-mostly dashboard over the Paperclip service (org, agents, budgets,
// costs, issues) with pause/resume + budget controls. Uses the shared client
// in services/paperclipClient.ts; when PAPERCLIP_BASE_URL is unset the page
// renders a "not configured" banner instead of erroring.

// Aggregated snapshot — each section fails independently so partial upstream
// outages still render whatever is available.
router.get('/paperclip/api/overview', async (_req, res) => {
    if (!paperclipConfigured()) {
        return res.json({ configured: false });
    }
    if (!PAPERCLIP_COMPANY_ID) {
        return res.json({ configured: true, companyId: null });
    }
    const cid = PAPERCLIP_COMPANY_ID;
    const [org, agents, costs, issues] = await Promise.all([
        pcFetch(`/api/companies/${cid}/org`),
        pcFetch(`/api/companies/${cid}/agents`),
        pcFetch(`/api/companies/${cid}/costs/summary`),
        pcFetch(`/api/companies/${cid}/issues`),
    ]);
    res.json({
        configured: true,
        companyId: cid,
        org: org.error ? { error: org.error } : org.data,
        agents: agents.error ? { error: agents.error } : agents.data,
        costs: costs.error ? { error: costs.error } : costs.data,
        issues: issues.error ? { error: issues.error } : issues.data,
    });
});

router.post('/paperclip/api/agents/:id/pause', async (req, res) => {
    const result = await pcFetch(`/api/agents/${req.params.id}/pause`, { method: 'POST' });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.data);
});

router.post('/paperclip/api/agents/:id/resume', async (req, res) => {
    const result = await pcFetch(`/api/agents/${req.params.id}/resume`, { method: 'POST' });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.data);
});

router.post('/paperclip/api/agents/:id/budget', async (req, res) => {
    const { budgetMonthlyCents } = req.body as { budgetMonthlyCents?: number };
    if (typeof budgetMonthlyCents !== 'number' || budgetMonthlyCents < 0) {
        return res.status(400).json({ error: 'budgetMonthlyCents (non-negative number) is required' });
    }
    const result = await pcFetch(`/api/agents/${req.params.id}/budgets`, {
        method: 'PATCH',
        body: JSON.stringify({ budgetMonthlyCents }),
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.data);
});

router.get('/paperclip', (req: any, res) => {
    const token = req.query.token as string;

    const content = `
        <div class="pc-wrap">
            <div id="pc-banner" class="pc-banner hidden"></div>

            <div class="pc-grid">
                <div class="pc-card pc-span2">
                    <div class="pc-card-head">
                        <h2>AGENTS</h2>
                        <button class="btn" id="pc-refresh">REFRESH</button>
                    </div>
                    <table class="pc-table" id="pc-agents">
                        <thead>
                            <tr><th>NAME</th><th>ROLE</th><th>STATUS</th><th>BUDGET/MO</th><th>ACTIONS</th></tr>
                        </thead>
                        <tbody><tr><td colspan="5" class="pc-muted">Loading…</td></tr></tbody>
                    </table>
                </div>

                <div class="pc-card">
                    <div class="pc-card-head"><h2>COSTS</h2></div>
                    <div id="pc-costs" class="pc-muted">Loading…</div>
                </div>

                <div class="pc-card">
                    <div class="pc-card-head"><h2>ISSUES</h2></div>
                    <div id="pc-issues" class="pc-muted">Loading…</div>
                </div>
            </div>
        </div>

        <script>
            const TOKEN = '${token}';
            const $ = (id) => document.getElementById(id);

            const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            })[c]);

            const dollars = (cents) => (typeof cents === 'number')
                ? '$' + (cents / 100).toFixed(2)
                : '—';

            function banner(msg, kind) {
                const b = $('pc-banner');
                b.textContent = msg;
                b.className = 'pc-banner ' + (kind || '');
            }

            async function api(path, opts) {
                const sep = path.includes('?') ? '&' : '?';
                const r = await fetch('/admin/paperclip/api' + path + sep + 'token=' + TOKEN, opts);
                const data = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
                return data;
            }

            function renderAgents(agentsRaw) {
                const tbody = $('pc-agents').querySelector('tbody');
                if (agentsRaw && agentsRaw.error) {
                    tbody.innerHTML = '<tr><td colspan="5" class="pc-err">' + esc(agentsRaw.error) + '</td></tr>';
                    return;
                }
                const list = Array.isArray(agentsRaw) ? agentsRaw : (agentsRaw?.agents ?? agentsRaw?.items ?? []);
                if (!list.length) {
                    tbody.innerHTML = '<tr><td colspan="5" class="pc-muted">No agents.</td></tr>';
                    return;
                }
                tbody.innerHTML = list.map((a) => {
                    const status = String(a.status ?? 'unknown').toLowerCase();
                    const paused = status === 'paused';
                    return '<tr>' +
                        '<td>' + esc(a.name ?? a.id) + '</td>' +
                        '<td>' + esc(a.role ?? a.title ?? '—') + '</td>' +
                        '<td><span class="pc-status pc-status-' + esc(status) + '">' + esc(status.toUpperCase()) + '</span></td>' +
                        '<td>' + dollars(a.budgetMonthlyCents) + '</td>' +
                        '<td>' +
                            '<button class="btn btn-sm" data-act="' + (paused ? 'resume' : 'pause') + '" data-id="' + esc(a.id) + '">' + (paused ? 'RESUME' : 'PAUSE') + '</button> ' +
                            '<button class="btn btn-sm" data-act="budget" data-id="' + esc(a.id) + '" data-budget="' + (a.budgetMonthlyCents ?? 0) + '">BUDGET</button>' +
                        '</td>' +
                    '</tr>';
                }).join('');
            }

            function renderCosts(costsRaw) {
                const el = $('pc-costs');
                if (costsRaw && costsRaw.error) { el.innerHTML = '<span class="pc-err">' + esc(costsRaw.error) + '</span>'; return; }
                if (costsRaw == null) { el.innerHTML = '<span class="pc-muted">No data.</span>'; return; }
                // Render whatever numeric summary fields exist; fall back to raw JSON.
                const entries = Object.entries(costsRaw).filter(([, v]) => typeof v === 'number' || typeof v === 'string');
                el.innerHTML = entries.length
                    ? '<dl class="pc-dl">' + entries.map(([k, v]) =>
                        '<dt>' + esc(k) + '</dt><dd>' + esc(/cents/i.test(k) && typeof v === 'number' ? dollars(v) : v) + '</dd>'
                      ).join('') + '</dl>'
                    : '<pre class="pc-pre">' + esc(JSON.stringify(costsRaw, null, 2)) + '</pre>';
            }

            function renderIssues(issuesRaw) {
                const el = $('pc-issues');
                if (issuesRaw && issuesRaw.error) { el.innerHTML = '<span class="pc-err">' + esc(issuesRaw.error) + '</span>'; return; }
                const list = Array.isArray(issuesRaw) ? issuesRaw : (issuesRaw?.issues ?? issuesRaw?.items ?? []);
                if (!list.length) { el.innerHTML = '<span class="pc-muted">No issues.</span>'; return; }
                el.innerHTML = '<ul class="pc-issue-list">' + list.slice(0, 10).map((i) =>
                    '<li><span class="pc-status">' + esc(String(i.status ?? '?').toUpperCase()) + '</span> ' + esc(i.title ?? i.id ?? '') + '</li>'
                ).join('') + '</ul>';
            }

            // Every card always ends in a real state — never left on "Loading…".
            function setAllCards(msg, cls) {
                const cell = '<span class="' + cls + '">' + esc(msg) + '</span>';
                $('pc-agents').querySelector('tbody').innerHTML = '<tr><td colspan="5">' + cell + '</td></tr>';
                $('pc-costs').innerHTML = cell;
                $('pc-issues').innerHTML = cell;
            }

            async function load() {
                const btn = $('pc-refresh');
                btn.disabled = true;
                btn.textContent = 'LOADING…';
                try {
                    const o = await api('/overview');
                    if (!o.configured) {
                        banner('Paperclip is not configured on this environment (PAPERCLIP_BASE_URL is unset). See .aws/PAPERCLIP_SERVICE.md.', 'warn');
                        setAllCards('Not configured.', 'pc-muted');
                        return;
                    }
                    if (!o.companyId) {
                        banner('PAPERCLIP_COMPANY_ID is not set — service is reachable but no company is selected.', 'warn');
                        setAllCards('No company selected.', 'pc-muted');
                        return;
                    }
                    const failed = ['agents', 'costs', 'issues'].filter((k) => o[k] && o[k].error);
                    if (failed.length === 3) banner('Paperclip is configured but every request failed: ' + o.agents.error, 'err');
                    else if (failed.length) banner('Connected — company ' + o.companyId + ' (some sections failed to load)', 'warn');
                    else banner('Connected — company ' + o.companyId + ' · loaded ' + new Date().toLocaleTimeString(), 'ok');
                    renderAgents(o.agents);
                    renderCosts(o.costs);
                    renderIssues(o.issues);
                } catch (e) {
                    banner('Error: ' + e.message, 'err');
                    setAllCards('Could not load: ' + e.message, 'pc-err');
                } finally {
                    btn.disabled = false;
                    btn.textContent = 'REFRESH';
                }
            }

            $('pc-agents').addEventListener('click', async (ev) => {
                const btn = ev.target.closest('button[data-act]');
                if (!btn) return;
                const id = btn.dataset.id;
                try {
                    if (btn.dataset.act === 'budget') {
                        const current = (Number(btn.dataset.budget) / 100).toFixed(2);
                        const input = prompt('Monthly budget in dollars:', current);
                        if (input == null) return;
                        const cents = Math.round(parseFloat(input) * 100);
                        if (!Number.isFinite(cents) || cents < 0) { banner('Invalid budget amount', 'err'); return; }
                        await api('/agents/' + encodeURIComponent(id) + '/budget', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ budgetMonthlyCents: cents }),
                        });
                    } else {
                        await api('/agents/' + encodeURIComponent(id) + '/' + btn.dataset.act, { method: 'POST' });
                    }
                    await load();
                } catch (e) {
                    banner('Error: ' + e.message, 'err');
                }
            });

            $('pc-refresh').addEventListener('click', load);
            load();
        </script>
    `;

    const extraStyles = `
        body { align-items: flex-start; justify-content: center; overflow-y: auto; }
        .pc-wrap { width: 90%; max-width: 1100px; padding: 2rem 0; position: relative; z-index: 95; }
        .hidden { display: none; }

        .pc-banner {
            border: 1px solid #333; padding: 0.75rem 1rem; margin-bottom: 1.5rem;
            font-size: 0.85rem; letter-spacing: 0.5px; background: #111;
        }
        .pc-banner.ok   { border-color: #0d9488; color: #2dd4bf; }
        .pc-banner.warn { border-color: #f97316; color: #fdba74; }
        .pc-banner.err  { border-color: #dc2626; color: #fca5a5; }

        .pc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
        .pc-span2 { grid-column: span 2; }
        .pc-card { background: #111; border: 1px solid #333; padding: 1rem 1.25rem; }
        .pc-card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }
        .pc-card-head h2 { margin: 0; font-size: 1rem; letter-spacing: 2px; color: #f97316; }

        .btn {
            background: #000; color: #e0e0e0; border: 1px solid #555;
            font-family: inherit; font-size: 0.75rem; letter-spacing: 1px;
            padding: 0.35rem 0.75rem;
        }
        .btn:hover { border-color: #0d9488; color: #2dd4bf; }
        .btn-sm { padding: 0.2rem 0.5rem; font-size: 0.7rem; }

        .pc-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
        .pc-table th { text-align: left; color: #888; font-size: 0.7rem; letter-spacing: 1px; border-bottom: 1px solid #333; padding: 0.4rem 0.5rem; }
        .pc-table td { border-bottom: 1px solid #222; padding: 0.5rem; }

        .pc-status { font-size: 0.7rem; letter-spacing: 1px; padding: 0.1rem 0.4rem; border: 1px solid #555; }
        .pc-status-active, .pc-status-running { border-color: #0d9488; color: #2dd4bf; }
        .pc-status-paused { border-color: #f97316; color: #fdba74; }
        .pc-status-error, .pc-status-failed { border-color: #dc2626; color: #fca5a5; }

        .pc-muted { color: #666; }
        .pc-err { color: #fca5a5; }
        .pc-dl { display: grid; grid-template-columns: auto 1fr; gap: 0.25rem 1rem; margin: 0; font-size: 0.85rem; }
        .pc-dl dt { color: #888; }
        .pc-dl dd { margin: 0; }
        .pc-pre { font-size: 0.75rem; color: #aaa; white-space: pre-wrap; user-select: text !important; }
        .pc-issue-list { list-style: none; margin: 0; padding: 0; font-size: 0.85rem; }
        .pc-issue-list li { padding: 0.35rem 0; border-bottom: 1px solid #222; }
    `;

    res.send(renderPage({
        token,
        title: 'Paperclip Control Plane',
        activePage: 'paperclip',
        content,
        extraStyles
    }));
});

// ── Profile / API Key Vault page ──────────────────────────────────────────────

router.get('/profile', (req: any, res) => {
    const token = req.query.token as string;

    const PROVIDER_LABELS: Record<string, string> = {
        alpaca_live:  'Alpaca Live',
        alpaca_paper: 'Alpaca Paper',
        google:       'Google OAuth',
        discord:      'Discord OAuth',
    };

    const content = `
        <div class="profile-layout">
            <div class="profile-header">
                <div class="profile-title">PROFILE // API KEY VAULT</div>
                <div class="profile-sub">Keys are encrypted at rest with AES-256-GCM. Secrets are never returned after storage.</div>
            </div>
            <div class="section">
                <div class="section-title">&#9632; STORED KEYS</div>
                <div id="keys-list"><span class="loading-row">Loading...</span></div>
            </div>
            <div class="section">
                <div class="section-title">&#9632; ADD / UPDATE KEY</div>
                <div class="key-form">
                    <div class="form-row">
                        <label>PROVIDER</label>
                        <select id="provider-select">
                            <option value="alpaca_live">Alpaca - Live Account</option>
                            <option value="alpaca_paper">Alpaca - Paper Account</option>
                            <option value="google">Google OAuth</option>
                            <option value="discord">Discord OAuth</option>
                        </select>
                    </div>
                    <div class="form-row">
                        <label>LABEL (optional)</label>
                        <input id="key-label" type="text" placeholder="e.g. My Alpaca Live Account" autocomplete="off" />
                    </div>
                    <div class="form-row">
                        <label>KEY ID / CLIENT ID</label>
                        <input id="key-id" type="text" placeholder="Paste your key ID here" autocomplete="off" />
                    </div>
                    <div class="form-row">
                        <label>SECRET KEY / CLIENT SECRET</label>
                        <input id="key-secret" type="password" placeholder="Paste your secret here" autocomplete="off" />
                    </div>
                    <div class="form-actions">
                        <button onclick="saveKey()">SAVE KEY</button>
                        <span id="save-status" class="save-status"></span>
                    </div>
                </div>
            </div>
        </div>

        <script>
        const TOKEN = '${token}';
        const LABELS = ${JSON.stringify(PROVIDER_LABELS)};

        async function loadKeys() {
            var r = await fetch('/api/api-keys', { headers: { 'Authorization': 'Bearer ' + TOKEN } });
            if (!r.ok) { document.getElementById('keys-list').innerHTML = '<span class="err">Failed to load keys.</span>'; return; }
            var data = await r.json();
            if (!data.length) {
                document.getElementById('keys-list').innerHTML = '<span class="loading-row">No keys stored yet.</span>';
                return;
            }
            var rows = '';
            data.forEach(function(k) {
                rows += '<tr>' +
                    '<td class="sym">' + escHtml(LABELS[k.provider] || k.provider) + '</td>' +
                    '<td>' + escHtml(k.label || '\\u2014') + '</td>' +
                    '<td class="mono-sm">' + escHtml(k.keyIdPreview) + '</td>' +
                    '<td class="mono-sm">' + fmtDate(k.updatedAt) + '</td>' +
                    '<td><button class="delete-btn" onclick="deleteKey(' + "'" + escHtml(k.provider) + "'" + ')">DELETE</button></td>' +
                    '</tr>';
            });
            document.getElementById('keys-list').innerHTML =
                '<table><thead><tr><th>PROVIDER</th><th>LABEL</th><th>KEY ID (PREVIEW)</th><th>UPDATED</th><th></th></tr></thead>' +
                '<tbody>' + rows + '</tbody></table>';
        }

        async function saveKey() {
            var provider = document.getElementById('provider-select').value;
            var label    = document.getElementById('key-label').value.trim();
            var keyId    = document.getElementById('key-id').value.trim();
            var secret   = document.getElementById('key-secret').value.trim();
            var status   = document.getElementById('save-status');
            if (!keyId || !secret) { status.textContent = 'KEY ID and SECRET are required.'; status.className = 'save-status err'; return; }
            status.textContent = 'Saving...'; status.className = 'save-status';
            var r = await fetch('/api/api-keys/' + encodeURIComponent(provider), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
                body: JSON.stringify({ keyId: keyId, secret: secret, label: label }),
            });
            if (r.ok) {
                status.textContent = 'Saved.'; status.className = 'save-status ok';
                document.getElementById('key-id').value = '';
                document.getElementById('key-secret').value = '';
                loadKeys();
            } else {
                var d = await r.json().catch(function() { return {}; });
                status.textContent = 'Error: ' + (d.error || r.status); status.className = 'save-status err';
            }
        }

        async function deleteKey(provider) {
            if (!confirm('Delete ' + provider + ' keys? This cannot be undone.')) return;
            var r = await fetch('/api/api-keys/' + encodeURIComponent(provider), {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer ' + TOKEN },
            });
            if (r.ok) loadKeys();
        }

        function fmtDate(s) {
            if (!s) return '\\u2014';
            var d = new Date(s);
            return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        }
        function escHtml(s) { var d = document.createElement('div'); d.textContent = String(s || ''); return d.innerHTML; }

        loadKeys();
        </script>
    `;

    const extraStyles = `
        body { align-items: stretch; padding-top: 60px; }
        .profile-layout {
            width: 100%; max-width: 800px; margin: 0 auto; padding: 2rem;
            box-sizing: border-box; position: relative; z-index: 95;
            display: flex; flex-direction: column; gap: 2rem;
        }
        .profile-header { display: flex; flex-direction: column; gap: 0.4rem; border-bottom: 2px solid #333; padding-bottom: 1rem; }
        .profile-title { font-size: 1rem; font-weight: bold; letter-spacing: 3px; color: #0d9488; }
        .profile-sub { font-size: 0.75rem; color: #555; }
        .section { display: flex; flex-direction: column; gap: 0.75rem; }
        .section-title { font-size: 0.7rem; letter-spacing: 2px; color: #0d9488; font-weight: bold; }
        table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
        thead tr { border-bottom: 1px solid #333; }
        th { text-align: left; padding: 0.4rem 0.75rem; font-size: 0.65rem; color: #555; letter-spacing: 1px; white-space: nowrap; }
        td { padding: 0.45rem 0.75rem; color: #ccc; border-bottom: 1px solid #1a1a1a; white-space: nowrap; }
        tr:hover td { background: #1e1e1e; }
        .sym { color: #e0e0e0; font-weight: bold; }
        .mono-sm { font-size: 0.72rem; color: #888; }
        .loading-row { color: #444; }
        .err { color: #ef4444; }
        .key-form { background: #1e1e1e; border: 1px solid #333; padding: 1.5rem; display: flex; flex-direction: column; gap: 1rem; }
        .form-row { display: flex; flex-direction: column; gap: 0.35rem; }
        .form-row label { font-size: 0.65rem; letter-spacing: 2px; color: #555; }
        .form-row input, .form-row select {
            background: #2b2b2b; border: 1px solid #444; color: #e0e0e0;
            padding: 0.5rem 0.75rem; font-family: 'Courier New', monospace;
            font-size: 0.85rem; outline: none; width: 100%; box-sizing: border-box;
        }
        .form-row input:focus, .form-row select:focus { border-color: #0d9488; }
        .form-row select option { background: #2b2b2b; }
        .form-actions { display: flex; align-items: center; gap: 1rem; margin-top: 0.25rem; }
        .form-actions button {
            background: #0d9488; border: none; color: #000; padding: 0.6rem 1.5rem;
            font-family: 'Courier New', monospace; font-weight: bold; letter-spacing: 2px; cursor: pointer;
        }
        .form-actions button:hover { background: #f97316; }
        .save-status { font-size: 0.8rem; color: #888; }
        .save-status.ok  { color: #10b981; }
        .save-status.err { color: #ef4444; }
        .delete-btn {
            background: transparent; border: 1px solid #444; color: #666;
            padding: 0.2rem 0.5rem; font-family: 'Courier New', monospace;
            font-size: 0.7rem; letter-spacing: 1px; cursor: pointer;
        }
        .delete-btn:hover { border-color: #ef4444; color: #ef4444; }
    `;

    res.send(renderPage({ token, title: 'Profile', activePage: 'profile', content, extraStyles }));
});

export default router;
