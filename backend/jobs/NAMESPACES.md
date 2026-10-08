# BullMQ prefixes (#129)

Prod and dev share one Redis (`redis://redis.pwa.internal:6379`). BullMQ keeps every queue under a key prefix, and the default is `bull`. With the default, both environments read and write the same queues: person sync, Notion sync and write-back, and Salesforce write-back and poll. Each job is run by whichever environment's worker takes it first, against that environment's database and integration credentials. The repeatable jobs are shared too, so a 15-minute poll may run in either environment.

`BULLMQ_NAMESPACE` gives each environment its own prefix. This is the same idea as the event bus namespace (#118, `EVENT_BUS_NAMESPACE`), and it's set separately because BullMQ keys and bus keys are cut over separately.

## Names

`getBullPrefix()` in `queues.ts` builds the prefix, and `getBullOptions()` passes it to every `Queue` and `Worker`.

| | `BULLMQ_NAMESPACE` unset or blank (local dev, today's keys) | `BULLMQ_NAMESPACE=prod` |
|---|---|---|
| Prefix | `bull` | `prod:bull` |
| Waiting list for `salesforce-writeback` | `bull:salesforce-writeback:wait` | `prod:bull:salesforce-writeback:wait` |

- The namespace may only use letters, digits, `-` and `_`. Anything else throws when the first queue or worker is built, so the task fails at boot (`startWorkers`) rather than running on the wrong keys.
- The namespace goes in front, as it does on the bus. So `prod:*` / `dev:*` match only one environment's keys, and `bull:*` matches only the old, un-namespaced ones.
- `.aws/backend-task-definition.json` sets `prod` and `.aws/dev-task-definition.json` sets `dev`. The deploy workflows register those files on every deploy, so the prefix takes effect with the deploy that carries this change.
- **Every new `Queue` or `Worker` must be built from `getBullOptions()`**, not `{ connection: getBullConnectionOptions() }`. Built the old way, it lands back on the shared `bull` prefix. This includes the quest-reminders queue that #57 (#91) adds on `dev`.

Test: `backend/scripts/test-bullmq-prefix.ts` covers the prefix from the environment, isolation between prefixes, exactly-once processing within a prefix, and the cutover helper.

## Cutover plan

### What's in the old `bull:*` queues

| Queue | What's waiting or delayed there | Lost if left behind |
|---|---|---|
| `notion-sync`, `salesforce-poll` | Each scheduler's next run, plus retries | Nothing. The new prefix registers its own schedulers on boot (`registerRepeatableJobs`), and the next poll covers the gap. |
| `person-sync` | The nightly scheduler's next run, plus an admin "run now" if one is queued | Nothing. The outbox is in Postgres, and the next run drains it. |
| `salesforce-writeback`, `notion-writeback` | A write-back queued in the last moments before the cutover, or one waiting out its retry backoff (up to 8 minutes) | That task's push to Salesforce/Notion, until the task changes again. **These are worth moving.** |

### Order

1. **Dev first.** Merging this to `dev` deploys dev with `BULLMQ_NAMESPACE=dev`.
   - New dev tasks register their schedulers under `dev:bull` and work only `dev:bull` queues. The old dev task keeps working `bull:` queues until ECS stops it.
   - **Don't move anything out of `bull:` at this step.** Prod is still working those queues, and a job there may have been queued by either environment. There's no way to tell which.
   - Once the old dev task is gone, prod is the only worker on `bull:`, and the prod/dev split ends there, before prod is even deployed. Known tail: anything the old dev task queued and didn't finish (in practice, write-back retries) will be run by prod. That's today's bug, limited to jobs already queued at the moment of cutover. Accepted.
2. **Verify dev** (from a shell that can reach the Redis, e.g. ECS Exec into the redis task, then `redis-cli`):
   - `SCAN 0 MATCH dev:bull:* COUNT 1000` lists `dev:bull:notion-sync:…`, `dev:bull:salesforce-poll:…` and `dev:bull:person-sync:…` keys once the task has booted.
   - `CLIENT LIST`: dev's worker connections are named `dev:bull:<base64 queue name>…`, and prod's are named `bull:<base64 queue name>…`.
3. **Prod**, when the release carrying this change is promoted to `main`. This deploys prod with `BULLMQ_NAMESPACE=prod`.
   - After the old prod task has stopped, move what it left behind. Run this from a shell that can reach the Redis, with the backend source checked out. The dry run first:
     ```
     REDIS_URL=redis://redis.pwa.internal:6379 npx tsx scripts/bullmq-move-prefix.ts --from bull --to prod:bull
     REDIS_URL=redis://redis.pwa.internal:6379 npx tsx scripts/bullmq-move-prefix.ts --from bull --to prod:bull --apply
     ```
     The script copies every waiting, delayed, prioritized and paused job into the same queue under `prod:bull`, keeping its data, options and remaining delay. It then removes the old job schedulers and their pending runs, because `prod:bull` has its own. The script refuses to run while any worker is still attached to a `bull:` queue, which means an old task is still alive.
   - If the move is skipped, the write-backs still waiting in `bull:` are dropped. The polls and person sync lose nothing (see the table above).
4. **Clean up** (manual, after both environments have run cleanly for a day). `SCAN 0 MATCH bull:* COUNT 1000` lists the old keys. `bull:<queue>:wait`, `:delayed` and `:active` should all be empty. Then `DEL` the listed keys. The namespaced keys start with `prod:` or `dev:`, so the scan never matches them.

### Rollback

Remove `BULLMQ_NAMESPACE` from a task definition and redeploy. That environment goes back to `bull`, and back to sharing it with any other environment that is also un-namespaced. To bring its waiting jobs along, run the move in reverse (`--from prod:bull --to bull`) once the namespaced tasks have stopped. Don't run step 4 while a rollback is still likely.
