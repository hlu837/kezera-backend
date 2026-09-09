-- Migration 006: Inbound SMS webhook support.
-- Adds the infrastructure needed by the inbound SMS webhook handler
-- (services/smsInbound.service.js): a durable idempotency log so a
-- gateway's retried webhook delivery is never double-processed, and an
-- `updated_at` column on `placements` so we can tell when a candidate's
-- acceptance was recorded, not just when the placement was first matched.
-- Safe to run multiple times.

-- ── inbound_sms_events ──────────────────────────────────────────────
-- One row per inbound SMS webhook delivery actually processed. The
-- unique index on (provider, provider_message_id) is the idempotency
-- guard: Twilio/Africa's Talking will retry a webhook delivery on
-- anything other than a fast 2xx, and a candidate's carrier can also
-- occasionally redeliver the same SMS. Without this, a retried
-- "1"/"YES" reply could flip a placement's status and refire the
-- confirmation SMS more than once.

CREATE TABLE IF NOT EXISTS inbound_sms_events (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider             VARCHAR(20) NOT NULL,
  -- Twilio's MessageSid / Africa's Talking's `id`. Nullable because AT
  -- callback configs don't always include one — smsInbound.service.js
  -- falls back to a deterministic hash of (provider, from, text, time
  -- bucket) in that case so retries within the same short window still
  -- dedupe.
  provider_message_id  VARCHAR(255) NOT NULL,
  from_phone           VARCHAR(30) NOT NULL,
  body                 TEXT,
  seeker_id            UUID REFERENCES seekers(id) ON DELETE SET NULL,
  placement_id         UUID REFERENCES placements(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_sms_events_dedupe
  ON inbound_sms_events (provider, provider_message_id);

-- Occasionally useful for support/debugging ("what has this number sent us").
CREATE INDEX IF NOT EXISTS idx_inbound_sms_events_from_phone
  ON inbound_sms_events (from_phone);

-- ── placements.updated_at ───────────────────────────────────────────
-- Defensive add, matching the pattern used for `employers`/`jobs` in
-- earlier migrations. Set explicitly by the webhook handler's UPDATE
-- (no trigger) — same manual-set convention as employer.service.js.

ALTER TABLE placements
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
