// MUR-62 verification — run with: npx tsx backend/utils/liveApplyGate.test.ts
// Proves the live apply-to-personal path cannot auto-execute: it is OFF by
// default and rejects non-interactive / agent / service-token callers.
import assert from 'node:assert/strict';
import { evaluateLiveApplyGate, LIVE_APPLY_CONFIRM_PHRASE } from './liveApplyGate.js';

let passed = 0;
function check(name: string, fn: () => void) {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
}

// Default OFF (env unset): blocked, regardless of confirmation present.
check('default (env unset) blocks even with valid confirmation', () => {
    const r = evaluateLiveApplyGate({
        enabledEnv: undefined,
        confirmHeader: LIVE_APPLY_CONFIRM_PHRASE,
        confirmBody: LIVE_APPLY_CONFIRM_PHRASE,
    });
    assert.equal(r.allowed, false);
    assert.equal(r.status, 403);
    assert.equal(r.code, 'LIVE_APPLY_DISABLED');
});

// Anything other than 'true' stays off.
check("env='1' / 'false' do not enable", () => {
    for (const v of ['1', 'false', 'TRUE', 'yes', '']) {
        assert.equal(evaluateLiveApplyGate({ enabledEnv: v, confirmHeader: LIVE_APPLY_CONFIRM_PHRASE, confirmBody: LIVE_APPLY_CONFIRM_PHRASE }).allowed, false);
    }
});

// Enabled but agent / service-token caller (no confirmation): rejected.
check('enabled + no confirmation (agent caller) is rejected', () => {
    const r = evaluateLiveApplyGate({ enabledEnv: 'true', confirmHeader: undefined, confirmBody: undefined });
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'LIVE_APPLY_CONFIRMATION_REQUIRED');
});

// Enabled but only one of header/body present: rejected.
check('enabled + partial confirmation is rejected', () => {
    assert.equal(evaluateLiveApplyGate({ enabledEnv: 'true', confirmHeader: LIVE_APPLY_CONFIRM_PHRASE, confirmBody: undefined }).allowed, false);
    assert.equal(evaluateLiveApplyGate({ enabledEnv: 'true', confirmHeader: undefined, confirmBody: LIVE_APPLY_CONFIRM_PHRASE }).allowed, false);
});

// Enabled + full explicit interactive confirmation: allowed.
check('enabled + explicit interactive confirmation is allowed', () => {
    const r = evaluateLiveApplyGate({ enabledEnv: 'true', confirmHeader: LIVE_APPLY_CONFIRM_PHRASE, confirmBody: LIVE_APPLY_CONFIRM_PHRASE });
    assert.equal(r.allowed, true);
    assert.equal(r.status, 200);
});

console.log(`\nMUR-62 live-apply gate: ${passed} checks passed.`);
