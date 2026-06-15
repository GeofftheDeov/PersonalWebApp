import { Worker, Job } from "bullmq";
import Task from "../models/Task.js";
import { pullNotionTasks, pushTaskToNotion } from "../services/notionSync.js";
import { pushTaskToSalesforce, pullTasksFromSalesforce } from "../services/salesforceService.js";
import {
    getBullConnectionOptions,
    QUEUE_NAMES,
    enqueueSFWriteback,
    enqueueNotionWriteback,
} from "./queues.js";

let _notionSyncWorker: Worker | null = null;
let _sfWritebackWorker: Worker | null = null;
let _notionWritebackWorker: Worker | null = null;
let _sfPollWorker: Worker | null = null;

/**
 * Pull all Notion tasks and upsert into MongoDB.
 * If a task changed in Notion since our last sync and already has an sfID,
 * enqueue a Salesforce writeback so the change propagates there too.
 */
async function notionSyncProcessor(_job: Job): Promise<void> {
    const tasks = await pullNotionTasks();
    if (tasks.length === 0) {
        console.log("[bullmq] notion-sync: no tasks returned from Notion");
        return;
    }

    let upserted = 0;
    let sfEnqueued = 0;
    for (const nt of tasks) {
        try {
            const existing = await Task.findOne({ notionPageId: nt.notionPageId });
            const changedInNotion =
                !existing ||
                !existing.notionLastSynced ||
                nt.lastEdited > existing.notionLastSynced;

            const updated = await Task.findOneAndUpdate(
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
                { upsert: true, new: true }
            );
            upserted++;

            // Propagate Notion changes back to Salesforce
            if (changedInNotion && updated?.sfID) {
                enqueueSFWriteback(String(updated._id));
                sfEnqueued++;
            }
        } catch (err: any) {
            console.error(`[bullmq] notion-sync: upsert failed for page ${nt.notionPageId}:`, err.message);
        }
    }
    console.log(`[bullmq] notion-sync: upserted ${upserted}/${tasks.length} tasks, enqueued ${sfEnqueued} SF writebacks`);
}

/**
 * Push a single task to Salesforce and write the returned sfID back to MongoDB.
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
        sfID: task.sfID ?? undefined,
        title: task.title,
        description: task.description ?? undefined,
        status: task.status ?? undefined,
        dueDate: task.dueDate ?? undefined,
        ownerName: task.ownerName ?? undefined,
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
 * Push a single task to Notion (create or update).
 * Writes notionPageId and notionLastSynced back to MongoDB.
 * Job data must include { taskId: string }.
 */
async function notionWritebackProcessor(job: Job): Promise<void> {
    const { taskId } = job.data as { taskId: string };
    if (!taskId) throw new Error("notion-writeback job missing taskId");

    const task = await Task.findById(taskId);
    if (!task) {
        console.warn(`[bullmq] notion-writeback: task ${taskId} not found, skipping`);
        return;
    }

    const pageId = await pushTaskToNotion({
        notionPageId: task.notionPageId ?? undefined,
        title: task.title,
        description: task.description ?? undefined,
        status: task.status ?? undefined,
        dueDate: task.dueDate ?? undefined,
        sfID: task.sfID ?? undefined,
        ownerName: task.ownerName ?? undefined,
    });

    if (pageId) {
        await Task.findByIdAndUpdate(taskId, {
            notionPageId: pageId,
            notionLastSynced: new Date(),
        });
        console.log(`[bullmq] notion-writeback: task ${taskId} → Notion ${pageId}`);
    } else {
        throw new Error(`pushTaskToNotion returned null for task ${taskId}`);
    }
}

/**
 * Poll Salesforce for recently modified tasks and upsert them into MongoDB.
 * For each changed task, also enqueue a Notion writeback so all three systems stay in sync.
 */
async function sfPollProcessor(_job: Job): Promise<void> {
    const sfTasks = await pullTasksFromSalesforce();
    if (sfTasks.length === 0) {
        console.log("[bullmq] sf-poll: no recently modified SF tasks");
        return;
    }

    let upserted = 0;
    let notionEnqueued = 0;
    for (const sf of sfTasks) {
        try {
            const existing = await Task.findOne({ sfID: sf.sfID });
            const changedInSF =
                !existing ||
                !existing.sfLastSynced ||
                sf.lastModifiedDate > existing.sfLastSynced;

            const updated = await Task.findOneAndUpdate(
                { sfID: sf.sfID },
                {
                    $set: {
                        title: sf.title,
                        description: sf.description,
                        status: sf.status,
                        dueDate: sf.dueDate,
                        sfID: sf.sfID,
                        sfLastSynced: new Date(),
                    },
                },
                { upsert: true, new: true }
            );
            upserted++;

            // Propagate SF changes to Notion
            if (changedInSF && updated) {
                enqueueNotionWriteback(String(updated._id));
                notionEnqueued++;
            }
        } catch (err: any) {
            console.error(`[bullmq] sf-poll: upsert failed for SF task ${sf.sfID}:`, err.message);
        }
    }
    console.log(`[bullmq] sf-poll: upserted ${upserted}/${sfTasks.length} tasks, enqueued ${notionEnqueued} Notion writebacks`);
}

/**
 * Start all queue workers. Returns a shutdown function for graceful teardown.
 * No-op (returns a no-op teardown) when Redis is unavailable.
 */
export function startWorkers(): () => Promise<void> {
    const opts = getBullConnectionOptions();
    if (!opts) {
        console.log("[bullmq] No Redis — workers not started (local dev mode)");
        return async () => {};
    }

    _notionSyncWorker = new Worker(QUEUE_NAMES.NOTION_SYNC, notionSyncProcessor, {
        connection: opts,
        concurrency: 1, // Notion API rate-limited; one run at a time
    });
    _notionSyncWorker.on("completed", (job) =>
        console.log(`[bullmq] notion-sync job ${job.id} completed`)
    );
    _notionSyncWorker.on("failed", (job, err) =>
        console.error(`[bullmq] notion-sync job ${job?.id} failed:`, err.message)
    );

    _sfWritebackWorker = new Worker(QUEUE_NAMES.SF_WRITEBACK, sfWritebackProcessor, {
        connection: opts,
        concurrency: 3,
    });
    _sfWritebackWorker.on("completed", (job) =>
        console.log(`[bullmq] sf-writeback job ${job.id} completed`)
    );
    _sfWritebackWorker.on("failed", (job, err) =>
        console.error(`[bullmq] sf-writeback job ${job?.id} failed:`, err.message)
    );

    _notionWritebackWorker = new Worker(QUEUE_NAMES.NOTION_WRITEBACK, notionWritebackProcessor, {
        connection: opts,
        concurrency: 2,
    });
    _notionWritebackWorker.on("completed", (job) =>
        console.log(`[bullmq] notion-writeback job ${job.id} completed`)
    );
    _notionWritebackWorker.on("failed", (job, err) =>
        console.error(`[bullmq] notion-writeback job ${job?.id} failed:`, err.message)
    );

    _sfPollWorker = new Worker(QUEUE_NAMES.SF_POLL, sfPollProcessor, {
        connection: opts,
        concurrency: 1,
    });
    _sfPollWorker.on("completed", (job) =>
        console.log(`[bullmq] sf-poll job ${job.id} completed`)
    );
    _sfPollWorker.on("failed", (job, err) =>
        console.error(`[bullmq] sf-poll job ${job?.id} failed:`, err.message)
    );

    console.log(
        "[bullmq] Workers started: notion-sync (c=1), sf-writeback (c=3), notion-writeback (c=2), sf-poll (c=1)"
    );

    return async () => {
        await Promise.all([
            _notionSyncWorker?.close(),
            _sfWritebackWorker?.close(),
            _notionWritebackWorker?.close(),
            _sfPollWorker?.close(),
        ]);
        _notionSyncWorker = null;
        _sfWritebackWorker = null;
        _notionWritebackWorker = null;
        _sfPollWorker = null;
        console.log("[bullmq] Workers shut down");
    };
}
