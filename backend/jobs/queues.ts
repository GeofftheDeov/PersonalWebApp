import { Redis } from "ioredis";

export const QUEUE_NAMES = {
    NOTION_SYNC: "notion-sync",
    SF_WRITEBACK: "salesforce-writeback",
} as const;

export const DEFAULT_JOB_OPTS = {
    attempts: 5,
    backoff: { type: "exponential" as const, delay: 30_000 }, // 30s → 60s → 120s → 240s → 480s
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 100 },
};

let _conn: Redis | null = null;

/**
 * Returns a shared ioredis instance configured for BullMQ.
 * Returns null when REDIS_URL is unset (local dev without Docker).
 * BullMQ requires maxRetriesPerRequest: null for blocking commands.
 */
export function getBullConnection(): Redis | null {
    if (!process.env.REDIS_URL) return null;
    if (!_conn) {
        _conn = new Redis(process.env.REDIS_URL, {
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
        });
        _conn.on("error", (err) => console.error("[bullmq] redis:", err.message));
    }
    return _conn;
}

export async function closeBullConnection(): Promise<void> {
    if (_conn) {
        await _conn.quit().catch(() => {});
        _conn = null;
    }
}
