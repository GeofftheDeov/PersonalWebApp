// MUR-62 safety gate for the live (real-money) apply-to-personal order path.
//
// Real-money order placement is OFF by default. It cannot execute unless an
// operator has explicitly enabled the kill-switch env var AND the request
// carries an explicit, per-trade interactive confirmation. Non-interactive /
// agent / service-token callers do not supply that confirmation and are
// rejected server-side. See MUR-27 (live stays paper-only in M1) and MUR-59.

export const LIVE_APPLY_CONFIRM_PHRASE = 'I CONFIRM LIVE ORDERS';
export const LIVE_APPLY_ENABLED_ENV = 'LIVE_APPLY_TO_PERSONAL_ENABLED';

export interface LiveApplyGateInput {
    enabledEnv: string | undefined;
    confirmHeader: unknown;
    confirmBody: unknown;
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
    // Even when enabled: require an explicit, per-trade interactive confirmation.
    // Automated / agent / service-token callers do not supply this and are rejected.
    if (input.confirmHeader !== LIVE_APPLY_CONFIRM_PHRASE || input.confirmBody !== LIVE_APPLY_CONFIRM_PHRASE) {
        return {
            allowed: false,
            status: 403,
            code: 'LIVE_APPLY_CONFIRMATION_REQUIRED',
            error: 'Live apply-to-personal requires an explicit, per-trade interactive confirmation. Non-interactive, agent, and service-token callers are not permitted to place real-money orders.',
        };
    }
    return { allowed: true, status: 200, code: 'LIVE_APPLY_ALLOWED' };
}
