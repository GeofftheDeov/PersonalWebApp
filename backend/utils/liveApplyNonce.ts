// MUR-77: per-trade single-use time-bounded nonce store for the live apply gate.
// Nonces are issued by GET /admin/alpaca/live-apply-nonce and consumed exactly
// once by the apply-to-personal POST. Replay and expired nonces are rejected.
import { randomBytes } from 'node:crypto';

const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface NonceRecord {
    expiresAt: number;
    used: boolean;
}

const nonceStore = new Map<string, NonceRecord>();

let cleanupTimer: NodeJS.Timeout | null = null;
function ensureCleanup(): void {
    if (cleanupTimer) return;
    cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [k, v] of nonceStore.entries()) {
            if (v.expiresAt < now) nonceStore.delete(k);
        }
    }, NONCE_TTL_MS);
    // Don't block process exit
    if (cleanupTimer.unref) cleanupTimer.unref();
}

export function issueNonce(): { nonce: string; expiresAt: string } {
    ensureCleanup();
    const nonce = randomBytes(32).toString('hex');
    nonceStore.set(nonce, { expiresAt: Date.now() + NONCE_TTL_MS, used: false });
    return { nonce, expiresAt: new Date(Date.now() + NONCE_TTL_MS).toISOString() };
}

// Atomically validates and consumes a nonce. Returns false if missing, expired,
// or already used. Returns true and marks used if valid (single-use guarantee).
export function consumeNonce(nonce: string | undefined): boolean {
    if (!nonce) return false;
    const record = nonceStore.get(nonce);
    if (!record || record.used || Date.now() > record.expiresAt) {
        if (record) nonceStore.delete(nonce);
        return false;
    }
    record.used = true;
    return true;
}

// Test helper: reset store between test runs
export function _resetNonceStore(): void {
    nonceStore.clear();
}
