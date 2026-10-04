# Event bus namespaces (#118)

Prod and dev share one Redis (`redis://redis.pwa.internal:6379`) and both use the consumer group `backend`. Without a namespace they publish to the same streams and compete in the same group, so an event is handled by whichever environment reads it first, against that environment's own database. `EVENT_BUS_NAMESPACE` gives each environment its own names on the shared Redis.

A separate logical database (`redis://…/1`) would not be enough on its own: Pub/Sub channels ignore the database number, and the broadcast and ephemeral paths (#96) run on Pub/Sub.

## Names

`busNames(namespace)` in `RedisStreamBus.ts` is the single place these are built.

| | `EVENT_BUS_NAMESPACE` unset or blank (local dev, today's names) | `EVENT_BUS_NAMESPACE=prod` |
|---|---|---|
| Stream for `gamenight.message` | `events:gamenight` | `prod:events:gamenight` |
| Consumer group (`EVENT_BUS_GROUP=backend`) | `backend` | `prod:backend` |
| Broadcast channel for `gamenight.message` | `events:live:gamenight.message` | `prod:events:live:gamenight.message` |

- A namespace may only use letters, digits, `-` and `_`. Anything else makes the bus throw when it's built, so the task fails at boot rather than running on the wrong names.
- The namespace goes in front of every name, so `SCAN … MATCH events:*` finds only the un-namespaced keys, and `prod:*` / `dev:*` find only one environment's keys.
- The in-memory bus (no `REDIS_URL`) ignores the namespace.
- Every task in one environment must use the same namespace. Changing it is a cutover, done the same way as below.
- The ECS task definitions set it: `.aws/backend-task-definition.json` → `prod`, `.aws/dev-task-definition.json` → `dev`. The deploy workflows register those files on every deploy, so the namespace takes effect with the deploy that carries this change.

Tests: `backend/scripts/test-event-bus-namespace.ts` (isolation between namespaces, same-namespace semantics, names on Redis), and `backend/scripts/test-event-bus-fanout.ts` (unset namespace, #96 behaviour).

## Cutover plan

### What is on the bus when this ships

| Event | Once-per-service consumer | Lost if left pending in an old stream |
|---|---|---|
| `gamenight.message`, `social.dm` | `routes/messageRoutes.ts` fans out to SSE clients | One live update. The message is already in Postgres, and the client sees it on refresh. |
| `task.updated`, `user.notification`, `event.changed`, `campaign.changed` | none in the backend | Nothing. The bus only reads streams it has handlers for. |
| `planning.*` (only where #57 session planning is deployed, which is dev today) | `planning/announcements.ts` | One bell notification and Table Talk post. Planning state is already committed. |

### Decision: let the old streams drain naturally, and knowingly drop anything still pending

The old un-namespaced streams are not migrated into the new ones. Copying entries across would replay events that a task already handled, and every consumer above can afford to miss one event. In practice almost nothing gets dropped. An entry stays pending only while a handler is running, or after a handler failed and is waiting for its 60-second XAUTOCLAIM retry. The old tasks keep consuming the old streams until ECS stops them.

### Order

1. **Dev first.** Merging this to `dev` deploys dev with `EVENT_BUS_NAMESPACE=dev`.
   - During the rolling deploy, old dev tasks (un-namespaced) and new dev tasks (`dev:`) run side by side and don't see each other's events. A message sent through an old task reaches only SSE clients on old tasks, and the same holds for new tasks. This lasts until the old task drains (the ALB deregistration delay). It costs live updates, not data.
   - Once the old dev tasks are gone, prod is the only consumer of the un-namespaced streams. The prod/dev split ends from that point, before prod is even deployed.
   - Known tail: an entry a dev task left pending (a failed handler) can still be reclaimed by a prod task after 60 seconds. For `planning.*`, prod has no handler and simply acks it. For `gamenight.message`/`social.dm`, prod could fan one dev message out to prod SSE clients of the campaign with the same id, because the dev database is a fork of prod. This is today's bug, limited to entries already pending at the moment of cutover. Accepted.
2. **Verify dev** (from a shell that can reach the Redis, e.g. ECS Exec into the redis task, then `redis-cli`):
   - `SCAN 0 MATCH dev:events:* TYPE stream COUNT 1000` lists the new dev streams once events flow.
   - `XINFO GROUPS dev:events:gamenight` shows a single group, `dev:backend`.
   - Send a Table Talk message on dev and on prod. Each appears live only in its own environment.
3. **Prod**, when the release carrying this change is promoted to `main`. This deploys prod with `EVENT_BUS_NAMESPACE=prod`. The overlap behaves as in step 1.
   - Optional drain check, just before the old prod task stops: `XINFO GROUPS events:<domain>` for each un-namespaced stream should show `pending` 0 and `lag` 0 for group `backend`. If not, wait one more minute: the old task is still handling or retrying. Anything still pending when it stops is dropped, per the decision above.
   - #57 session planning must not reach prod before this change does (#118 blocks that promotion). If both ship in the same promotion, the old prod tasks have no `planning.*` handlers, and the new ones only use `prod:` streams, so no planning event can be stranded in an old stream.
4. **Clean up (manual, after both environments have run cleanly for a day).**
   - List the old keys: `SCAN 0 MATCH events:* TYPE stream COUNT 1000`. The namespaced keys start with `prod:` or `dev:`, so this never matches them.
   - For each one, `XINFO GROUPS <key>` should show only the group `backend`, with `pending` 0. `XINFO CONSUMERS <key> backend` should show every consumer idle since the cutover. If some other group shows up, another service is still reading the old names. Give it the namespace before deleting anything.
   - `DEL events:<domain> …` for the listed keys.
   - Pub/Sub channels hold no state, so there's nothing to clean up for them.

### Rollback

Removing `EVENT_BUS_NAMESPACE` from a task definition and redeploying returns that environment to the un-namespaced names, and to sharing them with any other environment that's also un-namespaced. Events pending in its namespaced streams are dropped the same way. Don't run step 4 until a rollback is no longer likely.

## Accepted: a duplicate Table Talk announcement during a deploy

The once-per-service path is at-least-once. Suppose a task is stopped after a handler posted to Table Talk but before the entry was acked. Another task in the same namespace reclaims the entry with XAUTOCLAIM after 60 seconds and posts again. Bell notifications are unaffected because they collapse on `sourceKey`. This isn't caused by namespacing and isn't fixed here. The real fix is to make announcement handlers idempotent on `meta.id`, as `EventBus` already asks. At the cutover deploy itself, old and new tasks don't share a stream, so a stranded entry is dropped rather than duplicated.

## Not covered

BullMQ (`backend/jobs/queues.ts`) uses the same `REDIS_URL` with BullMQ's default `bull:` prefix. Prod and dev therefore still share the Notion/Salesforce sync and person-sync queues and their repeatable jobs. That needs its own ticket, which would set a per-environment BullMQ `prefix`.
