/**
 * The GeofftheDeov top bar (#211, spec #69), in the portfolio's look on both
 * sites: the nav, the notifications bell and the social dock, with the dock's
 * thread view. Tailwind-styled, so each app's Tailwind must scan
 * `packages/shared/src` (see test/tailwind-content.test.ts), and it uses the
 * portfolio's `font-permanent` and `custom-scrollbar` classes from the app's
 * global CSS.
 *
 * The attachment pieces are here too, since the dock's thread view draws them
 * in the same look; the portfolio's Table Talk uses them as well.
 */
export { default as TopBar, type TopBarProps, type TopBarSite } from "./TopBar";
export { default as NotificationsBell } from "./NotificationsBell";
export { default as SocialDock } from "./SocialDock";
export { default as ChatThread, type ChatChannel } from "./ChatThread";
export { AttachButton, DraftAttachments, MessageAttachments } from "./MessageAttachments";
