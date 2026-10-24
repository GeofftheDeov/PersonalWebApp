/**
 * Answering a run proposal by voice or text (#151 of spec #135, W3): which
 * short utterances mean "yes, run it" and which mean "no, don't".
 *
 * The page (os/page.ts) answers these itself while a proposal is pending: a
 * confirm calls OS.confirm(), a cancel OS.dismiss(), and nothing reaches the
 * router. Outside a pending proposal they go to the router like any ask, and
 * tier 1 answers "Nothing to confirm." / "Nothing to cancel." (os/commands.ts),
 * so the model is never called for them.
 *
 * Both sides match the same patterns against the same normalisation
 * (normaliseAsk: lowercase, apostrophes dropped, other punctuation a space,
 * whitespace collapsed), so "Yes!", "yes." and "Yes, do it" all count.
 * PROPOSAL_REPLY_JS is the page's copy, built from the same pattern sources.
 *
 * "stop" counts as a cancel: said while a proposal is pending, it dismisses
 * it. The stop button is different: it only silences speech and leaves the
 * proposal's buttons up (os/voice.ts).
 */

/** Yes, confirm, do it, go ahead, and short variants ("yeah do it", "ok go ahead", "yes please"). */
const CONFIRM_SOURCE = "^(?:(?:yes|yeah|yep|yup|yea|sure|ok|okay)(?: (?:confirm|confirmed|do it|go ahead|go for it|run it))?"
    + "|confirm|confirmed|confirm it|do it|go ahead|go for it|run it)(?: please| thanks| thank you)?$";

/** No, cancel, stop, never mind, and short variants ("no thanks", "no cancel it", "dont run it"). */
const CANCEL_SOURCE = "^(?:(?:no|nope|nah)(?: (?:thanks|thank you|cancel|cancel it|cancel that|stop|dont|never mind))?"
    + "|cancel|cancel it|cancel that|stop|never mind|nevermind|forget it|dont|dont do it|dont run it)(?: please)?$";

export const CONFIRM_PATTERN = new RegExp(CONFIRM_SOURCE);
export const CANCEL_PATTERN = new RegExp(CANCEL_SOURCE);

export type ProposalReply = "confirm" | "cancel";

/** What an already-normalised utterance says to a pending proposal, or null for anything else. */
export function proposalReply(normalised: string): ProposalReply | null {
    if (CONFIRM_PATTERN.test(normalised)) return "confirm";
    if (CANCEL_PATTERN.test(normalised)) return "cancel";
    return null;
}

/**
 * The page's matcher, as a function expression: proposalReply(text) takes the
 * raw text, normalises it the way normaliseAsk does, and returns 'confirm',
 * 'cancel' or null. scripts/test-os-speech.ts checks it agrees with the server.
 */
export const PROPOSAL_REPLY_JS = String.raw`function proposalReply(text) {
    var t = String(text || '');
    if (t.normalize) t = t.normalize('NFC');
    t = t.toLowerCase()
        .replace(/['‘’${"`"}]/g, '')
        .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (new RegExp(${JSON.stringify(CONFIRM_SOURCE)}).test(t)) return 'confirm';
    if (new RegExp(${JSON.stringify(CANCEL_SOURCE)}).test(t)) return 'cancel';
    return null;
}`;
