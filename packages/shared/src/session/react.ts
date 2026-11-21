import { useEffect, useSyncExternalStore } from "react";
import { LOADING, type SessionClient, type SessionState } from "./client";

/**
 * The session as React state (#210). Asks the backend the first time any
 * component needs it; every component using the same client shares the one
 * answer and re-renders when it changes (login, logout, expiry).
 *
 * The server render, and the first client render, are `loading`: nobody is
 * known to be signed in until the backend says so.
 */
export function useSession(client: SessionClient): SessionState {
  const state = useSyncExternalStore(client.subscribe, client.getState, () => LOADING);
  useEffect(() => { client.ensure(); }, [client]);
  return state;
}

/**
 * The session, for a page only a signed-in person may see. Once the backend
 * says nobody is signed in, it sends the browser to log in, returning here.
 * Render nothing private until `status` is `signedIn`.
 */
export function useRequiredSession(client: SessionClient): SessionState {
  const state = useSession(client);
  useEffect(() => {
    if (state.status === "signedOut") client.redirectToLogin();
  }, [client, state.status]);
  return state;
}
