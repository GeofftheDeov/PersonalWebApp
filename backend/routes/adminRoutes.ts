import express from 'express';
import jwt from 'jsonwebtoken';
import { renderPage } from '../utils/adminUi.js';

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
                messages.forEach(m => appendMessage(m.role, m.content));
            }

            function appendMessage(role, text) {
                const box = document.getElementById('messages');
                const div = document.createElement('div');
                div.className = 'message ' + role;
                div.textContent = text;
                box.appendChild(div);
                box.scrollTop = box.scrollHeight;
            }

            async function sendMessage() {
                const input = document.getElementById('input');
                const text = input.value.trim();
                if (!text) return;
                input.value = '';
                appendMessage('user', text);
                appendMessage('assistant', '...');

                const res = await fetch('/api/cloud-claw/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
                    body: JSON.stringify({ message: text })
                });
                const box = document.getElementById('messages');
                box.removeChild(box.lastChild);
                if (res.ok) {
                    const { reply } = await res.json();
                    appendMessage('assistant', reply);
                } else {
                    appendMessage('assistant', '[Error: ' + res.status + ']');
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

export default router;
