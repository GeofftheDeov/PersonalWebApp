import { Worker, Job } from "bullmq";
import Task from "../models/Task.js";
import { pullNotionTasks } from "../services/notionSync.js";
import { pushTaskToSalesforce } from "../services/salesforceService.js";
import { getBullConnection, QUEUE_NAMES } from "./queues.js";

let _notionWorker: Worker | null = null;
let _sfWorker: Worker | null = null;

/**
 * Pull all recently-edited Notion tasks and upsert into MongoDB.
 * Matches on notionPageId so re-runs are idempotent.
 */
async function notionSyncProcessor(_job: Job): Promise<void> {
    const tasks = await pullNotionTasks();
    if (tasks.length === 0) {
        console.log("[bullmq] notion-sync: no tasks returned from Notion");
        return;
    }

    let upserted = 0;
    for (const nt of tasks) {
        try {
            await Task.findOneAndUpdate(
                { notionPageId: nt.notionPageId },
                {
                    $set: {
                        title: nt.title,
                        description: nt.description,
                        status: nt.status,
                        dueDate: nt.dueDate,
                        ...(nt.sfID ? { sfID: nt.sfID } : {}),
                        ownerName: nt.ownerName,
                        notionPageId: nt.notionPageId,
                        notionLastSynced: new Date(),
                    },
                },
                { upsert: true }
            );
            upserted++;
        } catch (err: any) {
            console.error(`[bullmq] notion-sync: upsert failed for page ${nt.notionPageId}:`, err.message);
        }
    }
    console.log(`[bullmq] notion-sync: upserted ${upserted}/${tasks.length} tasks`);
}

/**
 * Push a single task to Salesforce, then write the returned sfID back to MongoDB.
 * Job data must include { taskId: string }.
 */
async function sfWritebackProcessor(job: Job): Promise<void> {
    const { taskId } = job.data as { taskId: string };
    if (!taskId) throw new Error("sf-writeback job missing taskId");

    const task = await Task.findById(taskId);
    if (!task) {
        // Task deleted between enqueue and processing — treat as success.
        console.warn(`[bullmq] sf-writeback: task ${taskId} not found, skipping`);
        return;
    }

    const sfId = await pushTaskToSalesforce({
        sfID: task.sfID,
        title: task.title,
        description: task.description,
        status: task.status,
        dueDate: task.dueDate,
        ownerName: task.ownerName,
    });

    if (sfId) {
        await Task.findByIdAndUpdate(taskId, { sfID: sfId, sfLastSynced: new Date() });
        console.log(`[bullmq] sf-writeback: task ${taskId} → SF ${sfId}`);
    } else {
        // pushTaskToSalesforce already logged the error; throw so BullMQ retries.
        throw new Error(`pushTaskToSalesforce returned null for task ${taskId}`);
    }
}

/**
 * Start both queue workers. Returns a shutdown function for graceful teardown.
 * No-op (returns a no-op teardown) when Redis is unavailable.
 */
export function startWorkers(): () => Promise<void> {
    const conn = getBullConnection();
    if (!conn) {
        console.log("[bullmq] No Redis — workers not started (local dev mode)");
        return async () => {};
    }

    _notionWorker = new Worker(QUEUE_NAMES.NOTION_SYNC, notionSyncProcessor, {
        connection: conn,
        concurrency: 1, // Notion API is rate-limited; process one at a time
    });
    _notionWorker.on("completed", (job) =>
        console.log(`[bullmq] notion-sync job ${job.id} completed`)
    );
    _notionWorker.on("failed", (job, err) =>
        console.error(`[bullmq] notion-sync job ${job?.id} failed:`, err.message)
    );

    _sfWorker = new Worker(QUEUE_NAMES.SF_WRITEBACK, sfWritebackProcessor, {
        connection: conn,
        concurrency: 3,
    });
    _sfWorker.on("completed", (job) =>
        console.log(`[bullmq] sf-writeback job ${job.id} completed`)
    );
    _sfWorker.on("failed", (job, err) =>
        console.error(`[bullmq] sf-writeback job ${job?.id} failed:`, err.message)
    );

    console.log("[bullmq] Workers started: notion-sync (concurrency=1), salesforce-writeback (concurrency=3)");

    return async () => {
        await Promise.all([
            _notionWorker?.close(),
            _sfWorker?.close(),
        ]);
        _notionWorker = null;
        _sfWorker = null;
        console.log("[bullmq] Workers shut down");
    };
}
