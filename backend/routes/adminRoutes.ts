import express from 'express';
import jwt from 'jsonwebtoken';
import { renderPage } from '../utils/adminUi.js';

const router = express.Router();

// Middleware to verify token in query param - consistent with dbRoutes
const verifyToken = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const token = req.query.token as string;

    if (!token) {
        return res.status(401).send("<h1>401 Unauthorized: No token provided</h1>");
    }

    try {
        jwt.verify(token, process.env.JWT_SECRET || "your-secret-key-change-this");
        next();
    } catch (err) {
        return res.status(401).send("<h1>401 Unauthorized: Invalid token</h1>");
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

export default router;
