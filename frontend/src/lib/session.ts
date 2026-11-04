"use client";

import {
    createSessionClient,
    useRequiredSession as useRequiredSharedSession,
    useSession as useSharedSession,
    type SessionState,
} from '@gtd/shared/session';

export { canAdmin, canPaperclip, type Capabilities, type SessionState, type SessionUser } from '@gtd/shared/session';

/**
 * The portfolio's session client (#210): who is signed in, from the session
 * cookie, asked of the backend. One per tab; see @gtd/shared/session.
 *
 * Nothing about the session lives in localStorage any more. Somebody whose
 * login was only stored there (before this shipped) logs in once more.
 */
export const session = createSessionClient();

/** The session, for any component. `loading` until the backend answers. */
export const useSession = (): SessionState => useSharedSession(session);

/** The session, for a page only a signed-in person may see: signed out goes to log in and back. */
export const useRequiredSession = (): SessionState => useRequiredSharedSession(session);

/** The signed-in account's id, or null. For "is this mine" outside React state. */
export const currentUserId = (): string | null => session.getState().user?.id ?? null;
