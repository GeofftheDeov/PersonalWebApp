import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';

interface AuthRequest extends Request {
    user?: {
        id: string;
        email: string;
        type: string;
    };
}

export const auth = (req: AuthRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.log(`[AUTH] 401: No token provided for ${req.originalUrl}`);
        return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || "your-secret-key-change-this") as any;
        req.user = {
            id: decoded.id,
            email: decoded.email,
            type: decoded.type
        };
        next();
    } catch (err: any) {
        console.log(`[AUTH] 401: Invalid token for ${req.originalUrl}. Error: ${err.message}`);
        return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
};

/**
 * Admin gate for the server-rendered portals (#43).
 *
 * Until now `/admin` and `/db` checked only that the JWT *parsed*. Any signed-in
 * person who appended `?token=<their own JWT>` reached the raw table browser
 * with edit and delete across every model — including sf_users, api_key_vault
 * and cloud_claw_sessions — plus the vault reader and the decrypted-key routes.
 * There was no privilege to escalate to, because there was no privilege.
 *
 * Before the Phase 3 cutover this reads `sf_users.role`, not `accounts.app_role`:
 * a token's `id` is still a landing-table row, and `accounts` is empty in
 * production until the Phase 2 backfill runs there. `sf_users.role` is the
 * column that backfill derives app_role from, and production's one admin — the
 * row `--admin` pins — already carries it. Only sf_users has a role, so a Lead,
 * Contact or Account token resolves to nobody here and is refused.
 *
 * Signup and PUT /profile cannot write `role`. The Salesforce push
 * (/api/sync/users, behind SYNC_API_KEY) can, in either direction, and nothing
 * pins it the way app_role_source = 'manual' will; recovery is a SQL UPDATE.
 *
 * TODO(#35): Phase 3 swaps the lookup for accounts.app_role. The signature, the
 * request fields it reads and the 403s it sends stay as they are.
 */
export const requireAdmin = (redirect: boolean) =>
    async (req: any, res: Response, next: NextFunction) => {
        const id = req.adminUser?.id ?? req.user?.id;
        const deny = () => redirect
            ? res.status(403).send(
                "<h1>403 — admin only</h1><p>This account is not an administrator.</p>")
            : res.status(403).json({ error: "Forbidden: admin only" });

        if (!id) return deny();
        try {
            const person = await User.findById(id).select("role");
            if (person?.role !== "admin") {
                console.log(`[AUTH] 403: ${id} is not an admin (${req.originalUrl})`);
                return deny();
            }
            next();
        } catch (err: any) {
            console.error("[AUTH] requireAdmin lookup failed:", err.message);
            return deny();
        }
    };
