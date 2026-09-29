import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import Account from '../models/Account.js';
import { resolveAccountId } from '../utils/accountRefs.js';

interface AuthRequest extends Request {
    user?: {
        id: string;
        email: string;
    };
}

/**
 * Authentication (#35, plan §3.2).
 *
 * The JWT used to carry `type` (User | Lead | Contact | Account) and the app
 * used it to pick a table. It is no longer read, and nothing downstream may
 * start reading it again: after the merge everyone is an account, so a `type`
 * claim can only be either meaningless or wrong.
 *
 * Tokens minted before the cutover still validate. They carry a `type` that is
 * ignored, and an `id` that may be a source row which lost its merge and is no
 * longer any accounts.id — so the id is resolved through account_source_links
 * before it reaches a route. Tokens expire in 1h, so this matters for one hour
 * after the deploy; the resolve stays because bookmarked ids outlive tokens.
 */
export const auth = async (req: AuthRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.log(`[AUTH] 401: No token provided for ${req.originalUrl}`);
        return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || "your-secret-key-change-this") as any;
        const id = await resolveAccountId(String(decoded.id));
        if (!id) {
            console.log(`[AUTH] 401: token subject ${decoded.id} resolves to no account`);
            return res.status(401).json({ error: 'Unauthorized: Invalid token' });
        }
        req.user = { id, email: decoded.email };
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
 * `app_role` is the authorization axis and the ONLY thing that may open this
 * door. Not `account_tier` (that is what somebody has paid for, #28) and not
 * `sf_object` (that is where their record came from). Today exactly one account
 * carries app_role = 'admin', by a manual pin whose app_role_source = 'manual'
 * keeps the nightly merge from overwriting it — and since sf_profile is NULL on
 * every row, that pin is the only thing standing between this gate and locking
 * everybody out, including its owner. Recovery is a SQL UPDATE; there is no
 * route back in through the UI.
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
            const person = await Account.findById(id).select("appRole");
            if (person?.appRole !== "admin") {
                console.log(`[AUTH] 403: ${id} is not an admin (${req.originalUrl})`);
                return deny();
            }
            next();
        } catch (err: any) {
            console.error("[AUTH] requireAdmin lookup failed:", err.message);
            return deny();
        }
    };
