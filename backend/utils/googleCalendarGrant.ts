import ApiKeyVault from '../models/ApiKeyVault.js';
import { decrypt, encrypt } from './encryption.js';

/**
 * A person's Google Calendar connection: the OAuth refresh token in their API
 * Key Vault (provider 'google_calendar') and the scopes Google granted it.
 *
 * Scopes matter because free/busy (#84) does not work with calendar.events,
 * the only scope connections asked for before #84. freeBusy.query accepts
 * calendar.freebusy, calendar.readonly, calendar or calendar.events.freebusy:
 *   https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query
 * We ask for calendar.freebusy, the narrowest ("View your availability in
 * your calendars"): it never exposes event titles.
 *
 * The granted scopes ride in the vault entry's key id, which until now held
 * the constant 'oauth-refresh-token':
 *   'oauth-refresh-token'                         before #84: calendar.events only
 *   'oauth-refresh-token;scope=<space-separated>' since #84: what Google granted
 * so a connection made before #84 reads as lacking free/busy, and its owner is
 * asked to reconnect once. Google's granular consent lets a person untick a
 * scope, so what was granted is recorded rather than assumed.
 */

export const GOOGLE_PROVIDER = 'google_calendar';
export const SCOPE_EVENTS = 'https://www.googleapis.com/auth/calendar.events';
export const SCOPE_FREEBUSY = 'https://www.googleapis.com/auth/calendar.freebusy';
/** What a new connection asks for: creating session events, and reading free/busy. */
export const GOOGLE_SCOPES = [SCOPE_EVENTS, SCOPE_FREEBUSY];

/** Any of these lets freeBusy.query run. */
const FREEBUSY_CAPABLE = new Set([
    SCOPE_FREEBUSY,
    'https://www.googleapis.com/auth/calendar.events.freebusy',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar',
]);

const KEY_ID = 'oauth-refresh-token';
const LEGACY_SCOPES = [SCOPE_EVENTS];

export interface GoogleGrant {
    refreshToken: string;
    scopes: string[];
    canReadFreeBusy: boolean;
}

/** The scopes recorded in a vault key id. Anything without a record is a pre-#84 connection. */
export function scopesFromKeyId(keyId: string): string[] {
    const marker = `${KEY_ID};scope=`;
    return keyId.startsWith(marker) ? keyId.slice(marker.length).split(' ').filter(Boolean) : LEGACY_SCOPES;
}

export const canReadFreeBusy = (scopes: string[]) => scopes.some((s) => FREEBUSY_CAPABLE.has(s));

/**
 * Stores (or replaces) a person's connection. `grantedScope` is the token
 * response's space-separated `scope`; when Google leaves it out, the scopes
 * that were asked for are assumed.
 */
export async function saveGoogleGrant(userId: string, refreshToken: string, grantedScope: string | null | undefined) {
    const scopes = (grantedScope ?? '').split(' ').filter(Boolean);
    const recorded = scopes.length ? scopes : GOOGLE_SCOPES;
    await ApiKeyVault.findOneAndUpdate(
        { userId, provider: GOOGLE_PROVIDER },
        {
            encryptedKeyId: encrypt(`${KEY_ID};scope=${recorded.join(' ')}`),
            encryptedSecret: encrypt(refreshToken),
            label: 'Google Calendar (OAuth)',
            updatedAt: new Date(),
        },
        { upsert: true, new: true },
    );
}

/** The person's connection, or null when they have none (or it can't be decrypted). */
export async function loadGoogleGrant(userId: string): Promise<GoogleGrant | null> {
    const entry: any = await ApiKeyVault.findOne({ userId, provider: GOOGLE_PROVIDER }).lean();
    if (!entry) return null;
    try {
        const scopes = scopesFromKeyId(decrypt(entry.encryptedKeyId));
        return { refreshToken: decrypt(entry.encryptedSecret), scopes, canReadFreeBusy: canReadFreeBusy(scopes) };
    } catch {
        return null;
    }
}
