import type { ApiClient } from "../api";
import type { SessionClient } from "../session";
import { createLiveConnection, type LiveSource } from "../realtime/connection";
import type { LiveClient, LiveClientOptions } from "../realtime/liveClient";
import { campaignThreadKey, dmThreadKey } from "../realtime/threadKeys";
import { uploadAttachment } from "./attachments";

export interface LettersOptions {
  /** The app's API client (`createApiClient`, with `onUnauthorized` ending the session). */
  api: ApiClient;
  /** The app's session client: who "you" are in a thread, and who the live socket belongs to. */
  session: SessionClient;
  /** Where the live channel is. Defaults to `/api/live` on the page's own host. */
  liveUrl?: () => string;
  /** Makes the storage PUT for attachments. Tests pass a stand-in. */
  fetch?: typeof fetch;
  /** Makes the live client. Tests pass a stand-in. */
  createLiveClient?: (options: LiveClientOptions) => LiveClient;
}

/**
 * What every Letters hook needs, made once per app beside its session and API
 * clients (#211, spec #69). Each app passes it to the hooks in
 * `@gtd/shared/letters/react` and `@gtd/shared/realtime/react`, and to the
 * top bar:
 *
 *   export const letters = createLetters({ api, session });
 *   const t = useThread(letters, letters.threadKeyFor('campaign', id));
 */
export interface Letters extends LiveSource {
  readonly api: ApiClient;
  readonly session: SessionClient;
  /** The tab's one live-channel client, made when first asked for. */
  liveClient(): LiveClient;
  /** The thread key for a campaign's Table Talk, or for your DM with a friend (null while nobody is signed in). */
  threadKeyFor(kind: "campaign" | "dm", id: string): string | null;
  /** Uploads one file for a thread (#104) and returns its key. Throws an Error fit to show. */
  uploadAttachment(threadKey: string, file: File): Promise<string>;
}

export function createLetters(options: LettersOptions): Letters {
  const { api, session } = options;
  const live = createLiveConnection({ session, url: options.liveUrl, createClient: options.createLiveClient });
  const put: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  return {
    api,
    session,
    liveClient: () => live.liveClient(),
    threadKeyFor(kind, id) {
      if (kind === "campaign") return campaignThreadKey(id);
      const me = session.getState().user?.id;
      return me ? dmThreadKey(me, id) : null;
    },
    uploadAttachment: (threadKey, file) => uploadAttachment(api, threadKey, file, put),
  };
}
