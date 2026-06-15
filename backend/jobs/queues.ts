import { Queue } from "bullmq";

export const QUEUE_NAMES = {
    NOTION_SYNC: "notion-sync",
    SF_WRITEBACK: "salesforce-writeback",
    NOTION_WRITEBACK: "notion-writeback",
    SF_POLL: "salesforce-poll",
} as const;

export const DEFAULT_JOB_OPTS = {
    attempts: 5,
    backoff: { type: "exponential" as const, delay: 30_000 }, // 30s → 60s → 120s → 240s → 480s
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 100 },
};

const NOTION_POLL_EVERY_MS = 15 * 60 * 1000; // every 15 minutes
const SF_POLL_EVERY_MS = 15 * 60 * 1000; // every 15 minutes

let _notionQueue: Queue | null = null;
let _sfQueue: Queue | null = null;
let _notionWritebackQueue: Queue | null = null;
let _sfPollQueue: Queue | null = null;

/**
 * Returns BullMQ connection options derived from REDIS_URL.
 * Returns null when REDIS_URL is unset (local dev).
 * We use options rather than a shared ioredis instance so BullMQ can use its
 * bundled ioredis version, avoiding type mismatches.
 */
export function getBullConnectionOptions(): { url: string; maxRetriesPerRequest: null; enableReadyCheck: false } | null {
    if (!process.env.REDIS_URL) return null;
    return {
        url: process.env.REDIS_URL,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
    };
}

export function getNotionSyncQueue(): Queue | null {
    const opts = getBullConnectionOptions();
    if (!opts) return null;
    if (!_notionQueue) {
        _notionQueue = new Queue(QUEUE_NAMES.NOTION_SYNC, { connection: opts });
    }
    return _notionQueue;
}

export function getSFWritebackQueue(): Queue | null {
    const opts = getBullConnectionOptions();
    if (!opts) return null;
    if (!_sfQueue) {
        _sfQueue = new Queue(QUEUE_NAMES.SF_WRITEBACK, { connection: opts });
    }
    return _sfQueue;
}

export function getNotionWritebackQueue(): Queue | null {
    const opts = getBullConnectionOptions();
    if (!opts) return null;
    if (!_notionWritebackQueue) {
        _notionWritebackQueue = new Queue(QUEUE_NAMES.NOTION_WRITEBACK, { connection: opts });
    }
    return _notionWritebackQueue;
}

export function getSFPollQueue(): Queue | null {
    const opts = getBullConnectionOptions();
    if (!opts) return null;
    if (!_sfPollQueue) {
        _sfPollQueue = new Queue(QUEUE_NAMES.SF_POLL, { connection: opts });
    }
    return _sfPollQueue;
}

/** Fire-and-forget: enqueue a Salesforce writeback for a task. */
export function enqueueSFWriteback(taskId: string): void {
    const q = getSFWritebackQueue();
    if (!q) return;
    q.add("sf-writeback", { taskId }, { ...DEFAULT_JOB_OPTS })
        .catch((err) => console.error("[queues] Failed to enqueue SF writeback:", err.message));
}

/** Fire-and-forget: enqueue a Notion writeback for a task. */
export function enqueueNotionWriteback(taskId: string): void {
    const q = getNotionWritebackQueue();
    if (!q) return;
    q.add("notion-writeback", { taskId }, { ...DEFAULT_JOB_OPTS })
        .catch((err) => console.error("[queues] Failed to enqueue Notion writeback:", err.message));
}

/**
 * Register repeatable jobs. Idempotent — safe to call on every boot.
 * Uses upsertJobScheduler so re-registering on restart doesn't create duplicates.
 */
export async function registerRepeatableJobs(): Promise<void> {
    const notionQ = getNotionSyncQueue();
    if (!notionQ) {
        console.log("[bullmq] No Redis — skipping repeatable job registration (local dev)");
        return;
    }
    await notionQ.upsertJobScheduler(
        "notion-poll",
        { every: NOTION_POLL_EVERY_MS },
        { name: "notion-poll", data: {}, opts: { ...DEFAULT_JOB_OPTS } }
    );
    console.log("[bullmq] Registered repeatable notion-sync job (every 15 min)");

    const sfPollQ = getSFPollQueue();
    if (sfPollQ) {
        await sfPollQ.upsertJobScheduler(
            "sf-poll",
            { every: SF_POLL_EVERY_MS },
            { name: "sf-poll", data: {}, opts: { ...DEFAULT_JOB_OPTS } }
        );
        console.log("[bullmq] Registered repeatable salesforce-poll job (every 15 min)");
    }
}

export async function closeBullConnection(): Promise<void> {
    await Promise.all([
        _notionQueue?.close(),
        _sfQueue?.close(),
        _notionWritebackQueue?.close(),
        _sfPollQueue?.close(),
    ]);
    _notionQueue = null;
    _sfQueue = null;
    _notionWritebackQueue = null;
    _sfPollQueue = null;
}
