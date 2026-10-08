import { Queue } from "bullmq";
import { QUEUE_NAMES, DEFAULT_JOB_OPTS } from "./queues.js";

type Connection = { url: string; maxRetriesPerRequest: null; enableReadyCheck: false };

export interface QueueMove {
    queue: string;
    /** Waiting, delayed, prioritized and paused jobs that were (or would be) copied to the new prefix. */
    moved: number;
    /** Jobs a job scheduler made. Dropped, not moved: the new prefix's boot re-registers the scheduler. */
    scheduled: number;
    /** Job scheduler keys removed (or that would be) from the old prefix. */
    schedulers: string[];
}

const MOVABLE = ["waiting", "delayed", "prioritized", "paused"] as const;

/**
 * Cutover from one BullMQ prefix to another (#129, jobs/NAMESPACES.md). Copies
 * every job still waiting or delayed under `from` into the same queue under
 * `to`, keeping its name, data, options and remaining delay, then removes it
 * from `from`. Job schedulers under `from` are removed with their pending job,
 * since the tasks running on `to` register their own on boot.
 *
 * Refuses while any worker is still attached to a `from` queue: a running old
 * task could take a job while it's being moved, or keep its schedulers alive.
 * Dry run unless `apply` is set; the counts are the same either way.
 */
export async function moveBullPrefix(
    connection: Connection,
    from: string,
    to: string,
    apply: boolean,
    queueNames: readonly string[] = Object.values(QUEUE_NAMES),
): Promise<QueueMove[]> {
    if (from === to) throw new Error(`from and to are the same prefix (${from})`);
    const results: QueueMove[] = [];
    for (const name of queueNames) {
        const src = new Queue(name, { connection, prefix: from });
        const dst = new Queue(name, { connection, prefix: to });
        try {
            const workers = await src.getWorkersCount();
            if (workers > 0) {
                throw new Error(`${from}:${name} still has ${workers} worker(s) attached; stop the old tasks first`);
            }
            const active = await src.getActiveCount();
            if (active > 0) throw new Error(`${from}:${name} still has ${active} active job(s)`);

            const schedulers = (await src.getJobSchedulers()).map((s) => s.key);
            const jobs = (await src.getJobs([...MOVABLE])).filter(Boolean);
            const result: QueueMove = { queue: name, moved: 0, scheduled: 0, schedulers };
            for (const job of jobs) {
                if (job.repeatJobKey) {
                    result.scheduled++;
                    continue;
                }
                result.moved++;
                if (!apply) continue;
                const { jobId: _jobId, repeat: _repeat, delay: _delay, ...opts } = job.opts as any;
                const remaining = Math.max(0, job.timestamp + (job.opts.delay ?? 0) - Date.now());
                await dst.add(job.name, job.data, { ...DEFAULT_JOB_OPTS, ...opts, delay: remaining });
                await job.remove();
            }
            if (apply) {
                // Removing a scheduler also removes the delayed job it has queued.
                for (const key of schedulers) await src.removeJobScheduler(key);
                for (const job of jobs) if (job.repeatJobKey) await job.remove().catch(() => {});
            }
            results.push(result);
        } finally {
            await Promise.all([src.close(), dst.close()]);
        }
    }
    return results;
}
