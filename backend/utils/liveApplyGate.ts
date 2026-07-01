// MUR-62 safety gate for the live (real-money) apply-to-personal order path.
//
// Real-money order placement is OFF by default. It cannot execute unless an
// operator has explicitly enabled the kill-switch env var AND:
//   1. The caller is a human board member (positive principal-type check).
//   2. The request carries a valid per-trade server-issued single-use nonce
//      (not a static phrase that can be replayed by any caller).
// See MUR-27 (live stays paper-only in M1), MUR-59, MUR-77 (nonce hardening).

export const LIVE_APPLY_ENABLED_ENV = 'LIVE_APPLY_TO_PERSONAL_ENABLED';

// JWT 'type' values minted by human login flows (password + Google).
// Service/agent tokens do not carry a recognized human type claim.
const HUMAN_PRINCIPAL_TYPES = new Set(['User', 'Lead']);

export interface LiveApplyGateInput {
    enabledEnv: string | undefined;
    /** JWT 'type' claim from the decoded token; absent/undefined on service or agent tokens. */
    principalType: string | undefined;
    /** Per-trade nonce echoed back from the UI after fetching GET /admin/alpaca/live-apply-nonce. */
    confirmNonce: string | undefined;
    /** Callback that atomically validates and consumes a nonce (returns true once, false on replay). */
    verifyNonce: (nonce: string) => boolean;
}

export interface LiveApplyGateResult {
    allowed: boolean;
    status: number;
    code: string;
    error?: string;
}

export function isLiveApplyEnabled(enabledEnv: string | undefined): boolean {
    return enabledEnv === 'true';
}

export function evaluateLiveApplyGate(input: LiveApplyGateInput): LiveApplyGateResult {
    if (!isLiveApplyEnabled(input.enabledEnv)) {
        return {
            allowed: false,
            status: 403,
            code: 'LIVE_APPLY_DISABLED',
            error: `Live apply-to-personal is disabled (MUR-62 safety gate). Real-money order placement is OFF by default and must be explicitly enabled via ${LIVE_APPLY_ENABLED_ENV}=true by a board member.`,
        };
    }
    // Positive caller-identity check: reject any caller that does not carry a
    // recognized human principal type. Human logins (password + Google) mint JWTs
    // with type='User' or type='Lead'. Service tokens (e.g. Salesforce sync) and
    // any future agent tokens do NOT carry a recognized human type — they get 403
    // here even if LIVE_APPLY_TO_PERSONAL_ENABLED is true.
    if (!input.principalType || !HUMAN_PRINCIPAL_TYPES.has(input.principalType)) {
        return {
            allowed: false,
            status: 403,
            code: 'LIVE_APPLY_AGENT_FORBIDDEN',
            error: 'Live apply-to-personal requires an interactive human board-member session. Service and agent tokens are not permitted to place real-money orders.',
        };
    }
    // Per-trade single-use nonce: the UI must fetch a fresh nonce from
    // GET /admin/alpaca/live-apply-nonce and echo it back in X-Live-Apply-Nonce.
    // The nonce is server-issued, time-bounded (5 min TTL), and single-use.
    // Replayed or expired nonces are rejected even if the env is ON.
    if (!input.confirmNonce || !input.verifyNonce(input.confirmNonce)) {
        return {
            allowed: false,
            status: 403,
            code: 'LIVE_APPLY_NONCE_INVALID',
            error: 'Live apply-to-personal requires a valid, unexpired, unused per-trade confirmation nonce. Fetch one from GET /admin/alpaca/live-apply-nonce and echo it in the X-Live-Apply-Nonce header.',
        };
    }
    return { allowed: true, status: 200, code: 'LIVE_APPLY_ALLOWED' };
}
