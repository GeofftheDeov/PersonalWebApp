/**
 * BullMQ prefix cutover (#129): move the jobs still waiting or delayed under
 * one prefix into another, and remove the old prefix's job schedulers. See
 * jobs/NAMESPACES.md for when to run it. Dry run unless --apply is given.
 *
 *   REDIS_URL=redis://redis.pwa.internal:6379 npx tsx scripts/bullmq-move-prefix.ts --from bull --to prod:bull
 *   REDIS_URL=redis://redis.pwa.internal:6379 npx tsx scripts/bullmq-move-prefix.ts --from bull --to prod:bull --apply
 */
import { getBullConnectionOptions } from "../jobs/queues.js";
import { moveBullPrefix } from "../jobs/movePrefix.js";

function arg(flag: string): string | undefined {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

const from = arg("--from");
const to = arg("--to");
const apply = process.argv.includes("--apply");
const connection = getBullConnectionOptions();

if (!from || !to || !connection) {
    console.error("\n  Usage: REDIS_URL=… npx tsx scripts/bullmq-move-prefix.ts --from <prefix> --to <prefix> [--apply]\n");
    process.exit(2);
}

const results = await moveBullPrefix(connection, from, to, apply);
console.log(`\n${apply ? "Moved" : "Dry run — would move"} ${from} → ${to}\n`);
for (const r of results) {
    console.log(`  ${r.queue.padEnd(20)} jobs ${String(r.moved).padStart(3)}   scheduler jobs dropped ${r.scheduled}   schedulers removed ${r.schedulers.join(", ") || "-"}`);
}
if (!apply) console.log("\n  Nothing changed. Re-run with --apply.");
console.log();
process.exit(0);
