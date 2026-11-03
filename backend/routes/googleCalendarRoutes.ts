import express, { Response } from 'express';
import { signJwt, verifyJwt } from '../utils/jwt.js';
import { OAuth2Client } from 'google-auth-library';
import { auth } from '../middleware/auth.js';
import ApiKeyVault from '../models/ApiKeyVault.js';
import { GOOGLE_PROVIDER, GOOGLE_SCOPES, loadGoogleGrant, saveGoogleGrant } from '../utils/googleCalendarGrant.js';
import { disableBusySource } from '../planning/busySources.js';
import { originSite, portfolioSite, profilePath, siteForHost, type FrontendSite } from '../utils/frontendSites.js';

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
 * Connect returns to the site it was started on (#215): auth-url puts the
 * originating host in `state`, and the callback sends the person to that
 * site's own page (/profile on the portfolio, /room on Hearthside). A state
 * whose host isn't on the allowlist (utils/frontendSites.ts) is refused. Google
 * always comes back through the one redirect URI below, on the portfolio host;
 * only the final hop goes to Hearthside.
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
        const host = originSite(req).host;
        const state = signJwt({ id: req.user.id, purpose: 'gcal-connect', back, host }, { expiresIn: '10m' });

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
    // Until the state is trusted, anything that goes wrong goes back to the portfolio.
    let site: FrontendSite = portfolioSite();
    let tab = '';
    const back = (result: string) => res.redirect(`${site.origin}${profilePath(site)}?gcal=${result}${tab}`);
    try {
        const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
        if (!state) return back('error');

        const decoded = verifyJwt(state);
        if (decoded.purpose !== 'gcal-connect') throw new Error('Bad state');
        // A state from before #215 carries no host and meant the portfolio. One
        // naming a host off the allowlist was not issued by this environment.
        if (decoded.host !== undefined) {
            const from = siteForHost(decoded.host);
            if (!from) throw new Error(`state names a host that isn't allowed: ${String(decoded.host)}`);
            site = from;
        }
        if (RETURN_TABS.has(decoded.back)) tab = `&tab=${decoded.back}`;
        if (error) return back('denied');
        if (!code) return back('error');

        const { tokens } = await oauthClient().getToken(code);
        if (!tokens.refresh_token) {
            // Happens if consent was previously granted without prompt=consent
            return back('noRefreshToken');
        }

        await saveGoogleGrant(String(decoded.id as string), tokens.refresh_token, tokens.scope);
        back('connected');
    } catch (err: any) {
        console.error('[GCAL] OAuth callback failed:', err.message);
        back('error');
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
