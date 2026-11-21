"use client";

import { createSessionClient, type SessionState } from '@gtd/shared/session';
import {
    useRequiredSession as useRequiredSharedSession,
    useSession as useSharedSession,
} from '@gtd/shared/session/react';

export { canAdmin, canPaperclip, type Capabilities, type SessionState, type SessionUser } from '@gtd/shared/session';

/**
 * The portfolio's session client (#210): who is signed in, from the session
 * cookie, asked of the backend. One per tab; see @gtd/shared/session.
 *
 * Nothing about the session lives in localStorage any more. Somebody whose
 * login was only stored there (before this shipped) logs in once more.
 */
export const session = createSessionClient();

// Logins from before #210 left the JWT and the user object in localStorage.
// Nothing reads them now; drop them so they don't linger in the browser.
if (typeof window !== 'undefined') {
    try {
        window.localStorage.removeItem('token');
        window.localStorage.removeItem('user');
    } catch { /* storage blocked: nothing was kept there either */ }
}

/** The session, for any component. `loading` until the backend answers. */
export const useSession = (): SessionState => useSharedSession(session);

/** The session, for a page only a signed-in person may see: signed out goes to log in and back. */
export const useRequiredSession = (): SessionState => useRequiredSharedSession(session);
