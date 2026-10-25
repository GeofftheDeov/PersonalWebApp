-- Agentic OS: the ask log (#146, spec #135 W3).
--
-- One row per request to POST /admin/os/ask, typed or spoken, written by
-- routes/osRoutes.ts. Every column the three tiers need is here now, so later
-- tickets (#147 tier-1 answers, #148 run proposals, #154 tier 2) add no
-- migration:
--
--   every ask      account_id, asked_at, text (trimmed, <= 500 chars), source,
--                  tier, kind, intent (the tier-1 intent or the tier-2 model
--                  action), latency_ms, error
--   tier 2         model, input_tokens (uncached + cache reads + cache
--                  writes), output_tokens, cost_usd (computed from the
--                  response's usage at the rate card)
--   tier 3         skill (the proposed run), expires_at, confirmed_at, run_id
--                  (the queued run). A tier-3 row IS the proposal: confirming
--                  it works across backend tasks because it lives here.
--
-- asked_at drives today's (Central) tier-2 spend for the daily budget (#156).
--
-- Additive: a new table and its indexes, nothing else touched.

BEGIN;

CREATE TABLE IF NOT EXISTS os_asks (
  id             bigserial PRIMARY KEY,
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  asked_at       timestamptz NOT NULL DEFAULT now(),
  text           text NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
  source         text NOT NULL CHECK (source IN ('voice','typed')),
  tier           smallint NOT NULL CHECK (tier IN (1,2,3)),
  kind           text NOT NULL
                   CHECK (kind IN ('answer','navigate','confirm_run','not_understood','unavailable')),
  intent         text,
  latency_ms     integer NOT NULL CHECK (latency_ms >= 0),
  error          text,
  model          text,
  input_tokens   bigint  CHECK (input_tokens >= 0),
  output_tokens  bigint  CHECK (output_tokens >= 0),
  cost_usd       numeric CHECK (cost_usd >= 0),
  skill          text,
  expires_at     timestamptz,
  confirmed_at   timestamptz,
  run_id         bigint REFERENCES agent_runs(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_os_asks_recent ON os_asks (asked_at DESC);
CREATE INDEX IF NOT EXISTS idx_os_asks_tier2 ON os_asks (asked_at) WHERE tier = 2;

COMMIT;
