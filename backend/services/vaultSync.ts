import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Keeps the EFS-mounted Obsidian vault current while the container runs.
 *
 * entrypoint.sh clones or pulls once at boot; without this loop, anything pushed
 * to the vault afterwards (e.g. the daily morning brief) stays invisible until
 * the next deploy. Pull-only (--ff-only): this container never writes to the
 * vault through git.
 */

const PULL_EVERY_MS = 10 * 60 * 1000;
const PULL_TIMEOUT_MS = 60 * 1000;

export interface VaultSyncStatus {
    at: string | null;
    ok: boolean | null;
    message: string;
}

let status: VaultSyncStatus = { at: null, ok: null, message: 'not pulled since boot' };
let inFlight: Promise<VaultSyncStatus> | null = null;

// The clone URL embeds VAULT_TOKEN (entrypoint.sh); never let it reach a log or a page.
const scrub = (s: string) => s
    .split('\n').filter(l => !l.startsWith('hint:')).join(' ') // keep git's error, drop its advice
    .replace(/oauth2:[^@\s]+@/g, 'oauth2:***@').trim();

export function vaultSyncStatus(): VaultSyncStatus {
    return status;
}

/** Concurrent callers share one pull. Never rejects; the outcome is in the returned status. */
export function pullVault(): Promise<VaultSyncStatus> {
    if (inFlight) return inFlight;
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
    if (!vaultPath || !fs.existsSync(path.join(vaultPath, '.git'))) {
        status = { at: new Date().toISOString(), ok: false, message: 'vault is not a git checkout (OBSIDIAN_VAULT_PATH)' };
        return Promise.resolve(status);
    }
    inFlight = new Promise<VaultSyncStatus>(resolve => {
        execFile('git', ['-C', vaultPath, 'pull', '--ff-only', '--quiet'], { timeout: PULL_TIMEOUT_MS }, (err, _stdout, stderr) => {
            status = err
                ? { at: new Date().toISOString(), ok: false, message: scrub(stderr || err.message).slice(0, 500) }
                : { at: new Date().toISOString(), ok: true, message: 'up to date' };
            if (!status.ok) console.warn(`[vault] pull failed: ${status.message}`);
            inFlight = null;
            resolve(status);
        });
    });
    return inFlight;
}

export function startVaultSyncLoop(): void {
    if (!process.env.OBSIDIAN_VAULT_PATH) return;
    setInterval(() => { void pullVault(); }, PULL_EVERY_MS);
    console.log('[BACKEND] Vault pull loop scheduled (every 10 min).');
}
