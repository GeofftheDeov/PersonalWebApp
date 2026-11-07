/**
 * The Letters live channel (#98, spec #58), framework-free: the client, typing
 * indicators and thread keys. The React hooks are `@gtd/shared/realtime/react`.
 * The wire protocol is backend/live/PROTOCOL.md.
 */
export {
  CLOSE_UNAUTHORIZED,
  CLOSE_UNSUPPORTED_VERSION,
  LiveClient,
  PROTOCOL_VERSION,
  type LiveClientOptions,
  type LiveMessage,
  type LivePresence,
  type LiveStatus,
  type LiveTyping,
  type MessageAttachment,
  type PersonHandlers,
  type ThreadHandlers,
  type ThreadRead,
  type ThreadStatus,
  type ThreadUpdate,
} from "./liveClient";
export {
  TYPING_EXPIRY_MS,
  TYPING_THROTTLE_MS,
  TypingTracker,
  typingLabel,
  type Typist,
} from "./typing";
export { campaignThreadKey, dmThreadKey } from "./threadKeys";
export { createLiveConnection, type LiveConnectionOptions, type LiveSource } from "./connection";
