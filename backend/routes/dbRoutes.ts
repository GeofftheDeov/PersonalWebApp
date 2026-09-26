import express from 'express';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import csv from 'csv-parser';
import { Readable } from 'stream';
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { sendResetPasswordEmail } from "../services/emailService.js";
import { renderPage } from '../utils/adminUi.js';
import { toCsv } from '../utils/csv.js';
import { workshopClientJs } from '../utils/workshopClient.js';
import { listViews, createView, updateView, deleteView, ListViewError } from '../services/listViews.js';
import User from "../models/User.js";
import Account from "../models/Account.js";
import Contact from "../models/Contact.js";
import Lead from "../models/Lead.js";
import Campaign from "../models/Campaign.js";
import CampaignMember from "../models/CampaignMember.js";
import CampaignInvite from "../models/CampaignInvite.js";
import Character from "../models/Character.js";
import Dungeon from "../models/Dungeon.js";
import Encounter from "../models/Encounter.js";
import Event from "../models/Event.js";
import FriendRequest from "../models/FriendRequest.js";
import Message from "../models/Message.js";
import Notification from "../models/Notification.js";
import Opportunity from "../models/Opportunity.js";
import PlayerSession from "../models/PlayerSession.js";
import Session from "../models/Session.js";
import Task from "../models/Task.js";
import ApiKeyVault from "../models/ApiKeyVault.js";
import AlpacaSnapshot from "../models/AlpacaSnapshot.js";
import CloudClawSession from "../models/CloudClawSession.js";

const upload = multer({ storage: multer.memoryStorage() });

const router = express.Router();

/**
 * Postgres port: the admin browser used to enumerate raw Mongo collections.
 * It now routes through the model registry so field names stay camelCase and
 * model hooks (hashing, defaults) still apply.
 */
const COLLECTIONS: Record<string, any> = {
    users: User, accounts: Account, contacts: Contact, leads: Lead,
    campaigns: Campaign, campaign_members: CampaignMember, campaign_invites: CampaignInvite,
    characters: Character, dungeons: Dungeon, encounters: Encounter, events: Event,
    friend_requests: FriendRequest, game_sessions: Session, player_sessions: PlayerSession,
    tasks: Task, opportunities: Opportunity, messages: Message, notifications: Notification,
    api_key_vault: ApiKeyVault, alpaca_snapshots: AlpacaSnapshot, cloud_claw_sessions: CloudClawSession,
};
const listCollectionNames = (): string[] => Object.keys(COLLECTIONS).sort();
const modelFor = (name: string): any => {
    const m = COLLECTIONS[name];
    if (!m) throw new Error(`Unknown collection: ${name}`);
    return m;
};

/** Collections whose records can be sent a password-reset email. */
const RESETTABLE = new Set(['users', 'leads', 'accounts']);

/**
 * Left out of every export. The grid still shows them (it always has), but a
 * CSV gets forwarded and opened in places a password hash or an encrypted key
 * should not travel to.
 */
const EXPORT_OMIT = new Set(['password', 'resetPasswordToken', 'emailVerificationToken', 'encryptedKeyId', 'encryptedSecret']);

/** Every key that appears on any row, in first-seen order. */
const unionKeys = (rows: Record<string, unknown>[]): string[] => {
    const keys = new Set<string>();
    rows.forEach((r) => Object.keys(r).forEach((k) => keys.add(k)));
    return Array.from(keys);
};

const escHtml = (v: unknown) => String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** JSON that is safe inside a <script> element (no `</script>`, no U+2028/9). */
const scriptJson = (v: unknown) => JSON.stringify(v)
    .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

// Middleware to verify token in query param
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

// Helper to render sidebar HTML
const renderSidebar = (token: string, collectionNames: string[], activeCollection: string | null) => {
    const sidebarItems = collectionNames.map(name => {
        const isActive = name === activeCollection;
        return `
            <li>
                <a href="/db/${name}?token=${token}" class="${isActive ? 'active' : ''}">
                    ${name.toUpperCase()}
                </a>
            </li>
        `;
    }).sort().join('');

    return `
        <nav class="sidebar">
            <div class="sidebar-header">
                <h2>THE WORKSHOP</h2>
            </div>
            <div class="sidebar-content">
                <ul>
                    ${sidebarItems}
                </ul>
            </div>
        </nav>
    `;
};

// Extra styles for DB views
const dbStyles = `
    /* Layout Overrides for DB View */
    body {
        overflow: hidden;
        align-items: stretch;
        justify-content: flex-start;
    }

    /* Sidebar Styling */
    .sidebar {
        width: 260px;
        background-color: #222;
        border-right: 4px solid #444;
        display: flex;
        flex-direction: column;
        box-shadow: 5px 0 15px rgba(0,0,0,0.5);
        z-index: 95;
    }
    .sidebar-header {
        padding: 1.5rem;
        background: #1a1a1a;
        border-bottom: 2px dashed #444;
        text-align: center;
    }
    .sidebar-header h2 {
        margin: 0;
        color: #0d9488; /* Teal-600 */
        font-size: 1.2rem;
        text-transform: uppercase;
        letter-spacing: 2px;
        text-shadow: 1px 1px 0 #000;
    }
    .sidebar-content {
        flex: 1;
        overflow-y: auto;
        padding: 1rem 0;
    }
    .sidebar ul {
        list-style: none;
        padding: 0;
        margin: 0;
    }
    .sidebar li a {
        display: block;
        padding: 0.8rem 1.5rem;
        color: #aaa;
        text-decoration: none;
        border-left: 4px solid transparent;
        transition: all 0.2s;
        font-size: 0.9rem;
    }
    .sidebar li a:hover {
        background-color: #333;
        color: #fff;
        border-left-color: #f97316; /* Orange-500 */
    }
    .sidebar li a.active {
        background-color: #2b2b2b;
        color: #f97316;
        border-left-color: #f97316;
        font-weight: bold;
        box-shadow: inset 5px 0 10px rgba(0,0,0,0.2);
    }
    
    /* Main Content Styling */
    .main-content {
        flex: 1;
        min-width: 0;
        overflow-y: auto;
        padding: 2rem;
        position: relative;
        display: flex;
        flex-direction: column;
    }
    /* Table pages: the page itself never scrolls; the grid below does. A sticky
       header only pins flush when its scroller has no top padding. With the
       2rem padding this used to scroll in, rows showed through a strip above
       the header. */
    .main-content.list-mode {
        overflow: hidden;
        padding: 1.25rem 1.5rem 1rem;
        z-index: 95; /* above the page vignette, like the other admin pages */
    }
    .main-content.list-mode .container {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }
    /* .btn sets display, which would otherwise beat the hidden attribute. */
    [hidden] { display: none !important; }

    /* Utility Styles for Inner Content */
    h1 {
        color: #fff;
        border-left: 10px solid #f97316;
        padding-left: 1rem;
        text-transform: uppercase;
        margin-top: 0;
        text-shadow: 2px 2px 4px rgba(0,0,0,0.8);
    }
    .list-mode h1 { margin: 0; font-size: 1.6rem; }
    .container {
        max-width: 1600px;
        margin: 0 auto;
        width: 100%;
    }

    /* ── Data grid ─────────────────────────────────────────────────────── */
    .table-scroll {
        flex: 1;
        min-height: 0;
        overflow: auto;
        border: 2px solid #444;
        background: #222;
        box-shadow: 0 0 20px rgba(0,0,0,0.5);
    }
    .table-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
    .table-scroll::-webkit-scrollbar-thumb { background: #444; }
    .table-scroll::-webkit-scrollbar-corner { background: #222; }

    /* separate + zero spacing, not collapse: collapsed borders belong to the
       table, so they scrolled away and left a sticky header borderless. */
    #data-table {
        border-collapse: separate;
        border-spacing: 0;
        width: max-content;
        font-size: 0.85rem;
    }
    #data-table.fixed { table-layout: fixed; }
    #data-table th, #data-table td {
        border-right: 1px solid #444;
        border-bottom: 1px solid #444;
        padding: 8px 10px;
        text-align: left;
        vertical-align: top;
        overflow: hidden;
    }
    #data-table th {
        position: sticky;
        top: 0;
        z-index: 3;
        background-color: #333;
        color: #0d9488;
        text-transform: uppercase;
        letter-spacing: 1px;
        white-space: nowrap;
        text-overflow: ellipsis;
        box-shadow: 0 2px 0 #555;
        padding-right: 14px;
    }
    #data-table th:hover { background-color: #3d3d3d; }
    .th-label { pointer-events: none; }
    .sort-ind { margin-left: 0.35rem; font-size: 0.65rem; color: #f97316; pointer-events: none; }

    .col-resizer {
        position: absolute;
        top: 0;
        right: -1px;
        width: 9px;
        height: 100%;
        cursor: col-resize !important;
        z-index: 4;
    }
    .col-resizer::after {
        content: '';
        position: absolute;
        top: 20%;
        bottom: 20%;
        right: 4px;
        width: 2px;
        background: #555;
        transition: background 0.1s;
    }
    .col-resizer:hover::after { background: #f97316; top: 0; bottom: 0; }
    body.col-resizing, body.col-resizing * { cursor: col-resize !important; }

    #data-table tbody tr { background-color: #222; }
    #data-table tbody tr:nth-child(even) { background-color: #2a2a2a; }
    #data-table tbody tr:hover { background-color: #333; }
    #data-table tr.no-rows td { color: #666; text-align: center; padding: 2rem; letter-spacing: 2px; }

    /* ACTIONS stays in view however wide the table gets. */
    #data-table .col-actions {
        position: sticky;
        right: 0;
        z-index: 1;
        background: inherit;
        border-left: 1px solid #555;
        box-shadow: -4px 0 8px rgba(0,0,0,0.35);
    }
    #data-table th.col-actions { z-index: 5; background-color: #333; cursor: default !important; }

    .cell-content {
        max-height: 100px;
        overflow-y: auto;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
    }

    .empty-state {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: #555;
        font-size: 2rem;
        text-transform: uppercase;
        letter-spacing: 4px;
        border: 4px dashed #333;
        margin: auto;
        padding: 3rem;
        background: rgba(0,0,0,0.3);
    }

    /* CRUD Action Buttons */
    .btn {
        padding: 0.5rem 1rem;
        border: 2px solid #555;
        background: #333;
        color: #fff;
        text-decoration: none;
        font-weight: bold;
        text-transform: uppercase;
        font-size: 0.8rem;
        font-family: 'Courier New', monospace;
        cursor: pointer;
        transition: all 0.2s;
        display: inline-block;
    }
    .btn:hover:not(:disabled) {
        transform: translateY(-2px);
        box-shadow: 0 4px 8px rgba(0,0,0,0.5);
    }
    .btn:disabled { opacity: 0.45; cursor: not-allowed !important; }
    .btn-teal:hover:not(:disabled) { background: #0d9488; border-color: #0d9488; color: #000; }
    .btn-orange:hover:not(:disabled) { background: #f97316; border-color: #f97316; color: #000; }
    .btn-red:hover:not(:disabled) { background: #ef4444; border-color: #ef4444; color: #fff; }
    #data-table .btn { padding: 0.3rem 0.6rem; font-size: 0.7rem; }

    .actions-cell {
        display: flex;
        gap: 0.5rem;
        white-space: nowrap;
    }

    /* Forms */
    .form-container {
        background: #222;
        padding: 2rem;
        border: 4px solid #444;
        box-shadow: 10px 10px 0 #000;
    }
    .form-group {
        margin-bottom: 1.5rem;
    }
    .form-group label {
        display: block;
        margin-bottom: 0.5rem;
        color: #0d9488;
        font-weight: bold;
        text-transform: uppercase;
    }
    textarea.json-input {
        width: 100%;
        height: 400px;
        background: #111;
        color: #0f0;
        border: 2px solid #444;
        padding: 1rem;
        font-family: 'Courier New', monospace;
        font-size: 1rem;
        resize: vertical;
    }
    .form-actions {
        display: flex;
        gap: 1rem;
        justify-content: flex-end;
    }

    .header-actions {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 1rem;
        gap: 1rem;
    }

    /* ── List view bar ─────────────────────────────────────────────────── */
    .view-bar {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        flex-wrap: wrap;
        margin-bottom: 0.75rem;
        padding: 0.5rem 0.75rem;
        background: #1e1e1e;
        border: 1px solid #333;
    }
    .view-bar-label { font-size: 0.7rem; letter-spacing: 2px; color: #0d9488; font-weight: bold; }
    #view-select {
        background: #111;
        border: 2px solid #444;
        color: #f97316;
        font-family: 'Courier New', monospace;
        font-weight: bold;
        font-size: 0.85rem;
        padding: 0.3rem 0.5rem;
        min-width: 220px;
        outline: none;
        cursor: pointer;
    }
    #view-select:focus { border-color: #0d9488; }
    .view-bar .btn { padding: 0.3rem 0.7rem; font-size: 0.7rem; }
    .view-dirty { font-size: 0.7rem; color: #fbbf24; letter-spacing: 1px; }
    .view-status { font-size: 0.72rem; color: #888; margin-left: auto; }
    .view-status.ok { color: #10b981; }
    .view-status.err { color: #f87171; }

    /* Filter + column toolbar */
    .table-toolbar {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        margin-bottom: 0.75rem;
        flex-wrap: wrap;
    }

    .filter-input {
        flex: 1;
        min-width: 200px;
        background: #1a1a1a;
        border: 2px solid #444;
        color: #e0e0e0;
        padding: 0.5rem 0.85rem;
        font-family: 'Courier New', monospace;
        font-size: 0.85rem;
        outline: none;
    }
    .filter-input:focus { border-color: #0d9488; }
    .filter-input::placeholder { color: #555; }

    .filter-count {
        font-size: 0.75rem;
        color: #777;
        white-space: nowrap;
        letter-spacing: 1px;
    }

    /* Dropdown menus (columns / filters / export) */
    .menu-wrap { position: relative; }
    .menu-btn {
        padding: 0.5rem 1rem;
        border: 2px solid #555;
        background: #333;
        color: #fff;
        font-weight: bold;
        text-transform: uppercase;
        font-size: 0.8rem;
        cursor: pointer;
        font-family: 'Courier New', monospace;
        white-space: nowrap;
    }
    .menu-btn:hover, .menu-btn.has-active { border-color: #0d9488; color: #0d9488; }
    .menu {
        display: none;
        position: absolute;
        top: calc(100% + 4px);
        right: 0;
        background: #1e1e1e;
        border: 2px solid #444;
        min-width: 260px;
        z-index: 50;
        box-shadow: 0 8px 24px rgba(0,0,0,0.6);
    }
    .menu.open { display: block; }
    .menu-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 0.75rem;
        padding: 0.5rem 0.75rem;
        border-bottom: 1px solid #333;
        font-size: 0.65rem;
        letter-spacing: 2px;
        color: #777;
    }
    .menu-head span { margin-right: auto; }
    .menu-head button {
        background: transparent;
        border: none;
        color: #0d9488;
        font-family: 'Courier New', monospace;
        font-size: 0.7rem;
        letter-spacing: 1px;
        cursor: pointer;
        padding: 0;
    }
    .menu-head button:hover { color: #f97316; }
    .menu-scroll { max-height: 360px; overflow-y: auto; }
    .menu-scroll::-webkit-scrollbar { width: 4px; }
    .menu-scroll::-webkit-scrollbar-thumb { background: #333; }
    .menu-empty { padding: 0.75rem; font-size: 0.75rem; color: #666; }
    .menu-note { padding: 0.5rem 0.75rem; font-size: 0.65rem; color: #666; border-top: 1px solid #333; }

    .col-item {
        display: flex;
        align-items: center;
        gap: 0.35rem;
        padding: 0.3rem 0.5rem 0.3rem 0.75rem;
        font-size: 0.8rem;
        color: #ccc;
        border-bottom: 1px solid #111;
    }
    .col-item label { flex: 1; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .col-item:hover { background: #2b2b2b; }
    .col-item input[type="checkbox"] { accent-color: #0d9488; cursor: pointer; }
    .col-item.hidden-col { color: #555; }
    .mini-btn {
        background: #111;
        border: 1px solid #333;
        color: #888;
        font-size: 0.6rem;
        padding: 0.15rem 0.35rem;
        cursor: pointer;
        font-family: inherit;
    }
    .mini-btn:hover:not(:disabled) { color: #f97316; border-color: #f97316; }
    .mini-btn:disabled { opacity: 0.3; cursor: default !important; }

    #filters-menu { min-width: 560px; }
    .filter-row { display: flex; gap: 0.4rem; align-items: center; padding: 0.4rem 0.75rem; border-bottom: 1px solid #111; }
    .filter-row select, .filter-row input {
        background: #111;
        border: 1px solid #444;
        color: #e0e0e0;
        font-family: 'Courier New', monospace;
        font-size: 0.8rem;
        padding: 0.3rem 0.4rem;
        outline: none;
    }
    .filter-row select:first-child { width: 170px; }
    .filter-row input { flex: 1; min-width: 0; }
    .filter-row input:disabled { opacity: 0.35; }
    .filter-row select:focus, .filter-row input:focus { border-color: #0d9488; }

    .menu-item {
        display: block;
        width: 100%;
        text-align: left;
        padding: 0.6rem 0.9rem;
        background: transparent;
        border: none;
        border-bottom: 1px solid #111;
        color: #ddd;
        font-family: 'Courier New', monospace;
        font-size: 0.8rem;
        text-decoration: none;
        cursor: pointer;
        box-sizing: border-box;
    }
    .menu-item:hover { background: #2b2b2b; color: #f97316; }
`;


router.get('/', async (req, res) => {
    try {
        const token = req.query.token as string;
        const collectionNames = listCollectionNames();
        
        const sidebarHtml = renderSidebar(token, collectionNames, null);
        const mainContentHtml = `
            <main class="main-content">
                <div class="empty-state">
                    Select a Collection
                </div>
            </main>
        `;

        res.send(renderPage({
            token,
            title: "The Garage",
            activePage: 'db',
            content: sidebarHtml + mainContentHtml,
            extraStyles: dbStyles
        }));
    } catch (err) {
        res.status(500).send("Error fetching collections");
    }
});

// ── Saved list views (JSON) ──────────────────────────────────────────────────
// Registered before the /:collection routes. Shared by all admins; see
// services/listViews.ts and migrations/2026-09-25-admin-list-views.sql.

const sendViewError = (res: express.Response, err: any) => {
    if (err instanceof ListViewError) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('[db] list views:', err);
    res.status(500).json({ error: err?.message || 'List view request failed' });
};

const knownCollection = (req: express.Request, res: express.Response): string | null => {
    const collection = String(req.params.collection);
    if (!COLLECTIONS[collection]) { res.status(404).json({ error: `Unknown table: ${collection}` }); return null; }
    return collection;
};

router.get('/api/views/:collection', async (req, res) => {
    const collection = knownCollection(req, res);
    if (!collection) return;
    try { res.json(await listViews(collection)); } catch (err) { sendViewError(res, err); }
});

router.post('/api/views/:collection', async (req, res) => {
    const collection = knownCollection(req, res);
    if (!collection) return;
    // verifyToken has already checked the signature; this only reads who saved it.
    const who = jwt.decode(String(req.query.token)) as { email?: string } | null;
    try {
        res.status(201).json(await createView(collection, req.body ?? {}, who?.email ?? null));
    } catch (err) { sendViewError(res, err); }
});

router.put('/api/views/:collection/:id', async (req, res) => {
    const collection = knownCollection(req, res);
    if (!collection) return;
    try { res.json(await updateView(collection, String(req.params.id), req.body ?? {})); } catch (err) { sendViewError(res, err); }
});

router.delete('/api/views/:collection/:id', async (req, res) => {
    const collection = knownCollection(req, res);
    if (!collection) return;
    try { await deleteView(collection, String(req.params.id)); res.json({ ok: true }); } catch (err) { sendViewError(res, err); }
});

// ── Table page ───────────────────────────────────────────────────────────────
// Rows ship as JSON and the grid is drawn in the browser (utils/workshopClient.ts):
// list views, sorting, filtering, column sizing and the per-view export all work
// on that one copy. Values are written with textContent — the old page spliced
// them into the HTML unescaped.

const renderTablePage = (token: string, collection: string, rows: Record<string, unknown>[]): string => {
    const t = encodeURIComponent(token);
    const heading = `
        <div class="header-actions">
            <h1>// ${escHtml(collection)}</h1>
            <div class="actions-cell">
                <button id="import-btn" class="btn btn-teal">IMPORT CSV</button>
                <a href="/db/${collection}/new?token=${t}" class="btn btn-orange">ADD NEW ENTRY</a>
            </div>
        </div>
        <input type="file" id="csv-upload" accept=".csv" style="display:none">`;

    if (rows.length === 0) {
        return `
            <div class="container">
                ${heading}
                <div class="empty-state" style="height:auto;margin-top:2rem;">BIN EMPTY</div>
            </div>
            <script>
                (function () {
                    var upload = document.getElementById('csv-upload');
                    var btn = document.getElementById('import-btn');
                    btn.addEventListener('click', function () { upload.click(); });
                    upload.addEventListener('change', async function () {
                        if (!upload.files[0]) return;
                        var form = new FormData();
                        form.append('csv', upload.files[0]);
                        btn.textContent = 'IMPORTING...';
                        btn.disabled = true;
                        try {
                            var res = await fetch('/db/${collection}/import?token=${t}', { method: 'POST', body: form });
                            var msg = await res.text();
                            if (res.ok) { alert(msg || 'Import successful'); location.reload(); }
                            else alert('Import failed: ' + msg);
                        } catch (err) { alert('Error: ' + err.message); }
                        finally { btn.textContent = 'IMPORT CSV'; btn.disabled = false; upload.value = ''; }
                    });
                })();
            </script>`;
    }

    const config = {
        token,
        collection,
        keys: unionKeys(rows),
        rows,
        sensitive: Array.from(EXPORT_OMIT),
        canReset: RESETTABLE.has(collection),
    };

    return `
        <div class="container">
            ${heading}

            <div class="view-bar">
                <span class="view-bar-label">LIST VIEW</span>
                <select id="view-select" title="Saved list views for this table"></select>
                <span id="view-dirty" class="view-dirty" hidden>&#9679; UNSAVED CHANGES</span>
                <button id="view-save" class="btn btn-teal" hidden>SAVE</button>
                <button id="view-saveas" class="btn btn-teal">SAVE AS&hellip;</button>
                <button id="view-revert" class="btn" hidden>REVERT</button>
                <button id="view-rename" class="btn" hidden>RENAME</button>
                <button id="view-default" class="btn" hidden></button>
                <button id="view-delete" class="btn btn-red" hidden>DELETE VIEW</button>
                <span id="view-status" class="view-status"></span>
            </div>

            <div class="table-toolbar">
                <input class="filter-input" id="search-input" type="text" placeholder="Search visible columns..." autocomplete="off" />
                <span class="filter-count" id="filter-count"></span>

                <div class="menu-wrap">
                    <button class="menu-btn" id="filters-btn">FILTERS &#9662;</button>
                    <div class="menu" id="filters-menu">
                        <div class="menu-head">
                            <span>FIELD FILTERS</span>
                            <button id="filters-add">+ ADD FILTER</button>
                            <button id="filters-clear">CLEAR</button>
                        </div>
                        <div class="menu-scroll" id="filters-list"></div>
                    </div>
                </div>

                <div class="menu-wrap">
                    <button class="menu-btn" id="cols-btn">COLUMNS &#9662;</button>
                    <div class="menu" id="cols-menu">
                        <div class="menu-head">
                            <span>SHOW / ORDER</span>
                            <button id="cols-all">ALL</button>
                            <button id="cols-none">NONE</button>
                            <button id="cols-fit" title="Forget dragged widths and fit every column to its content">FIT WIDTHS</button>
                        </div>
                        <div class="menu-scroll" id="cols-list"></div>
                        <div class="menu-note">Drag a header's right edge to resize; double-click it to fit.</div>
                    </div>
                </div>

                <div class="menu-wrap">
                    <button class="menu-btn" id="export-btn">EXPORT &#9662;</button>
                    <div class="menu" id="export-menu">
                        <button class="menu-item" id="export-view"><span id="export-view-label">CSV — this view</span></button>
                        <a class="menu-item" id="export-all-csv" download>CSV — whole table, every column</a>
                        <a class="menu-item" id="export-all-json" download>JSON — whole table</a>
                        <div class="menu-note">Password hashes, reset/verification tokens and encrypted keys are left out of exports.</div>
                    </div>
                </div>
            </div>

            <div class="table-scroll">
                <table id="data-table">
                    <colgroup id="data-colgroup"></colgroup>
                    <thead></thead>
                    <tbody></tbody>
                </table>
            </div>
        </div>
        <script type="application/json" id="workshop-config">${scriptJson(config)}</script>
        <script>${workshopClientJs}</script>`;
};

router.get('/:collection', async (req, res) => {
    const { collection } = req.params;
    const token = req.query.token as string;

    if (!COLLECTIONS[collection]) return res.status(404).send(`Unknown table: ${escHtml(collection)}`);
    try {
        const rows = (await modelFor(collection).find()).map((d: any) => d.toObject());
        res.send(renderPage({
            token,
            title: "The Garage",
            activePage: 'db',
            content: renderSidebar(token, listCollectionNames(), collection)
                + `<main class="main-content list-mode">${renderTablePage(token, collection, rows)}</main>`,
            extraStyles: dbStyles
        }));
    } catch (err: any) {
        console.error(`[db] loading ${collection}:`, err);
        res.status(500).send(`Error fetching data for ${escHtml(collection)}: ${escHtml(err?.message)}`);
    }
});

// EXPORT — the whole table, every column (minus EXPORT_OMIT). The page's
// "this view" export is built in the browser from what is on screen.
router.get('/:collection/export', async (req, res) => {
    const { collection } = req.params;
    if (!COLLECTIONS[collection]) return res.status(404).send(`Unknown table: ${escHtml(collection)}`);
    try {
        const rows = (await modelFor(collection).find()).map((d: any) => {
            const o = d.toObject();
            for (const k of EXPORT_OMIT) delete o[k];
            return o;
        });
        const file = `${collection}-${new Date().toISOString().slice(0, 10)}`;
        if (req.query.format === 'json') {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${file}.json"`);
            return res.send(JSON.stringify(rows, null, 2));
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${file}.csv"`);
        res.send(toCsv(unionKeys(rows), rows));
    } catch (err: any) {
        console.error(`[db] export ${collection}:`, err);
        res.status(500).send(`Export failed: ${escHtml(err?.message)}`);
    }
});

// CREATE FORM
router.get('/:collection/new', async (req, res) => {
    const { collection } = req.params;
    const token = req.query.token as string;
    const collectionNames = listCollectionNames();

    const content = `
        <main class="main-content">
            <div class="container">
                <h1>// NEW ENTRY: ${collection}</h1>
                <div class="form-container">
                    <form action="/db/${collection}/create?token=${token}" method="POST">
                        <div class="form-group">
                            <label>Document JSON</label>
                            <textarea name="json" class="json-input" placeholder='{ "field": "value" }'></textarea>
                        </div>
                        <div class="form-actions">
                            <a href="/db/${collection}?token=${token}" class="btn">CANCEL</a>
                            <button type="submit" class="btn btn-orange">CREATE</button>
                        </div>
                    </form>
                </div>
            </div>
        </main>
    `;

    res.send(renderPage({
        token,
        title: "New Entry",
        activePage: 'db',
        content: renderSidebar(token, collectionNames, collection) + content,
        extraStyles: dbStyles
    }));
});

// CREATE ACTION
router.post('/:collection/create', async (req, res) => {
    const { collection } = req.params;
    const token = req.query.token as string;
    try {
        const doc = JSON.parse(req.body.json);

        // Hash password if present in sensitive collections
        const sensitiveCollections = ['users', 'leads', 'accounts'];
        if (sensitiveCollections.includes(collection) && doc.password) {
            const salt = await bcrypt.genSalt(10);
            doc.password = await bcrypt.hash(doc.password, salt);
        }

        await modelFor(collection).create(doc);
        res.redirect(`/db/${collection}?token=${token}`);
    } catch (err: any) {
        res.status(400).send(`Invalid JSON or Create Error: ${err.message}`);
    }
});

// EDIT FORM
router.get('/:collection/edit/:id', async (req, res) => {
    const { collection, id } = req.params;
    const token = req.query.token as string;
    
    try {
        const collectionNames = listCollectionNames();
        const doc = (await modelFor(collection).findById(id))?.toObject();

        if (!doc) return res.status(404).send("Document not found");

        const content = `
            <main class="main-content">
                <div class="container">
                    <h1>// EDIT ENTRY: ${id}</h1>
                    <div class="form-container">
                        <form action="/db/${collection}/update/${id}?token=${token}" method="POST">
                            <div class="form-group">
                                <label>Document JSON</label>
                                <textarea name="json" class="json-input">${escHtml(JSON.stringify(doc, null, 4))}</textarea>
                            </div>
                            <div class="form-actions">
                                <a href="/db/${collection}?token=${token}" class="btn">CANCEL</a>
                                <button type="submit" class="btn btn-teal">UPDATE</button>
                            </div>
                        </form>
                    </div>
                </div>
            </main>
        `;

        res.send(renderPage({
            token,
            title: "Edit Entry",
            activePage: 'db',
            content: renderSidebar(token, collectionNames, collection) + content,
            extraStyles: dbStyles
        }));
    } catch (err) {
        res.status(500).send("Error loading edit form");
    }
});

// UPDATE ACTION
router.post('/:collection/update/:id', async (req, res) => {
    const { collection, id } = req.params;
    const token = req.query.token as string;
    try {
        const updateDoc = JSON.parse(req.body.json);
        delete updateDoc._id; // Prevent updating _id
        // Hash password if present in sensitive collections
        const sensitiveCollections = ['users', 'leads', 'accounts'];
        if (sensitiveCollections.includes(collection) && updateDoc.password) {
            const salt = await bcrypt.genSalt(10);
            updateDoc.password = await bcrypt.hash(updateDoc.password, salt);
        }

        await modelFor(collection).findByIdAndUpdate(id, { $set: updateDoc });
        res.redirect(`/db/${collection}?token=${token}`);
    } catch (err: any) {
        res.status(400).send(`Invalid JSON or Update Error: ${err.message}`);
    }
});

// DELETE ACTION
router.post('/:collection/delete/:id', async (req, res) => {
    const { collection, id } = req.params;
    try {
        await modelFor(collection).findByIdAndDelete(id);
        res.sendStatus(200);
    } catch (err) {
        res.status(500).send('Delete failed');
    }
});

// RESET PASSWORD ACTION
router.post('/:collection/reset-password/:id', async (req, res) => {
    const { collection, id } = req.params;
    try {
        const doc = (await modelFor(collection).findById(id))?.toObject();
        if (!doc) return res.status(404).send('Document not found');
        const email = doc.email;
        if (!email) return res.status(400).send('Document has no email field');
        const token = crypto.randomBytes(20).toString('hex');
        await modelFor(collection).findByIdAndUpdate(id, { $set: { resetPasswordToken: token, resetPasswordExpires: new Date(Date.now() + 3600000) } });
        await sendResetPasswordEmail(email, token);
        res.status(200).send(`Reset email sent to ${email}`);
    } catch (err: any) {
        res.status(500).send('Reset failed: ' + err.message);
    }
});

// CSV IMPORT ACTION
router.post('/:collection/import', upload.single('csv'), async (req: any, res) => {
    const { collection } = req.params;
    const results: any[] = [];
    const stream = Readable.from(req.file.buffer);

    stream
        .pipe(csv({
            mapHeaders: ({ header }: { header: string }) => header.trim().replace(/^﻿/, '').replace(/[^\x20-\x7E]/g, ''),
            mapValues: ({ value }: { value: string }) => value.trim(),
        }))
        .on('data', (data) => {
            const transformed: any = {};
            Object.keys(data).forEach(key => {
                const val = data[key];
                const lk = key.toLowerCase();
                if (lk === 'name' && collection === 'leads') {
                    const parts = val.split(' ');
                    transformed.firstName = parts[0] || '';
                    transformed.lastName  = parts.slice(1).join(' ') || '';
                } else if (lk === 'email')    { transformed.email    = val; }
                else if (lk === 'phone')    { transformed.phone    = val; }
                else if (lk === 'password') { transformed.password = val; }
                else if (lk === 'id')       { transformed[collection === 'leads' ? 'sfLeadId' : 'sfID'] = val; }
                else                        { transformed[key] = val; }
            });
            if (collection === 'leads') {
                if (!transformed.email)     transformed.email     = 'imported@example.com';
                if (!transformed.password)  transformed.password  = 'password123';
                if (!transformed.firstName) transformed.firstName = 'Imported';
                if (!transformed.lastName)  transformed.lastName  = 'User';
            }
            if (['users', 'leads', 'accounts'].includes(collection) && transformed.password) {
                transformed.password = bcrypt.hashSync(transformed.password, bcrypt.genSaltSync(10));
            }
            results.push(transformed);
        })
        .on('end', async () => {
            try {
                const toInsert: any[] = [];
                for (const record of results) {
                    let query: any = {};
                    if (collection === 'leads')                  { query = { firstName: record.firstName, lastName: record.lastName, email: record.email }; }
                    else if (record.name && record.email) { query = { name: record.name, email: record.email }; }
                    else if (record.email)                { query = { email: record.email }; }
                    if (Object.keys(query).length > 0) {
                        const existing = await modelFor(collection).findOne(query);
                        if (!existing) toInsert.push(record);
                    } else {
                        toInsert.push(record);
                    }
                }
                for (const record of toInsert) await modelFor(collection).create(record);
                res.status(200).send(`Import complete. Inserted ${toInsert.length} records, skipped ${results.length - toInsert.length} duplicates.`);
            } catch (err: any) {
                res.status(500).send(`Database error: ${err.message}`);
            }
        })
        .on('error', (err: any) => res.status(400).send(`CSV parse error: ${err.message}`));
});

export default router;
