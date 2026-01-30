import express from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { renderPage } from '../utils/adminUi.js';

const router = express.Router();

// Middleware to verify token in query param
const verifyToken = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const token = req.query.token as string;

    if (!token) {
        console.log(`[AUTH] 401: No token provided for ${req.originalUrl}`);
        return res.status(401).send("<h1>401 Unauthorized: No token provided</h1>");
    }

    try {
        jwt.verify(token, process.env.JWT_SECRET || "your-secret-key-change-this");
        next();
    } catch (err: any) {
        console.log(`[AUTH] 401: Invalid token for ${req.originalUrl}. Error: ${err.message}`);
        return res.status(401).send("<h1>401 Unauthorized: Invalid token</h1>");
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
    }).join('');

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
        overflow-y: auto;
        padding: 2rem;
        position: relative;
        display: flex;
        flex-direction: column;
    }
    
    /* Utility Styles for Inner Content */
    h1 {
        color: #fff;
        border-left: 10px solid #f97316;
        padding-left: 1rem;
        text-transform: uppercase;
        margin-top: 0;
        text-shadow: 2px 2px 4px rgba(0,0,0,0.8);
    }
    .container {
        max-width: 1200px;
        margin: 0 auto;
        width: 100%;
    }
    
    table { 
        border-collapse: collapse; 
        width: 100%; 
        border: 2px solid #444;
        background-color: #222;
        box-shadow: 0 0 20px rgba(0,0,0,0.5);
    }
    th, td { 
        border: 1px solid #444; 
        padding: 12px; 
        text-align: left; 
    }
    th { 
        background-color: #333; 
        color: #0d9488; 
        text-transform: uppercase;
        letter-spacing: 1px;
        position: sticky;
        top: 0;
        z-index: 5;
    }
    tr:nth-child(even) { background-color: #2a2a2a; }
    tr:hover { background-color: #333; }
    .cell-content {
        max-height: 100px;
        overflow-y: auto;
        word-break: break-all;
        font-size: 0.9rem;
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

    /* Scrollbar Styling */
    ::-webkit-scrollbar { width: 10px; height: 10px; }
    ::-webkit-scrollbar-track { background: #1a1a1a; }
    ::-webkit-scrollbar-thumb { background: #555; border: 2px solid #1a1a1a; }
    ::-webkit-scrollbar-thumb:hover { background: #f97316; }
`;

router.get('/', async (req, res) => {
    try {
        const token = req.query.token as string;
        const collections = await mongoose.connection.db?.listCollections().toArray();
        const collectionNames = collections?.map(c => c.name) || [];
        
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

router.get('/:collection', async (req, res) => {
    const { collection } = req.params;
    const token = req.query.token as string;
    
    try {
        // Fetch collections for sidebar
        const collections = await mongoose.connection.db?.listCollections().toArray();
        const collectionNames = collections?.map(c => c.name) || [];
        
        // Fetch specific collection data
        const data = await mongoose.connection.db?.collection(collection).find().toArray();
        
        let tableContent = "";

        if (data && data.length > 0) {
             const keys = Object.keys(data[0]);
             const tableHeader = `<tr>${keys.map(k => `<th>${k}</th>`).join('')}</tr>`;
             const tableRows = data.map(row => {
                 return `<tr>${keys.map(k => `<td><div class="cell-content">${JSON.stringify((row as any)[k])}</div></td>`).join('')}</tr>`;
             }).join('');
             
             tableContent = `
                <div class="container">
                    <h1>// ${collection}</h1>
                    <table>
                        <thead>${tableHeader}</thead>
                        <tbody>${tableRows}</tbody>
                    </table>
                </div>
             `;
        } else {
             tableContent = `
                <div class="container">
                    <h1>// ${collection}</h1>
                    <div class="empty-state" style="height: auto; margin-top: 2rem;">
                        BIN EMPTY
                    </div>
                </div>
             `;
        }

        const sidebarHtml = renderSidebar(token, collectionNames, collection);
        const mainContentHtml = `
            <main class="main-content">
                ${tableContent}
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
        res.status(500).send(`Error fetching data for ${collection}`);
    }
});

export default router;
