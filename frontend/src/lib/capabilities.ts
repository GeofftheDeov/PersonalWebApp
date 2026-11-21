/**
 * What the signed-in person may do (#35, plan §3.4), asked of the server
 * rather than read from a stored `user` object, which outlived the token and
 * could lie about capability indefinitely. The session client (#210) now
 * holds it beside the person: `useSession().capabilities`.
 *
 * For DISPLAY only. Every surface it gates is also gated server-side, and
 * that gate is the one that matters.
 */
export { canAdmin, canPaperclip, type Capabilities } from './session';
