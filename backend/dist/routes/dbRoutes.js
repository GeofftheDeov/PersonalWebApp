import express from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import csv from 'csv-parser';
import { Readable } from 'stream';
import bcrypt from "bcryptjs";
import { renderPage } from '../utils/adminUi.js';
const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();
// Middleware to verify token in query param
const verifyToken = (req, res, next) => {
    const token = req.query.token;
    const loginUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/login`;
    if (!token) {
        console.log(`[AUTH] 401: No token provided for ${req.originalUrl}`);
        return res.redirect('/login');
    }
    try {
        jwt.verify(token, process.env.JWT_SECRET || "your-secret-key-change-this");
        next();
    }
    catch (err) {
        console.log(`[AUTH] 401: Invalid token for ${req.originalUrl}. Error: ${err.message}`);
        return res.redirect(loginUrl);
    }
};
router.use(verifyToken);
// Helper to render sidebar HTML
const renderSidebar = (token, collectionNames, activeCollection) => {
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
        max-width: 1600px;
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
        cursor: pointer;
        user-select: none;
        transition: background-color 0.2s;
    }
    th:hover {
        background-color: #444;
    }
    th.sort-asc::after { content: ' ▲'; font-size: 0.7rem; }
    th.sort-desc::after { content: ' ▼'; font-size: 0.7rem; }
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
        cursor: pointer;
        transition: all 0.2s;
        display: inline-block;
    }
    .btn:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 8px rgba(0,0,0,0.5);
    }
    .btn-teal:hover { background: #0d9488; border-color: #0d9488; color: #000; }
    .btn-orange:hover { background: #f97316; border-color: #f97316; color: #000; }
    .btn-red:hover { background: #ef4444; border-color: #ef4444; color: #fff; }
    
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
        margin-bottom: 2rem;
    }
`;
router.get('/', async (req, res) => {
    try {
        const token = req.query.token;
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
    }
    catch (err) {
        res.status(500).send("Error fetching collections");
    }
});
router.get('/:collection', async (req, res) => {
    const { collection } = req.params;
    const token = req.query.token;
    try {
        const collections = await mongoose.connection.db?.listCollections().toArray();
        const collectionNames = collections?.map(c => c.name) || [];
        const data = await mongoose.connection.db?.collection(collection).find().toArray();
        let tableContent = "";
        if (data && data.length > 0) {
            // Aggregate all unique keys from all records to ensure columns for mixed structures
            const allKeys = new Set();
            data.forEach(row => Object.keys(row).forEach(k => allKeys.add(k)));
            const keys = Array.from(allKeys);
            const tableHeader = `<tr>${keys.map(k => `<th onclick="handleSort(event, '${k}')" data-key="${k}">${k}</th>`).join('')}<th>ACTIONS</th></tr>`;
            const tableRows = data.map(row => {
                const id = row._id;
                return `
                    <tr>
                        ${keys.map(k => {
                    const val = row[k];
                    if (val === undefined)
                        return '<td></td>';
                    const displayVal = typeof val === 'string' ? val : JSON.stringify(val);
                    return `<td><div class="cell-content">${displayVal}</div></td>`;
                }).join('')}
                        <td>
                            <div class="actions-cell">
                                <a href="/db/${collection}/edit/${id}?token=${token}" class="btn btn-teal">EDIT</a>
                                <button onclick="deleteDoc('${collection}', '${id}')" class="btn btn-red">DELETE</button>
                            </div>
                        </td>
                    </tr>`;
            }).join('');
            tableContent = `
                <div class="container">
                        <div class="header-actions">
                            <h1>// ${collection}</h1>
                            <div class="actions-cell">
                                <button onclick="triggerCsvUpload()" class="btn btn-teal">IMPORT CSV</button>
                                <a href="/db/${collection}/new?token=${token}" class="btn btn-orange">ADD NEW ENTRY</a>
                            </div>
                        </div>
                        <input type="file" id="csv-upload" accept=".csv" style="display: none;" onchange="handleCsvFile(event, '${collection}')">
                        <table>
                            <thead>${tableHeader}</thead>
                            <tbody>${tableRows}</tbody>
                        </table>
                    </div>
                    <script>
                        let sortState = []; // [{ key: string, order: 'asc' | 'desc' }]

                        function handleSort(event, key) {
                            const isCtrl = event.ctrlKey;
                            const existingIdx = sortState.findIndex(s => s.key === key);
                            
                            if (!isCtrl) {
                                // Clear others, toggle this one
                                const currentOrder = (existingIdx > -1 && sortState.length === 1) ? (sortState[0].order === 'asc' ? 'desc' : 'asc') : 'asc';
                                sortState = [{ key, order: currentOrder }];
                            } else {
                                // Multi-sort toggle
                                if (existingIdx > -1) {
                                    if (sortState[existingIdx].order === 'asc') sortState[existingIdx].order = 'desc';
                                    else sortState.splice(existingIdx, 1);
                                } else {
                                    sortState.push({ key, order: 'asc' });
                                }
                            }
                            
                            updateSortUI();
                            sortTable();
                        }

                        function updateSortUI() {
                            document.querySelectorAll('th[data-key]').forEach(th => {
                                th.classList.remove('sort-asc', 'sort-desc');
                                const state = sortState.find(s => s.key === th.getAttribute('data-key'));
                                if (state) th.classList.add(\`sort-\${state.order}\`);
                            });
                        }

                        function sortTable() {
                            const tbody = document.querySelector('tbody');
                            const rows = Array.from(tbody.querySelectorAll('tr'));
                            
                            rows.sort((a, b) => {
                                for (const { key, order } of sortState) {
                                    const aIdx = Array.from(document.querySelectorAll('th')).findIndex(th => th.getAttribute('data-key') === key);
                                    let aval = a.children[aIdx]?.innerText || '';
                                    let bval = b.children[aIdx]?.innerText || '';
                                    
                                    // Try numeric sort
                                    const anum = Number(aval);
                                    const bnum = Number(bval);
                                    if (!isNaN(anum) && !isNaN(bnum)) {
                                        if (anum !== bnum) return order === 'asc' ? anum - bnum : bnum - anum;
                                    } else {
                                        const cmp = aval.localeCompare(bval, undefined, { sensitivity: 'base', numeric: true });
                                        if (cmp !== 0) return order === 'asc' ? cmp : -cmp;
                                    }
                                }
                                return 0;
                            });
                            
                            rows.forEach(row => tbody.appendChild(row));
                        }

                        async function deleteDoc(coll, id) {
                            if (confirm('Are you sure you want to delete this document?')) {
                                const res = await fetch(\`/db/\${coll}/delete/\${id}?token=${token}\`, { method: 'POST' });
                                if (res.ok) window.location.reload();
                                else alert('Delete failed');
                            }
                        }

                        function triggerCsvUpload() {
                            document.getElementById('csv-upload').click();
                        }

                        async function handleCsvFile(event, coll) {
                            const file = event.target.files[0];
                            if (!file) return;

                            const formData = new FormData();
                            formData.append('csv', file);

                            const headerActions = event.target.closest('.header-actions') || event.target.previousElementSibling;
                            const btn = headerActions.querySelector('.btn-teal');
                            const originalText = btn.innerText;
                            btn.innerText = 'IMPORTING...';
                            btn.disabled = true;

                            try {
                                const res = await fetch(\`/db/\${coll}/import?token=${token}\`, {
                                    method: 'POST',
                                    body: formData
                                });
                                if (res.ok) {
                                    const msg = await res.text();
                                    alert(msg || 'Import successful');
                                    window.location.reload();
                                } else {
                                    const err = await res.text();
                                    alert('Import failed: ' + err);
                                }
                            } catch (err) {
                                alert('Error: ' + err.message);
                            } finally {
                                btn.innerText = originalText;
                                btn.disabled = false;
                            }
                        }
                    </script>
             `;
        }
        else {
            tableContent = `
                <div class="container">
                    <div class="header-actions">
                        <h1>// ${collection}</h1>
                        <div class="actions-cell">
                            <button onclick="triggerCsvUpload()" class="btn btn-teal">IMPORT CSV</button>
                            <a href="/db/${collection}/new?token=${token}" class="btn btn-orange">ADD NEW ENTRY</a>
                        </div>
                    </div>
                    <input type="file" id="csv-upload" accept=".csv" style="display: none;" onchange="handleCsvFile(event, '${collection}')">
                    <div class="empty-state" style="height: auto; margin-top: 2rem;">
                        BIN EMPTY
                    </div>
                </div>
                <script>
                    function triggerCsvUpload() {
                        document.getElementById('csv-upload').click();
                    }

                    async function handleCsvFile(event, coll) {
                        const file = event.target.files[0];
                        if (!file) return;

                        const formData = new FormData();
                        formData.append('csv', file);

                        const btn = event.target.previousElementSibling.querySelector('.btn-teal');
                        const originalText = btn.innerText;
                        btn.innerText = 'IMPORTING...';
                        btn.disabled = true;

                        try {
                            const res = await fetch(\`/db/\${coll}/import?token=${token}\`, {
                                method: 'POST',
                                body: formData
                            });
                            if (res.ok) {
                                alert('Import successful');
                                window.location.reload();
                            } else {
                                const err = await res.text();
                                alert('Import failed: ' + err);
                            }
                        } catch (err) {
                            alert('Error: ' + err.message);
                        } finally {
                            btn.innerText = originalText;
                            btn.disabled = false;
                        }
                    }
                </script>
             `;
        }
        const sidebarHtml = renderSidebar(token, collectionNames, collection);
        res.send(renderPage({
            token,
            title: "The Garage",
            activePage: 'db',
            content: sidebarHtml + `<main class="main-content">${tableContent}</main>`,
            extraStyles: dbStyles
        }));
    }
    catch (err) {
        res.status(500).send(`Error fetching data for ${collection}`);
    }
});
// CREATE FORM
router.get('/:collection/new', async (req, res) => {
    const { collection } = req.params;
    const token = req.query.token;
    const collections = await mongoose.connection.db?.listCollections().toArray();
    const collectionNames = collections?.map(c => c.name) || [];
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
    const token = req.query.token;
    try {
        const doc = JSON.parse(req.body.json);
        // Hash password if present in sensitive collections
        const sensitiveCollections = ['users', 'leads', 'accounts'];
        if (sensitiveCollections.includes(collection) && doc.password) {
            const salt = await bcrypt.genSalt(10);
            doc.password = await bcrypt.hash(doc.password, salt);
        }
        await mongoose.connection.db?.collection(collection).insertOne(doc);
        res.redirect(`/db/${collection}?token=${token}`);
    }
    catch (err) {
        res.status(400).send(`Invalid JSON or Create Error: ${err.message}`);
    }
});
// EDIT FORM
router.get('/:collection/edit/:id', async (req, res) => {
    const { collection, id } = req.params;
    const token = req.query.token;
    try {
        const collections = await mongoose.connection.db?.listCollections().toArray();
        const collectionNames = collections?.map(c => c.name) || [];
        const doc = await mongoose.connection.db?.collection(collection).findOne({ _id: new mongoose.Types.ObjectId(id) });
        if (!doc)
            return res.status(404).send("Document not found");
        const content = `
            <main class="main-content">
                <div class="container">
                    <h1>// EDIT ENTRY: ${id}</h1>
                    <div class="form-container">
                        <form action="/db/${collection}/update/${id}?token=${token}" method="POST">
                            <div class="form-group">
                                <label>Document JSON</label>
                                <textarea name="json" class="json-input">${JSON.stringify(doc, null, 4)}</textarea>
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
    }
    catch (err) {
        res.status(500).send("Error loading edit form");
    }
});
// UPDATE ACTION
router.post('/:collection/update/:id', async (req, res) => {
    const { collection, id } = req.params;
    const token = req.query.token;
    try {
        const updateDoc = JSON.parse(req.body.json);
        delete updateDoc._id; // Prevent updating _id
        // Hash password if present in sensitive collections
        const sensitiveCollections = ['users', 'leads', 'accounts'];
        if (sensitiveCollections.includes(collection) && updateDoc.password) {
            const salt = await bcrypt.genSalt(10);
            updateDoc.password = await bcrypt.hash(updateDoc.password, salt);
        }
        await mongoose.connection.db?.collection(collection).updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: updateDoc });
        res.redirect(`/db/${collection}?token=${token}`);
    }
    catch (err) {
        res.status(400).send(`Invalid JSON or Update Error: ${err.message}`);
    }
});
// DELETE ACTION
router.post('/:collection/delete/:id', async (req, res) => {
    const { collection, id } = req.params;
    try {
        await mongoose.connection.db?.collection(collection).deleteOne({ _id: new mongoose.Types.ObjectId(id) });
        res.sendStatus(200);
    }
    catch (err) {
        res.status(500).send("Delete failed");
    }
});
// CSV IMPORT ACTION
router.post('/:collection/import', upload.single('csv'), async (req, res) => {
    const { collection } = req.params;
    console.log(`[CSV IMPORT] Starting import for collection: ${collection}`);
    console.log(`[CSV IMPORT] File: ${req.file.originalname}, Size: ${req.file.size} bytes`);
    const results = [];
    const stream = Readable.from(req.file.buffer);
    // Initial buffer inspection
    const sample = req.file.buffer.slice(0, 100).toString();
    console.log(`[CSV IMPORT] Buffer sample (first 100 bytes): ${JSON.stringify(sample)}`);
    stream
        .pipe(csv({
        mapHeaders: ({ header }) => {
            const cleaned = header.trim().replace(/^\ufeff/, '').replace(/[^\x20-\x7E]/g, '');
            console.log(`[CSV IMPORT] Header Mapping: "${header}" -> "${cleaned}"`);
            return cleaned;
        },
        mapValues: ({ value }) => value.trim()
    }))
        .on('data', (data) => {
        // Transformation Layer
        const transformed = {};
        // Map keys (normalize to lowercase, handle specific mappings)
        Object.keys(data).forEach(key => {
            const val = data[key];
            const lowerKey = key.toLowerCase();
            if (lowerKey === 'name' && collection === 'leads') {
                const parts = val.split(' ');
                transformed.firstName = parts[0] || '';
                transformed.lastName = parts.slice(1).join(' ') || '';
            }
            else if (lowerKey === 'email') {
                transformed.email = val;
            }
            else if (lowerKey === 'phone') {
                transformed.phone = val;
            }
            else if (lowerKey === 'password') {
                transformed.password = val;
            }
            else if (lowerKey === 'id') {
                if (collection === 'leads')
                    transformed.sfLeadId = val;
                else
                    transformed.sfID = val;
            }
            else {
                transformed[key] = val; // Keep others as is
            }
        });
        // Ensure required fields for Leads
        if (collection === 'leads') {
            if (!transformed.email)
                transformed.email = "imported@example.com";
            if (!transformed.password)
                transformed.password = "password123";
            if (!transformed.firstName)
                transformed.firstName = "Imported";
            if (!transformed.lastName)
                transformed.lastName = "User";
        }
        // Hash password if present in sensitive collections
        const sensitiveCollections = ['users', 'leads', 'accounts'];
        if (sensitiveCollections.includes(collection) && transformed.password) {
            // We use a sync hash here for simplicity within the stream, 
            // but async would be better for high volume.
            const salt = bcrypt.genSaltSync(10);
            transformed.password = bcrypt.hashSync(transformed.password, salt);
        }
        if (results.length === 0) {
            console.log("[CSV IMPORT] First record raw:", JSON.stringify(data, null, 2));
            console.log("[CSV IMPORT] First record transformed:", JSON.stringify(transformed, null, 2));
        }
        results.push(transformed);
    })
        .on('end', async () => {
        try {
            console.log(`[CSV IMPORT] Parsed ${results.length} records. Filtering duplicates...`);
            const toInsert = [];
            for (const record of results) {
                let query = {};
                if (collection === 'leads') {
                    query = {
                        firstName: record.firstName,
                        lastName: record.lastName,
                        email: record.email
                    };
                }
                else if (record.name && record.email) {
                    query = { name: record.name, email: record.email };
                }
                else if (record.email) {
                    query = { email: record.email };
                }
                if (Object.keys(query).length > 0) {
                    const existing = await mongoose.connection.db?.collection(collection).findOne(query);
                    if (!existing) {
                        toInsert.push(record);
                    }
                    else {
                        console.log(`[CSV IMPORT] Skipping duplicate: ${JSON.stringify(query)}`);
                    }
                }
                else {
                    toInsert.push(record); // No identifying fields, just insert
                }
            }
            console.log(`[CSV IMPORT] Inserting ${toInsert.length} new records to MongoDB (skipped ${results.length - toInsert.length} duplicates)...`);
            if (toInsert.length > 0) {
                const insertResult = await mongoose.connection.db?.collection(collection).insertMany(toInsert);
                console.log(`[CSV IMPORT] Successfully inserted ${insertResult?.insertedCount} records.`);
            }
            res.status(200).send(`Import complete. Inserted ${toInsert.length} records, skipped ${results.length - toInsert.length} duplicates.`);
        }
        catch (err) {
            console.error(`[CSV IMPORT] Database error:`, err);
            res.status(500).send(`Database error: ${err.message}`);
        }
    })
        .on('error', (err) => {
        console.error(`[CSV IMPORT] Parser error:`, err);
        res.status(400).send(`CSV parse error: ${err.message}`);
    });
});
export default router;
