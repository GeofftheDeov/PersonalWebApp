import { query } from "../db/index.js";

/**
 * Once-per-tick claims for setInterval loops that every backend task runs
 * (#133). With two tasks, or the old and new task overlapping in a deploy,
 * each loop's tick would otherwise run once per task.
 *
 * A loop's row in loop_leases holds when its next run is due. claimLoopTick
 * moves next_due forward in one statement and returns true only for the task
 * that moved it; every other task skips that tick. The row is created on the
 * first claim, so a new loop needs no migration.
 *
 * next_due is set a little short of a full interval (LEASE_FRACTION), so the
 * task that ran the last tick wins its own next tick despite timer jitter,
 * while a second task whose timer fires mid-interval still finds it held.
 */

const LEASE_FRACTION = 0.9;

export async function claimLoopTick(name: string, everyMs: number): Promise<boolean> {
    const leaseMs = Math.floor(everyMs * LEASE_FRACTION);
    const { rowCount } = await query(
        `INSERT INTO loop_leases (name, next_due, claimed_at)
         VALUES ($1, now() + make_interval(secs => $2::double precision / 1000), now())
         ON CONFLICT (name) DO UPDATE
           SET next_due = EXCLUDED.next_due, claimed_at = EXCLUDED.claimed_at
           WHERE loop_leases.next_due <= now()`,
        [name, leaseMs]);
    return rowCount === 1;
}

/**
 * Runs `fn` if this task wins the tick. A failed claim (database down) skips
 * the tick rather than running it unguarded; the next tick tries again.
 */
export async function runLoopTick(name: string, everyMs: number, fn: () => Promise<unknown>): Promise<void> {
    let won: boolean;
    try {
        won = await claimLoopTick(name, everyMs);
    } catch (err: any) {
        console.error(`[loop] ${name}: claiming the tick failed, skipping it:`, err.message);
        return;
    }
    if (won) await fn();
}
