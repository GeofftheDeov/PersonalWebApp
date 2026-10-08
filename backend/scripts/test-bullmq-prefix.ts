/**
 * BullMQ prefixes (#129): prod and dev share one Redis, so each environment's
 * queues must live under their own prefix, or either environment's worker can
 * take the other's Salesforce/Notion jobs.
 *
 * Checks getBullPrefix() against BULLMQ_NAMESPACE; that a worker under one
 * prefix never takes a job added under another, while two workers under the
 * same prefix still process a job exactly once; and the cutover helper
 * (jobs/movePrefix.ts). Queue names and prefixes are `t129`-prefixed and random
 * per run; everything written is deleted at the end.
 *
 * Needs the docker-compose Redis (`docker compose up -d redis`):
 *   REDIS_URL=redis://127.0.0.1:6379 npx tsx scripts/test-bullmq-prefix.ts
 */
import { randomUUID } from "node:crypto";
import { Queue, Worker, Job } from "bullmq";
import { Redis } from "ioredis";
import { getBullPrefix, getBullOptions } from "../jobs/queues.js";
import { moveBullPrefix } from "../jobs/movePrefix.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
if (!/\/\/(127\.0\.0\.1|localhost)[:/]/.test(REDIS_URL)) {
    console.error("\n  Refusing to run: REDIS_URL must be a local Redis.\n");
    process.exit(2);
}
process.env.REDIS_URL = REDIS_URL;

const run = randomUUID().slice(0, 8);
const QUEUE = `t129q${run}`;
const PREFIX_A = `t129a${run}:bull`;
const PREFIX_B = `t129b${run}:bull`;
const connection = { url: REDIS_URL, maxRetriesPerRequest: null, enableReadyCheck: false } as const;

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
    ok ? pass++ : fail++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until `cond` holds (or `ms` passes), then a little longer so strays would show up. */
async function settle(cond: () => boolean, ms = 8_000) {
    const until = Date.now() + ms;
    while (!cond() && Date.now() < until) await sleep(25);
    await sleep(600);
}

const closers: Array<() => Promise<unknown>> = [];
function queue(prefix: string, name = QUEUE) {
    const q = new Queue(name, { connection, prefix });
    closers.push(() => q.close());
    return q;
}
function worker(prefix: string, seen: string[], name = QUEUE) {
    const w = new Worker(name, async (job: Job) => { seen.push(job.data.marker); }, { connection, prefix });
    closers.push(() => w.close());
    return w;
}

function prefixChecks() {
    console.log("\ngetBullPrefix() from BULLMQ_NAMESPACE\n");
    const saved = process.env.BULLMQ_NAMESPACE;
    const prefixFor = (ns: string | undefined) => {
        if (ns === undefined) delete process.env.BULLMQ_NAMESPACE;
        else process.env.BULLMQ_NAMESPACE = ns;
        return getBullPrefix();
    };
    check("unset keeps BullMQ's default `bull`", prefixFor(undefined) === "bull");
    check("blank keeps `bull`", prefixFor("  ") === "bull");
    check("`prod` → `prod:bull`", prefixFor("prod") === "prod:bull");
    check("`dev` → `dev:bull`", prefixFor("dev") === "dev:bull");
    let threw = false;
    try { prefixFor("prod:x"); } catch { threw = true; }
    check("a namespace with `:` throws", threw);
    process.env.BULLMQ_NAMESPACE = "dev";
    check("getBullOptions() carries the prefix", getBullOptions()?.prefix === "dev:bull");
    if (saved === undefined) delete process.env.BULLMQ_NAMESPACE; else process.env.BULLMQ_NAMESPACE = saved;
}

async function isolationChecks() {
    console.log("\nDifferent prefixes — a job never crosses\n");
    const seenA: string[] = [], seenB: string[] = [];
    worker(PREFIX_A, seenA);
    worker(PREFIX_B, seenB);
    for (let i = 0; i < 5; i++) await queue(PREFIX_A).add("job", { marker: `a${i}` });
    for (let i = 0; i < 5; i++) await queue(PREFIX_B).add("job", { marker: `b${i}` });
    await settle(() => seenA.length >= 5 && seenB.length >= 5);
    check("prefix A's worker ran all of A's jobs", seenA.filter((m) => m.startsWith("a")).length === 5, `saw ${seenA}`);
    check("prefix A's worker ran none of B's jobs", !seenA.some((m) => m.startsWith("b")), `saw ${seenA}`);
    check("prefix B's worker ran all of B's jobs", seenB.filter((m) => m.startsWith("b")).length === 5, `saw ${seenB}`);
    check("prefix B's worker ran none of A's jobs", !seenB.some((m) => m.startsWith("a")), `saw ${seenB}`);

    console.log("\nSame prefix, two workers — each job runs exactly once\n");
    const name = `${QUEUE}-same`;
    const seen1: string[] = [], seen2: string[] = [];
    worker(PREFIX_A, seen1, name);
    worker(PREFIX_A, seen2, name);
    const q = queue(PREFIX_A, name);
    for (let i = 0; i < 20; i++) await q.add("job", { marker: `s${i}` });
    await settle(() => seen1.length + seen2.length >= 20);
    const all = [...seen1, ...seen2];
    check("all 20 jobs ran", new Set(all).size === 20, `ran ${new Set(all).size}`);
    check("none ran twice", all.length === 20, `ran ${all.length} times`);
}

async function moveChecks() {
    console.log("\nCutover helper (jobs/movePrefix.ts)\n");
    const name = `${QUEUE}-move`;
    const FROM = `t129f${run}:bull`, TO = `t129t${run}:bull`;
    const src = queue(FROM, name), dst = queue(TO, name);
    await src.add("sf-writeback", { marker: "waiting" }, { attempts: 5 });
    await src.add("sf-writeback", { marker: "delayed" }, { delay: 60_000 });
    await src.upsertJobScheduler("poll", { every: 60_000 }, { name: "poll", data: { marker: "scheduled" } });

    const counts = async () => JSON.stringify([await src.getJobCounts(), await dst.getJobCounts(), (await src.getJobSchedulers()).length]);
    const before = await counts();
    const dry = await moveBullPrefix(connection, FROM, TO, false, [name]);
    check("dry run counts 2 jobs to move", dry[0]?.moved === 2, JSON.stringify(dry));
    check("dry run finds the scheduler", dry[0]?.schedulers.join() === "poll", JSON.stringify(dry));
    const after = await counts();
    check("dry run changes nothing", after === before, `${before} → ${after}`);

    const seen: string[] = [];
    const old = worker(FROM, seen, `${name}-guard`);
    await old.waitUntilReady();
    let refused = false;
    try { await moveBullPrefix(connection, FROM, TO, true, [`${name}-guard`]); } catch { refused = true; }
    check("refuses while a worker is attached to the old prefix", refused);
    await old.close();

    await moveBullPrefix(connection, FROM, TO, true, [name]);
    const moved = await dst.getJobs(["waiting", "delayed"]);
    const markers = moved.map((j) => j.data.marker).sort().join();
    check("both jobs are under the new prefix", markers === "delayed,waiting", markers);
    const delayed = moved.find((j) => j.data.marker === "delayed");
    check("the delayed job is still delayed", (await delayed?.getState()) === "delayed");
    check("the waiting job kept its options", moved.find((j) => j.data.marker === "waiting")?.opts.attempts === 5);
    const left = await src.getJobCounts("waiting", "delayed", "prioritized", "paused");
    check("nothing is left under the old prefix", Object.values(left).every((n) => n === 0), JSON.stringify(left));
    check("the old scheduler is gone", (await src.getJobSchedulers()).length === 0);
    check("the scheduler was not copied", (await dst.getJobSchedulers()).length === 0);
}

async function cleanup() {
    for (const c of closers.reverse()) await c().catch(() => {});
    const admin = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
    let cursor = "0", deleted = 0;
    do {
        const [next, keys] = await admin.scan(cursor, "MATCH", `t129*${run}*`, "COUNT", 1000);
        cursor = next;
        if (keys.length) deleted += await admin.del(...keys);
    } while (cursor !== "0");
    await admin.quit();
    console.log(`\n  cleaned up ${deleted} key(s)`);
}

try {
    prefixChecks();
    await isolationChecks();
    await moveChecks();
} catch (err) {
    check("ran without throwing", false, (err as Error).stack);
} finally {
    await cleanup();
}
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
