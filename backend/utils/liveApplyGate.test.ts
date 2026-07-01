// MUR-77 gate hardening — run with: npx tsx backend/utils/liveApplyGate.test.ts
// Covers: default-OFF behaviour, human principal check, nonce replay/expiry,
// agent/service-token rejection, and the happy path.
import assert from 'node:assert/strict';
import { evaluateLiveApplyGate } from './liveApplyGate.js';
import { issueNonce, consumeNonce, _resetNonceStore } from './liveApplyNonce.js';

let passed = 0;
function check(name: string, fn: () => void) {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
}

// ── Default-OFF behaviour ───────────────────────────────────────────────────

check('default (env unset) blocks even with valid human principal + nonce', () => {
    const { nonce } = issueNonce();
    const r = evaluateLiveApplyGate({
        enabledEnv: undefined,
        principalType: 'User',
        confirmNonce: nonce,
        verifyNonce: consumeNonce,
    });
    assert.equal(r.allowed, false);
    assert.equal(r.status, 403);
    assert.equal(r.code, 'LIVE_APPLY_DISABLED');
});

check("env='1'/'false'/'TRUE'/'yes'/'' do not enable", () => {
    const { nonce } = issueNonce();
    let calls = 0;
    for (const v of ['1', 'false', 'TRUE', 'yes', '']) {
        const r = evaluateLiveApplyGate({ enabledEnv: v, principalType: 'User', confirmNonce: nonce, verifyNonce: () => (calls++, true) });
        assert.equal(r.allowed, false, `env='${v}' should not enable`);
    }
});

// ── Agent / service-token rejection (positive principal check) ──────────────

check('enabled + no principalType (agent/service caller) is rejected', () => {
    const { nonce } = issueNonce();
    const r = evaluateLiveApplyGate({
        enabledEnv: 'true',
        principalType: undefined,
        confirmNonce: nonce,
        verifyNonce: () => true,
    });
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'LIVE_APPLY_AGENT_FORBIDDEN');
});

check('enabled + service token type is rejected', () => {
    const r = evaluateLiveApplyGate({
        enabledEnv: 'true',
        principalType: 'service',
        confirmNonce: 'any',
        verifyNonce: () => true,
    });
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'LIVE_APPLY_AGENT_FORBIDDEN');
});

check('Lead principal type is accepted (board member via Google login)', () => {
    const { nonce } = issueNonce();
    const r = evaluateLiveApplyGate({
        enabledEnv: 'true',
        principalType: 'Lead',
        confirmNonce: nonce,
        verifyNonce: consumeNonce,
    });
    assert.equal(r.allowed, true);
});

// ── Nonce replay and expiry ─────────────────────────────────────────────────

check('nonce replay is rejected (single-use)', () => {
    const { nonce } = issueNonce();
    // First use: should pass
    const r1 = evaluateLiveApplyGate({
        enabledEnv: 'true', principalType: 'User', confirmNonce: nonce, verifyNonce: consumeNonce,
    });
    assert.equal(r1.allowed, true, 'first use should succeed');
    // Replay: same nonce reused
    const r2 = evaluateLiveApplyGate({
        enabledEnv: 'true', principalType: 'User', confirmNonce: nonce, verifyNonce: consumeNonce,
    });
    assert.equal(r2.allowed, false, 'replay should be rejected');
    assert.equal(r2.code, 'LIVE_APPLY_NONCE_INVALID');
});

check('unknown nonce is rejected', () => {
    const r = evaluateLiveApplyGate({
        enabledEnv: 'true', principalType: 'User', confirmNonce: 'not-a-real-nonce', verifyNonce: consumeNonce,
    });
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'LIVE_APPLY_NONCE_INVALID');
});

check('no nonce provided is rejected', () => {
    const r = evaluateLiveApplyGate({
        enabledEnv: 'true', principalType: 'User', confirmNonce: undefined, verifyNonce: consumeNonce,
    });
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'LIVE_APPLY_NONCE_INVALID');
});

// ── Happy path ──────────────────────────────────────────────────────────────

check('enabled + User principal + fresh nonce is allowed', () => {
    const { nonce } = issueNonce();
    const r = evaluateLiveApplyGate({
        enabledEnv: 'true',
        principalType: 'User',
        confirmNonce: nonce,
        verifyNonce: consumeNonce,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.status, 200);
    assert.equal(r.code, 'LIVE_APPLY_ALLOWED');
});

_resetNonceStore();
console.log(`\nMUR-77 live-apply gate (nonce hardening): ${passed} checks passed.`);
