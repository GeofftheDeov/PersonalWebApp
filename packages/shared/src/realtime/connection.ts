import type { SessionClient } from "../session";
import { LiveClient, type LiveClientOptions } from "./liveClient";

/** Anything that hands out the tab's live client: a connection, or the Letters wiring built on one. */
export interface LiveSource {
  liveClient(): LiveClient;
}

export interface LiveConnectionOptions {
  /** The app's session client: the socket follows who is signed in. */
  session: SessionClient;
  /** Where the live channel is. Defaults to `/api/live` on the page's own host, through the app's /api rewrite. */
  url?: () => string;
  /** Makes the client. Tests pass a stand-in; apps leave it out. */
  createClient?: (options: LiveClientOptions) => LiveClient;
}

const sameOriginLiveUrl = () =>
  `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/api/live`;

/**
 * The tab's one live-channel socket (#98), shared by every thread view, the
 * thread list and the Notice Board. Made when first asked for, so nothing
 * connects during a server render. One per app, beside its session client:
 *
 *   const live = createLiveConnection({ session });
 *   live.liveClient().subscribe(thread, handlers);
 *
 * The browser has no token (#210): the session cookie authenticates the
 * upgrade (#107), so no auth frame is sent.
 */
export function createLiveConnection(options: LiveConnectionOptions): LiveSource {
  const { session } = options;
  const make = options.createClient ?? ((o: LiveClientOptions) => new LiveClient(o));
  let client: LiveClient | null = null;

  return {
    liveClient() {
      if (client) return client;
      const live = make({ url: options.url ?? sameOriginLiveUrl, getToken: () => null, cookieAuth: true });
      client = live;
      // A socket refused for an expired session (4001) stays closed; once the
      // person signs in again, connect with the new cookie. Signing out closes
      // it: the server would otherwise keep it open as them. Signing in as
      // someone else without logging out first reconnects too, so the socket
      // never carries the previous person's threads. The socket is whoever
      // is signed in now, since no change will be announced for them.
      let connectedAs: string | null = session.getState().user?.id ?? null;
      session.subscribe(() => {
        const { status, user } = session.getState();
        if (status === "signedIn") {
          if (connectedAs !== null && connectedAs !== user.id) live.close();
          connectedAs = user.id;
          live.resume();
        } else if (status === "signedOut") {
          connectedAs = null;
          live.close();
        }
      });
      return live;
    },
  };
}
