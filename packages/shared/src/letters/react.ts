/**
 * The headless Letters hooks (#211, spec #69): each site draws its own
 * markup on top. Pass the app's Letters (`createLetters`) first.
 *
 *   const { threads, totalUnread, markRead } = useThreads(letters, { filter });
 *   const t = useThread(letters, threadKey, { markRead, onSent: typingSent });
 *   const onScroll = useThreadScroll(ref, t.messages, { onNearTop: t.loadOlder, canLoadMore: t.hasMore });
 *   const draft = useAttachmentDraft();
 *
 * Typing ("Theo is writing…") and presence are `@gtd/shared/realtime/react`.
 */
export { useThreads } from "./useThreads";
export { useThread, type UseThreadOptions } from "./useThread";
export { useThreadScroll } from "./useThreadScroll";
export { useAttachmentDraft, type AttachmentDraft } from "./useAttachmentDraft";
