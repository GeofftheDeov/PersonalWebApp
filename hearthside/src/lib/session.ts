"use client";

import { createSessionClient, type SessionState } from '@gtd/shared/session';
import {
    useRequiredSession as useRequiredSharedSession,
    useSession as useSharedSession,
} from '@gtd/shared/session/react';

export { canAdmin, canPaperclip, type Capabilities, type SessionState, type SessionUser } from '@gtd/shared/session';

/**
 * Hearthside's session client (#210, #216): who is signed in, from the
 * session cookie the portfolio shares, asked of the backend. One per tab; see
 * @gtd/shared/session. An expired session goes to Hearthside's own `/login`
 * (#219), coming back to the page it left.
 */
export const session = createSessionClient();

/** The session, for any component. `loading` until the backend answers. */
export const useSession = (): SessionState => useSharedSession(session);

/** The session, for a page only a signed-in person may see: signed out goes to log in and back. */
export const useRequiredSession = (): SessionState => useRequiredSharedSession(session);
