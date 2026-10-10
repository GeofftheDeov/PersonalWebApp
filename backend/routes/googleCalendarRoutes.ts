import express, { Response } from 'express';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { auth } from '../middleware/auth.js';
import ApiKeyVault from '../models/ApiKeyVault.js';
import { GOOGLE_PROVIDER, GOOGLE_SCOPES, loadGoogleGrant, saveGoogleGrant } from '../utils/googleCalendarGrant.js';
import { disableBusySource } from '../planning/busySources.js';

/**
 * Google Calendar OAuth — lets a user connect their Google account so the app
 * can create session events on their behalf (calendar.events) and read when
 * they're busy (calendar.freebusy, #84). The refresh token and the scopes
 * Google granted are stored (encrypted) in the API Key Vault under provider
 * 'google_calendar' (utils/googleCalendarGrant.ts).
 *
 * Connections made before #84 hold calendar.events only, which free/busy does
 * not accept; their owners are asked to reconnect once (`needsReconsent`).
 *
 * Required env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.
 * The OAuth client in Google Cloud Console must list
 *   <FRONTEND_URL>/api/google-calendar/callback
 * as an authorized redirect URI (the frontend proxies /api/* to this server),
 * and its consent screen must list both scopes.
 */

const router = express.Router();

/** Profile tabs the consent screen may send the person back to. */
const RETURN_TABS = new Set(['availability']);

const redirectUri = () =>
    process.env.GOOGLE_REDIRECT_URI ||
    `${process.env.FRONTEND_URL || 'http://localhost:3000'}/api/google-calendar/callback`;

const oauthClient = () => {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured');
    }
    return new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, redirectUri());
};

// ── GET /api/google-calendar/auth-url[?return=availability] ──────────────────
// Returns the consent-screen URL. The user's identity rides along in `state`.
router.get('/auth-url', auth, (req: any, res: Response) => {
    try {
        const back = RETURN_TABS.has(String(req.query.return)) ? String(req.query.return) : undefined;
        const state = jwt.sign(
            { id: req.user.id, purpose: 'gcal-connect', back },
            process.env.JWT_SECRET || 'your-secret-key-change-this',
            { expiresIn: '10m' },
        );
        const url = oauthClient().generateAuthUrl({
            access_type: 'offline',
            prompt: 'consent', // force refresh-token issuance on reconnect
            scope: GOOGLE_SCOPES,
            include_granted_scopes: true,
            state,
        });
        res.json({ url });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/google-calendar/callback ─────────────────────────────────────────
// Google redirects here. No auth header — identity comes from the state JWT.
router.get('/callback', async (req: any, res: Response) => {
    const frontend = process.env.FRONTEND_URL || 'http://localhost:3000';
    let tab = '';
    try {
        const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
        if (!state) return res.redirect(`${frontend}/profile?gcal=error`);

        const decoded = jwt.verify(state, process.env.JWT_SECRET || 'your-secret-key-change-this') as any;
        if (decoded.purpose !== 'gcal-connect') throw new Error('Bad state');
        if (RETURN_TABS.has(decoded.back)) tab = `&tab=${decoded.back}`;
        if (error) return res.redirect(`${frontend}/profile?gcal=denied${tab}`);
        if (!code) return res.redirect(`${frontend}/profile?gcal=error${tab}`);

        const { tokens } = await oauthClient().getToken(code);
        if (!tokens.refresh_token) {
            // Happens if consent was previously granted without prompt=consent
            return res.redirect(`${frontend}/profile?gcal=noRefreshToken${tab}`);
        }

        await saveGoogleGrant(String(decoded.id as string), tokens.refresh_token, tokens.scope);
        res.redirect(`${frontend}/profile?gcal=connected${tab}`);
    } catch (err: any) {
        console.error('[GCAL] OAuth callback failed:', err.message);
        res.redirect(`${frontend}/profile?gcal=error${tab}`);
    }
});

// ── GET /api/google-calendar/status ───────────────────────────────────────────
router.get('/status', auth, async (req: any, res: Response) => {
    try {
        const grant = await loadGoogleGrant(String(req.user.id));
        res.json({
            connected: !!grant,
            configured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
            // Free/busy (#84) needs a scope connections made before it lack.
            freeBusy: !!grant?.canReadFreeBusy,
            needsReconsent: !!grant && !grant.canReadFreeBusy,
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// ── DELETE /api/google-calendar ───────────────────────────────────────────────
// Disconnecting also turns Google off as a busy source and deletes its busy blocks.
router.delete('/', auth, async (req: any, res: Response) => {
    try {
        const userId = String(req.user.id);
        await ApiKeyVault.findOneAndDelete({ userId, provider: GOOGLE_PROVIDER });
        await disableBusySource(userId, 'google');
        res.json({ ok: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
