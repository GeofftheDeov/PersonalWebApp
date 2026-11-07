/**
 * Letters (spec #58), the parts both sites share (#211), framework-free: the
 * wiring every hook takes (`createLetters`), thread shapes, and attachment
 * limits and upload. The headless React hooks (thread list, thread history,
 * send, mark read, scroll, attachment picking) are `@gtd/shared/letters/react`;
 * typing and presence are `@gtd/shared/realtime/react`.
 */
export { createLetters, type Letters, type LettersOptions } from "./letters";
export type { ThreadEntry, ThreadFilter, ThreadSummary } from "./types";
export {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TYPES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  attachmentProblem,
  formatBytes,
  isImageType,
  uploadAttachment,
} from "./attachments";
