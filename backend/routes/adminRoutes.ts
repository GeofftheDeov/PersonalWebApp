import express from 'express';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { renderPage } from '../utils/adminUi.js';
import { renderMarkdown } from '../utils/markdown.js';
import AlpacaSnapshot from '../models/AlpacaSnapshot.js';

const router = express.Router();

// Middleware to verify token in query param - consistent with dbRoutes
const verifyToken = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const token = req.query.token as string;
    const loginUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/login`;

    if (!token) {
        console.log(`[AUTH] 401: No token provided for ${req.originalUrl}`);
        return res.redirect('/login');
    }

    try {
        jwt.verify(token, process.env.JWT_SECRET || "your-secret-key-change-this");
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
                <!-- Placeholder for future admin tools -->
                <a href="/admin/cloud-claw?token=${token}" class="nav-btn">
                    Cloud-Claw Trading Agent
                </a>
                <a href="/admin/obsidian?token=${token}" class="nav-btn">
                    Obsidian Vault
                </a>
                <a href="/admin/alpaca?token=${token}" class="nav-btn">
                    Alpaca Dashboard
                </a>
                <a href="#" class="nav-btn" style="opacity: 0.5; pointer-events: none; border-style: dashed;">
                    User Management (Coming Soon)
                </a>
            </div>
            <div class="status">
                SYSTEM STATUS: ONLINE // AUTH: SECURE
            </div>
        </div>
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
    if (!vaultPath) return res.status(503).json({ error: 'OBSIDIAN_VAULT_PATH not configured' });
    res.json({ tree: buildVaultTree(vaultPath) });
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

        async function loadTree() {
            try {
                const r = await fetch('/admin/obsidian/api/tree?token=' + TOKEN);
                const data = await r.json();
                fullTree = data.tree || [];
                renderTree(fullTree, document.getElementById('vault-tree'));
            } catch(e) {
                document.getElementById('vault-tree').innerHTML = '<span class="tree-loading">Failed to load vault.</span>';
            }
        }

        function renderTree(nodes, container, depth) {
            depth = depth || 0;
            container.innerHTML = '';
            const ul = document.createElement('ul');
            ul.className = 'tree-ul';
            nodes.forEach(function(node) {
                const li = document.createElement('li');
                if (node.type === 'dir') {
                    li.innerHTML = '<span class="tree-dir" data-path="' + node.path + '" style="padding-left:' + (depth*12) + 'px">&#9654; ' + escHtml(node.name) + '/</span>';
                    const childContainer = document.createElement('div');
                    childContainer.style.display = 'none';
                    childContainer.dataset.children = 'true';
                    renderTree(node.children || [], childContainer, depth + 1);
                    li.appendChild(childContainer);
                    li.querySelector('.tree-dir').addEventListener('click', function(e) {
                        e.stopPropagation();
                        const open = childContainer.style.display !== 'none';
                        childContainer.style.display = open ? 'none' : 'block';
                        this.innerHTML = (open ? '&#9654; ' : '&#9660; ') + escHtml(node.name) + '/';
                        this.style.paddingLeft = (depth*12) + 'px';
                    });
                } else {
                    li.innerHTML = '<span class="tree-file" data-path="' + node.path + '" style="padding-left:' + (depth*12+12) + 'px">&#128196; ' + escHtml(node.name) + '</span>';
                    li.querySelector('.tree-file').addEventListener('click', function() {
                        document.querySelectorAll('.tree-file').forEach(function(el) { el.classList.remove('active'); });
                        this.classList.add('active');
                        openFile(node.path);
                    });
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
            renderTree(filter(fullTree), document.getElementById('vault-tree'));
            document.querySelectorAll('.tree-dir').forEach(function(el) {
                el.nextElementSibling.style.display = 'block';
                el.innerHTML = '&#9660; ' + el.innerHTML.replace(/^&#9654; |^&#9660; /, '');
            });
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

// ── Alpaca API proxy (JSON, protected by verifyToken above) ──────────────────

const ALPACA_BASE = 'https://paper-api.alpaca.markets/v2';

function alpacaHeaders() {
    return {
        'APCA-API-KEY-ID': process.env.ALPACA_API_KEY || '',
        'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY || '',
        'Content-Type': 'application/json',
    };
}

async function alpacaGet(path: string): Promise<unknown> {
    const r = await fetch(`${ALPACA_BASE}${path}`, { headers: alpacaHeaders() });
    if (!r.ok) throw new Error(`Alpaca error (${path}): ${await r.text()}`);
    return r.json();
}

router.get('/alpaca/api/account', async (_req, res) => {
    try { res.json(await alpacaGet('/account')); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/alpaca/api/positions', async (_req, res) => {
    try { res.json(await alpacaGet('/positions')); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/alpaca/api/orders', async (_req, res) => {
    try { res.json(await alpacaGet('/orders?limit=20&status=all')); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Portfolio history (equity + P&L timeseries) — proxied straight from Alpaca.
// Defaults match the dashboard's "1D" range with 15-min resolution.
router.get('/alpaca/api/history', async (req, res) => {
    try {
        const period    = (req.query.period as string)    || '1D';
        const timeframe = (req.query.timeframe as string) || '15Min';
        const qs = new URLSearchParams({ period, timeframe, intraday_reporting: 'market_hours' });
        res.json(await alpacaGet(`/account/portfolio/history?${qs.toString()}`));
    } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Per-position value timeseries from our own snapshot collection.
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

// Capture a single snapshot of account + positions to Mongo.
// Exported so server.ts can call it on an interval. Errors are swallowed
// (Alpaca outages / API key issues shouldn't crash the snapshot loop).
export async function snapshotAlpacaNow(): Promise<void> {
    try {
        const [acct, positions] = await Promise.all([
            alpacaGet('/account') as Promise<any>,
            alpacaGet('/positions') as Promise<any[]>,
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
        <div class="alpaca-layout">
            <div class="alpaca-header">
                <div class="alpaca-title">CLOUD-CLAW // ALPACA PAPER TRADING</div>
                <div class="alpaca-controls">
                    <span id="last-updated" class="last-updated">Loading...</span>
                    <button class="refresh-btn" onclick="loadAll()">&#8635; REFRESH</button>
                </div>
            </div>

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
                        <canvas id="chart-equity"></canvas>
                    </div>
                    <div class="chart-card">
                        <div class="chart-label">CUMULATIVE P&amp;L</div>
                        <canvas id="chart-pl"></canvas>
                    </div>
                    <div class="chart-card chart-wide">
                        <div class="chart-label">POSITION VALUES (SNAPSHOTTED)</div>
                        <canvas id="chart-positions"></canvas>
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

        <script>
        const TOKEN = '${token}';

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

        async function loadAccount() {
            const r = await fetch('/admin/alpaca/api/account?token=' + TOKEN);
            const a = await r.json();
            if (a.error) return;
            document.getElementById('stat-equity').textContent = fmt$(a.equity);
            document.getElementById('stat-buying-power').textContent = fmt$(a.buying_power);
            document.getElementById('stat-cash').textContent = fmt$(a.cash);
            const dayPl = parseFloat(a.equity) - parseFloat(a.last_equity || a.equity);
            const dayPlPct = parseFloat(a.last_equity) > 0 ? dayPl / parseFloat(a.last_equity) : 0;
            const plEl = document.getElementById('stat-day-pl');
            plEl.textContent = fmt$(dayPl);
            plEl.className = 'stat-value ' + (dayPl >= 0 ? 'pos' : 'neg');
            document.getElementById('stat-day-pl-pct').textContent = fmtPct(dayPlPct);
        }

        async function loadPositions() {
            const r = await fetch('/admin/alpaca/api/positions?token=' + TOKEN);
            const data = await r.json();
            const tbody = document.getElementById('positions-body');
            if (!Array.isArray(data) || data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="loading-row">No open positions.</td></tr>';
                return;
            }
            tbody.innerHTML = data.map(function(p) {
                const plCls = plClass(p.unrealized_pl);
                return '<tr>' +
                    '<td class="sym">' + escHtml(p.symbol) + '</td>' +
                    '<td>' + escHtml(p.qty) + '</td>' +
                    '<td>' + fmt$(p.avg_entry_price) + '</td>' +
                    '<td>' + fmt$(p.current_price) + '</td>' +
                    '<td>' + fmt$(p.market_value) + '</td>' +
                    '<td class="' + plCls + '">' + fmt$(p.unrealized_pl) + '</td>' +
                    '<td class="' + plCls + '">' + fmtPct(p.unrealized_plpc) + '</td>' +
                    '</tr>';
            }).join('');
        }

        async function loadOrders() {
            const r = await fetch('/admin/alpaca/api/orders?token=' + TOKEN);
            const data = await r.json();
            const tbody = document.getElementById('orders-body');
            if (!Array.isArray(data) || data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="loading-row">No recent orders.</td></tr>';
                return;
            }
            tbody.innerHTML = data.map(function(o) {
                const sideCls = o.side === 'buy' ? 'side-buy' : 'side-sell';
                return '<tr>' +
                    '<td class="mono-sm">' + fmtDate(o.created_at) + '</td>' +
                    '<td class="sym">' + escHtml(o.symbol) + '</td>' +
                    '<td class="' + sideCls + '">' + escHtml((o.side || '').toUpperCase()) + '</td>' +
                    '<td>' + escHtml(o.qty || o.filled_qty) + '</td>' +
                    '<td>' + escHtml((o.type || '').toUpperCase()) + '</td>' +
                    '<td class="status-' + escHtml(o.status) + '">' + escHtml((o.status || '').toUpperCase()) + '</td>' +
                    '<td>' + (o.filled_avg_price ? fmt$(o.filled_avg_price) : '—') + '</td>' +
                    '</tr>';
            }).join('');
        }

        // ── Charts ───────────────────────────────────────────────────────────
        let currentRange = '1D';
        const RANGE_TIMEFRAME = { '1D': '15Min', '1W': '1H', '1M': '1D', '3M': '1D', 'ALL': '1D' };
        const charts = { equity: null, pl: null, positions: null };

        const chartFontFamily = "'Courier New', monospace";
        const gridColor = '#222';
        const tickColor = '#666';

        function baseChartOpts(yFmt) {
            return {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
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

        function tsLabels(timestamps) {
            return timestamps.map(function(t) {
                const d = new Date(t * 1000);
                if (currentRange === '1D') {
                    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                }
                return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            });
        }

        async function loadHistoryChart() {
            const tf = RANGE_TIMEFRAME[currentRange] || '1D';
            const period = currentRange === 'ALL' ? 'all' : currentRange;
            const r = await fetch('/admin/alpaca/api/history?period=' + period + '&timeframe=' + tf + '&token=' + TOKEN);
            const h = await r.json();
            if (!h || h.error || !Array.isArray(h.timestamp)) return;

            const labels = tsLabels(h.timestamp);
            const equity = h.equity || [];
            const pl = h.profit_loss || [];

            // Equity line
            const equityData = {
                labels: labels,
                datasets: [{
                    label: 'Equity',
                    data: equity,
                    borderColor: '#0d9488',
                    backgroundColor: 'rgba(13, 148, 136, 0.1)',
                    fill: true,
                    pointRadius: 0,
                    borderWidth: 1.5,
                    tension: 0.2,
                }],
            };
            if (charts.equity) {
                charts.equity.data = equityData;
                charts.equity.update();
            } else {
                charts.equity = new Chart(document.getElementById('chart-equity').getContext('2d'),
                    { type: 'line', data: equityData, options: baseChartOpts(fmtCompact) });
            }

            // Cumulative P&L line (color-shaded based on last value)
            const finalPl = pl.length ? pl[pl.length - 1] : 0;
            const plColor = finalPl >= 0 ? '#10b981' : '#ef4444';
            const plBg = finalPl >= 0 ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)';
            const plData = {
                labels: labels,
                datasets: [{
                    label: 'P&L',
                    data: pl,
                    borderColor: plColor,
                    backgroundColor: plBg,
                    fill: 'origin',
                    pointRadius: 0,
                    borderWidth: 1.5,
                    tension: 0.2,
                }],
            };
            if (charts.pl) {
                charts.pl.data = plData;
                charts.pl.update();
            } else {
                charts.pl = new Chart(document.getElementById('chart-pl').getContext('2d'),
                    { type: 'line', data: plData, options: baseChartOpts(fmtCompact) });
            }
        }

        const POSITION_COLORS = ['#0d9488','#f97316','#fbbf24','#10b981','#3b82f6','#a855f7','#ec4899','#06b6d4','#eab308','#f43f5e'];

        async function loadPositionsChart() {
            const r = await fetch('/admin/alpaca/api/snapshots?period=' + currentRange + '&token=' + TOKEN);
            const snaps = await r.json();
            const canvasEl = document.getElementById('chart-positions');
            if (!Array.isArray(snaps) || snaps.length === 0) {
                if (charts.positions) { charts.positions.destroy(); charts.positions = null; }
                const ctx = canvasEl.getContext('2d');
                ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
                ctx.fillStyle = '#444';
                ctx.font = '11px ' + chartFontFamily;
                ctx.textAlign = 'center';
                ctx.fillText('No snapshots yet — first sample arrives within 5 min.', canvasEl.width / 2, canvasEl.height / 2);
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

            const labels = snaps.map(function(s) {
                const d = new Date(s.ts);
                if (currentRange === '1D') {
                    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                }
                return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            });

            const datasets = symbols.map(function(sym, i) {
                const color = POSITION_COLORS[i % POSITION_COLORS.length];
                return {
                    label: sym,
                    data: snaps.map(function(s) {
                        const p = (s.positions || []).find(function(x) { return x.symbol === sym; });
                        return p ? p.market_value : 0;
                    }),
                    borderColor: color,
                    backgroundColor: color + '55',
                    fill: true,
                    pointRadius: 0,
                    borderWidth: 1,
                    tension: 0.2,
                };
            });

            const data = { labels: labels, datasets: datasets };
            const opts = baseChartOpts(fmtCompact);
            opts.plugins.legend = {
                display: true,
                position: 'bottom',
                labels: { color: '#888', font: { family: chartFontFamily, size: 10 }, boxWidth: 10 },
            };
            opts.scales.y.stacked = true;

            if (charts.positions) {
                charts.positions.data = data;
                charts.positions.options = opts;
                charts.positions.update();
            } else {
                charts.positions = new Chart(canvasEl.getContext('2d'),
                    { type: 'line', data: data, options: opts });
            }
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
            await Promise.all([loadHistoryChart(), loadPositionsChart()]);
        }

        async function loadAll() {
            document.getElementById('last-updated').textContent = 'Refreshing...';
            await Promise.all([loadAccount(), loadPositions(), loadOrders(), loadCharts()]);
            document.getElementById('last-updated').textContent =
                'Updated: ' + new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        }

        bindRangeButtons();
        loadAll();
        setInterval(loadAll, 30_000);
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
            min-height: 220px;
        }
        .chart-card.chart-wide { grid-column: 1 / -1; min-height: 280px; }
        .chart-label {
            font-size: 0.65rem;
            color: #555;
            letter-spacing: 2px;
        }
        .chart-card canvas { width: 100% !important; flex: 1; }
    `;

    res.send(renderPage({
        token,
        title: 'Alpaca Dashboard',
        activePage: 'alpaca',
        content,
        extraStyles
    }));
});

export default router;
