import express, { Response } from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { OAuth2Client } from 'google-auth-library';
import { auth } from '../middleware/auth.js';
import ApiKeyVault from '../models/ApiKeyVault.js';
import { encrypt } from '../utils/encryption.js';

/**
 * Google Calendar OAuth — lets a user connect their Google account with
 * calendar.events scope so the app can create events on their behalf.
 * The refresh token is stored (encrypted) in the API Key Vault under
 * provider 'google_calendar'.
 *
 * Required env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.
 * The OAuth client in Google Cloud Console must list
 *   <FRONTEND_URL>/api/google-calendar/callback
 * as an authorized redirect URI (the frontend proxies /api/* to this server).
 */

const router = express.Router();
const PROVIDER = 'google_calendar';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

const redirectUri = () =>
    process.env.GOOGLE_REDIRECT_URI ||
    `${process.env.FRONTEND_URL || 'http://localhost:3000'}/api/google-calendar/callback`;

const oauthClient = () => {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured');
    }
    return new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, redirectUri());
};

// ── GET /api/google-calendar/auth-url ─────────────────────────────────────────
// Returns the consent-screen URL. The user's identity rides along in `state`.
router.get('/auth-url', auth, (req: any, res: Response) => {
    try {
        const state = jwt.sign(
            { id: req.user.id, purpose: 'gcal-connect' },
            process.env.JWT_SECRET || 'your-secret-key-change-this',
            { expiresIn: '10m' },
        );
        const url = oauthClient().generateAuthUrl({
            access_type: 'offline',
            prompt: 'consent', // force refresh-token issuance on reconnect
            scope: [SCOPE],
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
    try {
        const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
        if (error) return res.redirect(`${frontend}/profile?gcal=denied`);
        if (!code || !state) return res.redirect(`${frontend}/profile?gcal=error`);

        const decoded = jwt.verify(state, process.env.JWT_SECRET || 'your-secret-key-change-this') as any;
        if (decoded.purpose !== 'gcal-connect') throw new Error('Bad state');

        const { tokens } = await oauthClient().getToken(code);
        if (!tokens.refresh_token) {
            // Happens if consent was previously granted without prompt=consent
            return res.redirect(`${frontend}/profile?gcal=noRefreshToken`);
        }

        const userId = new mongoose.Types.ObjectId(decoded.id as string);
        await ApiKeyVault.findOneAndUpdate(
            { userId, provider: PROVIDER },
            {
                encryptedKeyId: encrypt('oauth-refresh-token'),
                encryptedSecret: encrypt(tokens.refresh_token),
                label: 'Google Calendar (OAuth)',
                updatedAt: new Date(),
            },
            { upsert: true, new: true },
        );
        res.redirect(`${frontend}/profile?gcal=connected`);
    } catch (err: any) {
        console.error('[GCAL] OAuth callback failed:', err.message);
        res.redirect(`${frontend}/profile?gcal=error`);
    }
});

// ── GET /api/google-calendar/status ───────────────────────────────────────────
router.get('/status', auth, async (req: any, res: Response) => {
    try {
        const userId = new mongoose.Types.ObjectId(req.user.id);
        const entry = await ApiKeyVault.findOne({ userId, provider: PROVIDER }).lean();
        res.json({
            connected: !!entry,
            configured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// ── DELETE /api/google-calendar ───────────────────────────────────────────────
router.delete('/', auth, async (req: any, res: Response) => {
    try {
        const userId = new mongoose.Types.ObjectId(req.user.id);
        await ApiKeyVault.findOneAndDelete({ userId, provider: PROVIDER });
        res.json({ ok: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
