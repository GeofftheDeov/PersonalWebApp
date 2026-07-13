# Paperclip as its own ECS service (dev)

Paperclip (github.com/paperclipai/paperclip, MIT) runs as a standalone Fargate
service in `dev-cluster`, discovered via Cloud Map at
`paperclip-dev.pwa.internal:3100` — same pattern as `redis-dev`.

The app is installed from npm (`paperclipai` CLI, pinned in
`paperclip/Dockerfile`); nothing is vendored. Confirmed contract from the CLI
source: `PAPERCLIP_HOME` relocates the instance dir, deployment modes are
`local_trusted | authenticated` (local_trusted force-binds loopback — unusable
in ECS), bind modes `loopback | lan | tailnet | custom`, `DATABASE_URL`
switches off embedded Postgres, `paperclipai run` = doctor + start, and
`paperclipai env` prints deployment env vars.

## Already in place

- `paperclip/Dockerfile` + `paperclip/entrypoint.sh` — headless image, runs as
  `node` (uid 1000) because embedded Postgres refuses root; authenticated mode
  bound to 0.0.0.0; instance data on `/paperclip-data`.
- EFS access point `fsap-02a0045caa8f59650` → `/paperclip-data` owned 1000:1000
  (already created; wired into the task definition).
- Task definition draft: `.aws/paperclip-dev-task-definition.json`.
- Secret `personal-web-app/dev/PAPERCLIP_API_KEY` — currently a random
  placeholder. In authenticated mode the backend must present a real Paperclip
  token; see "Auth bootstrap" below. IAM already allows it (dev/* wildcard).

## One-time setup

All four steps below are DONE (2026-07-11); the service is running steady in
`dev-cluster` as `paperclip-dev-service` (task def `paperclip-dev:2`).

```sh
# 1. ECR repo + build/push the image (from the PersonalWebApp repo root)
#    DONE: paperclip:dev pushed 2026-07-11
aws ecr create-repository --repository-name paperclip
cd paperclip
docker buildx build --platform linux/amd64 \
  -t 913447902637.dkr.ecr.us-east-2.amazonaws.com/paperclip:dev --push .

# 2. Cloud Map service in the existing pwa.internal namespace
#    DONE: srv-2ty2govf2ehkrzcj (paperclip-dev.pwa.internal)
aws servicediscovery create-service --name paperclip-dev \
  --namespace-id ns-uvmn56hdpoyr63kq \
  --dns-config "RoutingPolicy=MULTIVALUE,DnsRecords=[{Type=A,TTL=10}]"

# 3. Register the task definition (run from the REPO ROOT — the path is
#    relative; step 1 left you in paperclip/)
#    DONE: paperclip-dev:1 registered
aws ecs register-task-definition --cli-input-json file://.aws/paperclip-dev-task-definition.json

# 4. Create the service (same subnets/SG as redis-dev-service)
#    DONE: paperclip-dev-service ACTIVE, steady state
aws ecs create-service --cluster dev-cluster --service-name paperclip-dev-service \
  --task-definition paperclip-dev --desired-count 1 --launch-type FARGATE \
  --service-registries "registryArn=arn:aws:servicediscovery:us-east-2:913447902637:service/srv-2ty2govf2ehkrzcj" \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-0c33b8b801beec11a,subnet-007a79d52272fe680,subnet-0bbcf124b53fd8f43],securityGroups=[sg-08eba82e4bf6af45d],assignPublicIp=ENABLED}"
```

## Auth bootstrap (after first deploy)

DONE (2026-07-11): a real board API key (`pcp_…`) is stored in the secret and
the backend (rev 51) authenticates successfully — verified end-to-end from
inside the backend container (health/org/agents/costs all 200).

The container runs in `authenticated` mode, so the backend's bearer token must
be a token Paperclip actually minted (the placeholder secret won't work):

1. Create the board user / token. Easiest path is ECS Exec into the container:
   `aws ecs execute-command --cluster dev-cluster --task <task-id> --container paperclip --interactive --command "paperclipai auth bootstrap-ceo"` (or `paperclipai token create ...`).
2. Store the minted token:
   `aws secretsmanager put-secret-value --secret-id personal-web-app/dev/PAPERCLIP_API_KEY --secret-string <token>`
3. Redeploy the app service so the backend picks it up.

## Migrating the local company

The company on the Windows install (`ec00ed5f-6b92-4a64-bd4d-6e183a7149aa` in
`~/.paperclip`) doesn't come along automatically. Use Paperclip's
export/import (secret-scrubbed by design):

```sh
# locally, against the running Windows instance (company ID is positional)
npx paperclipai company export ec00ed5f-6b92-4a64-bd4d-6e183a7149aa \
  --out paperclip-export --include company,agents,projects,issues,tasks,skills

# then against the deployed instance (via SSM port-forward on localhost:3100)
npx paperclipai company import ./paperclip-export --target new \
  --api-base http://localhost:3100 --api-key <agent-api-key> --yes

# grab the resulting company id
npx paperclipai company list --api-base http://localhost:3100 --api-key <agent-api-key>
```

Or start fresh in the deployed UI and skip the import. Either way, the
resulting company id is what goes in `PAPERCLIP_COMPANY_ID` below.

## Backend wiring (dev-task-definition.json, backend container)

DONE (rev 51): base URL, company id `f8949882-07ef-47ed-9e13-ed481acef32e`,
and the API-key secret are wired in `.aws/dev-task-definition.json`.

Add to `environment`:

```json
{ "name": "PAPERCLIP_BASE_URL", "value": "http://paperclip-dev.pwa.internal:3100" },
{ "name": "PAPERCLIP_COMPANY_ID", "value": "<company id from the deployed instance>" }
```

Add to `secrets`:

```json
{ "name": "PAPERCLIP_API_KEY", "valueFrom": "arn:aws:secretsmanager:us-east-2:913447902637:secret:personal-web-app/dev/PAPERCLIP_API_KEY-aUZBGf" }
```

Until these are set, all `/api/paperclip/*` routes (and the admin portal page)
return an explicit 503 "not configured" rather than dialing a dead port.

## Notes & caveats

- **Postgres on EFS** is fine for dev but not a long-term posture. If it gets
  flaky, create a small RDS Postgres and set `DATABASE_URL` on the container —
  the app switches off embedded PG automatically.
- **Security group**: DONE — `sg-08eba82e4bf6af45d` allows inbound TCP 3100
  from the backend's SG `sg-018f4b475a22317f4` (rule `sgr-0bd6c7fd48e326aec`,
  mirrors the Redis 6379 rule).
- **API paths**: VERIFIED (2026-07-13) against the deployed instance's OpenAPI
  doc + `@paperclipai/server` source, and the backend/admin/frontend code now
  matches. The load-bearing facts:
  - Runs live under `/api/heartbeat-runs/{runId}` (there is no `/api/runs/*`).
    `status` ∈ `queued | scheduled_retry | running | succeeded | failed |
    cancelled | timed_out` (last four terminal — note `succeeded`, not
    `completed`).
  - `/api/heartbeat-runs/{runId}/events?afterSeq=<n>&limit=<n>` returns a
    BARE ARRAY of event rows (`{ seq, eventType, stream, level, message,
    payload, createdAt }`); poll incrementally via the numeric `seq`.
  - Costs: no bare `/api/companies/{id}/costs` — use `/costs/summary`
    (`{ companyId, spendCents, budgetCents, utilizationPercent }`) or the
    other `/costs/*` breakdowns.
  - Agent budget: `PATCH /api/agents/{id}/budgets` with
    `{ budgetMonthlyCents }` — the plain agent PATCH silently drops that
    field.
  - Confirmed as assumed: `/api/companies/{id}/org|agents|issues`,
    `/api/agents/{id}` (+ `/pause`, `/resume`, `/heartbeat/invoke`),
    `/api/issues/{id}`.
- **Version pinning**: image pins `paperclipai@2026.707.0`; the Windows
  instance ran server 2026.609.0. Migrations apply automatically on first boot.
