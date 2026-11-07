import type { MessageAttachment } from "../realtime/liveClient";

/** Which threads a list shows. */
export type ThreadFilter = "all" | "campaigns" | "friends";

/** One row of the thread list (GET /api/threads). It never carries message text. */
export interface ThreadSummary {
  /** `campaign:<campaign id>` or `dm:<sorted id pair>`. */
  threadKey: string;
  kind: "campaign" | "dm";
  /** What to open: the campaign id, or the friend's account id. */
  targetId: string;
  title: string;
  /** Up to two initials to draw an avatar from. */
  avatarHint: string;
  /** "Campaign · 5 in the party" or "Friend". */
  subtitle: string;
  /** ISO time of the newest message, or null if nobody has written yet. */
  lastActivityAt: string | null;
  unreadCount: number;
}

/** One message in an open thread's log (`useThread`). */
export interface ThreadEntry {
  /** Stable React key: the clientId for your own sends, else the message id. */
  key: string;
  /** The stored message's id; null until the server has it. */
  id: string | null;
  sender: { id: string; name: string };
  body: string;
  createdAt: string;
  eventId?: string;
  /** Stored attachments, each with a read URL (#104). */
  attachments?: MessageAttachment[];
  /** Your unsent files, in order (#104). */
  files?: File[];
  /** Keys of `files` already uploaded, by index, so a resend doesn't upload them again. */
  uploadedKeys?: (string | undefined)[];
  state: "sent" | "sending" | "failed";
  /** Why a failed send failed. */
  error?: string;
}
